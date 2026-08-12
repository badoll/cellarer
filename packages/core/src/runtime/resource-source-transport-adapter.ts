import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import * as os from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import * as nodeProcess from "node:process";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import type {
  FileTreeSnapshotNode,
  FsLike,
  RemoteResourceSourceEvidence,
  ResourceSourceTransport,
  ResourceUrlValidators,
} from "../env.js";

const execFileAsync = promisify(execFile);
const RESOURCE_MIB = 1024 * 1024;

export interface ResourceSourceLimits {
  readonly maxDownloadBytes: number;
  readonly maxExpandedBytes: number;
  readonly maxSingleFileBytes: number;
  readonly maxTotalFileBytes: number;
  readonly maxArchiveNodes: number;
  readonly maxPathBytes: number;
  readonly maxPathDepth: number;
}

export interface ResourceSourceTransportOptions {
  readonly resourceSourceExec?: (command: string, args: readonly string[]) => Promise<string>;
  readonly resourceSourceFetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly resourceSourceLimits?: Partial<ResourceSourceLimits>;
}

const DEFAULT_RESOURCE_SOURCE_LIMITS: ResourceSourceLimits = Object.freeze({
  maxDownloadBytes: 224 * RESOURCE_MIB,
  maxExpandedBytes: 224 * RESOURCE_MIB,
  maxSingleFileBytes: 200 * RESOURCE_MIB,
  maxTotalFileBytes: 224 * RESOURCE_MIB,
  maxArchiveNodes: 100_000,
  maxPathBytes: 32 * 1024,
  maxPathDepth: 256,
});

function sourceTransportError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function sourceFingerprint(nodes: readonly FileTreeSnapshotNode[]): string {
  const sorted = [...nodes].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const root = sorted.find((node) => node.relativePath === "");
  if (!root) throw sourceTransportError("SOURCE_PAYLOAD_INVALID", "source payload has no root");
  if (root.kind === "file") {
    return `sha256:${createHash("sha256")
      .update(root.data ?? new Uint8Array())
      .digest("hex")}`;
  }
  const manifest = sorted.map((node) =>
    node.kind === "directory"
      ? { path: node.relativePath, kind: node.kind, mode: node.mode }
      : {
          path: node.relativePath,
          kind: node.kind,
          mode: node.mode,
          digest: `sha256:${createHash("sha256")
            .update(node.data ?? new Uint8Array())
            .digest("hex")}`,
        },
  );
  return `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`;
}

function safeSourceRelativePath(path: string): string {
  const normalized = path.replace(/^\.\//, "").replace(/\/$/, "");
  if (
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw sourceTransportError("SOURCE_PAYLOAD_INVALID", "source payload path is unsafe");
  }
  return normalized;
}

async function gunzipBounded(payload: Uint8Array, limit: number): Promise<Uint8Array> {
  const output = Readable.from([payload]).pipe(createGunzip());
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const rawChunk of output) {
      const chunk = new Uint8Array(rawChunk as Uint8Array);
      total += chunk.byteLength;
      if (total > limit) {
        output.destroy();
        throw sourceTransportError(
          "SOURCE_PAYLOAD_TOO_LARGE",
          "URL source expanded payload is too large",
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if ((error as { code?: unknown }).code === "SOURCE_PAYLOAD_TOO_LARGE") throw error;
    throw sourceTransportError("SOURCE_PAYLOAD_INVALID", "source archive gzip is invalid");
  }
  return concatBytes(chunks, total);
}

async function parseTarPayload(
  payload: Uint8Array,
  limits: ResourceSourceLimits,
): Promise<FileTreeSnapshotNode[]> {
  const bytes =
    payload[0] === 0x1f && payload[1] === 0x8b
      ? await gunzipBounded(payload, limits.maxExpandedBytes)
      : payload;
  if (bytes.byteLength > limits.maxExpandedBytes) {
    throw sourceTransportError(
      "SOURCE_PAYLOAD_TOO_LARGE",
      "URL source expanded payload is too large",
    );
  }
  const decoder = new TextDecoder();
  const entries: Array<{
    path: string;
    kind: "file" | "directory";
    mode: number;
    data?: Uint8Array;
  }> = [];
  const seenPaths = new Set<string>();
  let totalFileBytes = 0;
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number) =>
      decoder.decode(header.subarray(start, start + length)).replace(/\0.*$/s, "");
    const name = text(0, 100);
    const prefix = text(345, 155);
    const path = safeSourceRelativePath(prefix ? `${prefix}/${name}` : name);
    const pathBytes = new TextEncoder().encode(path).byteLength;
    const pathDepth = path.split("/").length;
    if (pathBytes > limits.maxPathBytes || pathDepth > limits.maxPathDepth) {
      throw sourceTransportError("SOURCE_PAYLOAD_TOO_LARGE", "source archive path is too large");
    }
    if (seenPaths.has(path)) {
      throw sourceTransportError("SOURCE_PAYLOAD_INVALID", "source archive has duplicate paths");
    }
    seenPaths.add(path);
    const mode = Number.parseInt(text(100, 8).trim() || "0", 8) & 0o7777;
    const size = Number.parseInt(text(124, 12).trim() || "0", 8);
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156] ?? 0);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length) {
      throw sourceTransportError("SOURCE_PAYLOAD_INVALID", "source archive is invalid");
    }
    if (type !== "0" && type !== "5") {
      throw sourceTransportError("SOURCE_PAYLOAD_INVALID", "source archive has unsafe entries");
    }
    if (type === "5" && size !== 0) {
      throw sourceTransportError("SOURCE_PAYLOAD_INVALID", "source archive directory has data");
    }
    if (entries.length + 1 > limits.maxArchiveNodes || size > limits.maxSingleFileBytes) {
      throw sourceTransportError("SOURCE_PAYLOAD_TOO_LARGE", "source archive exceeds its limits");
    }
    if (type === "0") {
      totalFileBytes += size;
      if (totalFileBytes > limits.maxTotalFileBytes) {
        throw sourceTransportError("SOURCE_PAYLOAD_TOO_LARGE", "source archive is too large");
      }
    }
    entries.push({
      path,
      kind: type === "5" ? "directory" : "file",
      mode: mode || (type === "5" ? 0o755 : 0o644),
      ...(type === "0" ? { data: bytes.slice(offset + 512, offset + 512 + size) } : {}),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (entries.length === 0) {
    throw sourceTransportError("SOURCE_PAYLOAD_INVALID", "source archive is empty");
  }
  const firstSegments = new Set(entries.map((entry) => entry.path.split("/", 1)[0]));
  const commonRoot = firstSegments.size === 1 ? [...firstSegments][0] : undefined;
  const stripped = entries.flatMap((entry) => {
    const path = commonRoot
      ? entry.path === commonRoot
        ? ""
        : entry.path.slice(commonRoot.length + 1)
      : entry.path;
    if (!path) return [];
    return [{ ...entry, path }];
  });
  const directories = new Set<string>([""]);
  const fileCount = stripped.filter((entry) => entry.kind === "file").length;
  for (const entry of stripped) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
    if (entry.kind === "directory") directories.add(entry.path);
    if (directories.size + fileCount > limits.maxArchiveNodes) {
      throw sourceTransportError("SOURCE_PAYLOAD_TOO_LARGE", "source archive has too many nodes");
    }
  }
  return [
    ...[...directories].sort().map((relativePath) => ({
      relativePath,
      kind: "directory" as const,
      mode: 0o755,
      identity: `url-directory:${relativePath}`,
    })),
    ...stripped
      .filter((entry) => entry.kind === "file")
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => ({
        relativePath: entry.path,
        kind: "file" as const,
        mode: entry.mode,
        identity: `url-file:${entry.path}`,
        data: entry.data,
      })),
  ];
}

async function urlPayloadNodes(
  url: string,
  payload: Uint8Array,
  limits: ResourceSourceLimits,
): Promise<FileTreeSnapshotNode[]> {
  const pathname = new URL(url).pathname.toLowerCase();
  if (
    pathname.endsWith(".tar") ||
    pathname.endsWith(".tar.gz") ||
    pathname.endsWith(".tgz") ||
    (payload[0] === 0x1f && payload[1] === 0x8b)
  ) {
    return parseTarPayload(payload, limits);
  }
  return [
    {
      relativePath: "",
      kind: "file",
      mode: 0o644,
      identity: "url-file:root",
      data: payload,
    },
  ];
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function responseValidators(headers: Headers): ResourceUrlValidators | undefined {
  const etag = headers.get("etag") ?? undefined;
  const lastModified = headers.get("last-modified") ?? undefined;
  if (
    etag?.includes("\n") ||
    etag?.includes("\r") ||
    lastModified?.includes("\n") ||
    lastModified?.includes("\r")
  ) {
    throw sourceTransportError("SOURCE_VALIDATOR_INVALID", "source validators are invalid");
  }
  return etag || lastModified
    ? { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) }
    : undefined;
}

function sameValidators(
  left: ResourceUrlValidators | undefined,
  right: ResourceUrlValidators | undefined,
): boolean {
  return left?.etag === right?.etag && left?.lastModified === right?.lastModified;
}

function resourceSourceLimits(
  overrides: Partial<ResourceSourceLimits> | undefined,
): ResourceSourceLimits {
  const limits = { ...DEFAULT_RESOURCE_SOURCE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`resource source limit ${name} must be a positive safe integer`);
    }
  }
  return limits;
}

async function readResponseBodyBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw sourceTransportError("SOURCE_PAYLOAD_TOO_LARGE", "URL source payload is too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if ((error as { code?: unknown }).code === "SOURCE_PAYLOAD_TOO_LARGE") throw error;
    throw sourceTransportError("SOURCE_URL_FAILED", "URL source transport failed");
  } finally {
    reader.releaseLock();
  }
  return concatBytes(chunks, total);
}

export function createRealResourceSourceTransport(
  fs: FsLike,
  options: ResourceSourceTransportOptions,
): ResourceSourceTransport {
  const limits = resourceSourceLimits(options.resourceSourceLimits);
  const runGit = async (args: string[]): Promise<string> => {
    try {
      if (options.resourceSourceExec) return await options.resourceSourceExec("git", args);
      const result = await execFileAsync("git", args, {
        encoding: "utf8",
        env: { PATH: nodeProcess.env.PATH },
        maxBuffer: 1024 * 1024,
        timeout: 60_000,
      });
      return result.stdout;
    } catch {
      throw sourceTransportError("SOURCE_GIT_FAILED", "Git source transport failed");
    }
  };
  const fetchUrl = async (
    source: Extract<RemoteResourceSourceEvidence, { readonly type: "url" }>,
    conditional: boolean,
  ): Promise<{ nodes: FileTreeSnapshotNode[]; validators?: ResourceUrlValidators }> => {
    const headers = new Headers();
    if (conditional && source.validators?.etag) headers.set("if-match", source.validators.etag);
    if (conditional && source.validators?.lastModified) {
      headers.set("if-unmodified-since", source.validators.lastModified);
    }
    let response: Response;
    try {
      const init = { headers, redirect: "error" as const };
      response = options.resourceSourceFetch
        ? await options.resourceSourceFetch(source.url, init)
        : await fetch(source.url, init);
    } catch {
      throw sourceTransportError("SOURCE_URL_FAILED", "URL source transport failed");
    }
    if (conditional && response.status === 412) {
      throw sourceTransportError(
        "SOURCE_EVIDENCE_CHANGED",
        "URL source evidence changed during staging",
      );
    }
    if (!response.ok || response.redirected) {
      throw sourceTransportError("SOURCE_URL_FAILED", "URL source transport failed");
    }
    const contentLength = response.headers.get("content-length");
    const declaredLength = contentLength === null ? 0 : Number(contentLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > limits.maxDownloadBytes
    ) {
      throw sourceTransportError("SOURCE_PAYLOAD_TOO_LARGE", "URL source payload is too large");
    }
    const payload = await readResponseBodyBounded(response, limits.maxDownloadBytes);
    return {
      nodes: await urlPayloadNodes(source.url, payload, limits),
      validators: responseValidators(response.headers),
    };
  };
  return {
    async check(source) {
      if (source.type === "git") {
        const output = await runGit(["ls-remote", "--exit-code", source.repositoryUrl, source.ref]);
        const commits = [
          ...new Set(
            output
              .split("\n")
              .map((line) => line.trim().split(/\s+/, 1)[0] ?? "")
              .filter((commit) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)),
          ),
        ];
        if (commits.length !== 1 || !commits[0]) {
          throw sourceTransportError("SOURCE_GIT_REF_INVALID", "Git source ref is ambiguous");
        }
        return { ...source, commit: commits[0].toLowerCase() };
      }
      const fetched = await fetchUrl(source, false);
      return {
        ...source,
        integrity: sourceFingerprint(fetched.nodes),
        ...(fetched.validators ? { validators: fetched.validators } : {}),
      };
    },
    async fetch(source) {
      if (source.type === "url") {
        const fetched = await fetchUrl(source, true);
        if (
          !sameValidators(source.validators, fetched.validators) ||
          sourceFingerprint(fetched.nodes) !== source.integrity
        ) {
          throw sourceTransportError(
            "SOURCE_EVIDENCE_CHANGED",
            "URL source evidence changed during staging",
          );
        }
        return { evidence: source, nodes: fetched.nodes };
      }
      const checkout = await nodeFs.mkdtemp(join(os.tmpdir(), "cellarer-resource-git-"));
      try {
        await runGit(["init", checkout]);
        await runGit(["-C", checkout, "remote", "add", "origin", source.repositoryUrl]);
        await runGit(["-C", checkout, "fetch", "--depth", "1", "origin", source.ref]);
        await runGit(["-C", checkout, "checkout", "--detach", "FETCH_HEAD"]);
        const commit = (await runGit(["-C", checkout, "rev-parse", "HEAD"])).trim().toLowerCase();
        if (commit !== source.commit.toLowerCase()) {
          throw sourceTransportError(
            "SOURCE_EVIDENCE_CHANGED",
            "Git source ref moved during staging",
          );
        }
        const subpath = safeSourceRelativePath(source.subpath);
        const target = resolve(checkout, ...subpath.split("/"));
        const relativeTarget = relative(checkout, target);
        if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
          throw sourceTransportError("SOURCE_PAYLOAD_INVALID", "Git source subpath is unsafe");
        }
        const snapshot = await fs.snapshotTreeNoFollow(target);
        return {
          evidence: { ...source, commit },
          nodes: snapshot.nodes,
          cleanup: () => nodeFs.rm(checkout, { recursive: true, force: true }),
        };
      } catch (error) {
        await nodeFs.rm(checkout, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}
