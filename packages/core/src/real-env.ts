// createRealEnv:Env 的真实实现 —— 全 core 内唯一允许 import node:fs/os/process 的地方。
// 其余 core 模块只依赖 env.ts 的接口类型,保证可测性与跨平台。

import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  promises as nodeFs,
  openSync,
  readFileSync,
} from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import * as os from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import * as nodeProcess from "node:process";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import type {
  Env,
  FileStat,
  FileTreeSnapshot,
  FileTreeSnapshotNode,
  FsLike,
  HeadlessLifetimeLease,
  HeadlessLifetimeOwner,
  Platform,
  ProcessLiveness,
  RemoteResourceSourceEvidence,
  ResourceSourceTransport,
  ResourceUrlValidators,
  SymlinkType,
} from "./env.js";

const execFileAsync = promisify(execFile);

const HEADLESS_OWNER_SOCKET_PROBE_TIMEOUT_MS = 1_000;

interface UnixSocketIdentity {
  readonly device: number;
  readonly inode: number;
}

interface HeadlessKernelOwnerRecord {
  readonly server: Server;
  readonly endpoint: string;
  readonly unixSocketIdentity?: UnixSocketIdentity;
  readonly lease: HeadlessLifetimeLease;
}

const headlessKernelOwners = new Map<string, HeadlessKernelOwnerRecord>();
const pendingHeadlessKernelOwners = new Map<string, Promise<HeadlessLifetimeLease>>();

export function headlessLifetimeOwnerEndpoint(normalizedStoreRoot: string): string {
  const digest = createHash("sha256")
    .update("cellarer-headless-lifetime-owner-v2\0")
    .update(normalizedStoreRoot)
    .digest("hex");
  if (nodeProcess.platform === "win32") {
    return `\\\\.\\pipe\\cellarer-headless-owner-v2-${digest}`;
  }
  return join("/tmp", `.cellarer-ho-${headlessOwnerUserId()}`, digest);
}

function headlessOwnerUnavailable(): Error {
  return new Error("headless lifetime owner kernel resource is active or unavailable");
}

function headlessOwnerUserId(): number {
  const getuid = nodeProcess.getuid;
  if (!getuid) throw headlessOwnerUnavailable();
  return getuid();
}

async function ensureHeadlessSocketDirectory(endpoint: string): Promise<void> {
  const directory = dirname(endpoint);
  try {
    await nodeFs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw headlessOwnerUnavailable();
  }
  try {
    const stat = await nodeFs.lstat(directory);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.uid !== headlessOwnerUserId() ||
      (stat.mode & 0o077) !== 0
    ) {
      throw headlessOwnerUnavailable();
    }
  } catch {
    throw headlessOwnerUnavailable();
  }
}

async function readUnixSocketIdentity(endpoint: string): Promise<UnixSocketIdentity | undefined> {
  let stat: Awaited<ReturnType<typeof nodeFs.lstat>>;
  try {
    stat = await nodeFs.lstat(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw headlessOwnerUnavailable();
  }
  if (stat.isSymbolicLink() || !stat.isSocket()) throw headlessOwnerUnavailable();
  return { device: stat.dev, inode: stat.ino };
}

function sameUnixSocketIdentity(left: UnixSocketIdentity, right: UnixSocketIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function probeUnixSocket(endpoint: string): Promise<"active" | "stale"> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: endpoint });
    let settled = false;
    const finish = (result: "active" | "stale" | Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    socket.once("connect", () => finish("active"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish("stale");
      else finish(error);
    });
    socket.setTimeout(HEADLESS_OWNER_SOCKET_PROBE_TIMEOUT_MS, () =>
      finish(headlessOwnerUnavailable()),
    );
  });
}

async function prepareUnixSocketEndpoint(endpoint: string): Promise<void> {
  await ensureHeadlessSocketDirectory(endpoint);
  const previous = await readUnixSocketIdentity(endpoint);
  if (!previous) return;
  if ((await probeUnixSocket(endpoint)) === "active") throw headlessOwnerUnavailable();
  const confirmed = await readUnixSocketIdentity(endpoint);
  if (!confirmed || !sameUnixSocketIdentity(previous, confirmed)) {
    throw headlessOwnerUnavailable();
  }
  try {
    await nodeFs.unlink(endpoint);
  } catch {
    throw headlessOwnerUnavailable();
  }
}

async function listenHeadlessKernelOwner(server: Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ path: endpoint, exclusive: true, readableAll: false, writableAll: false });
  });
}

async function bindHeadlessKernelOwner(
  normalizedStoreRoot: string,
): Promise<HeadlessLifetimeLease> {
  const endpoint = headlessLifetimeOwnerEndpoint(normalizedStoreRoot);
  const server = createServer((socket) => socket.destroy());
  try {
    if (nodeProcess.platform !== "win32") await prepareUnixSocketEndpoint(endpoint);
    await listenHeadlessKernelOwner(server, endpoint);
  } catch {
    if (server.listening) server.close();
    throw headlessOwnerUnavailable();
  }

  server.unref();
  let healthy = true;
  let record: HeadlessKernelOwnerRecord;
  const lease = Object.freeze({
    isCurrent: async () => {
      if (
        !healthy ||
        !server.listening ||
        headlessKernelOwners.get(normalizedStoreRoot) !== record
      ) {
        return false;
      }
      if (!record.unixSocketIdentity) return true;
      try {
        const current = await readUnixSocketIdentity(record.endpoint);
        return Boolean(current && sameUnixSocketIdentity(record.unixSocketIdentity, current));
      } catch {
        return false;
      }
    },
  });
  let unixSocketIdentity: UnixSocketIdentity | undefined;
  if (nodeProcess.platform !== "win32") {
    try {
      unixSocketIdentity = await readUnixSocketIdentity(endpoint);
    } catch {
      server.close();
      throw headlessOwnerUnavailable();
    }
    if (!unixSocketIdentity) {
      server.close();
      throw headlessOwnerUnavailable();
    }
  }
  record = Object.freeze({
    server,
    endpoint,
    ...(unixSocketIdentity ? { unixSocketIdentity } : {}),
    lease,
  });
  headlessKernelOwners.set(normalizedStoreRoot, record);
  server.on("error", () => {
    healthy = false;
    if (headlessKernelOwners.get(normalizedStoreRoot) === record) {
      headlessKernelOwners.delete(normalizedStoreRoot);
    }
    if (server.listening) server.close();
  });
  server.once("close", () => {
    healthy = false;
    if (headlessKernelOwners.get(normalizedStoreRoot) === record) {
      headlessKernelOwners.delete(normalizedStoreRoot);
    }
  });
  return lease;
}

const headlessLifetimeOwner: HeadlessLifetimeOwner = Object.freeze({
  acquire: async (normalizedStoreRoot: string): Promise<HeadlessLifetimeLease> => {
    const current = headlessKernelOwners.get(normalizedStoreRoot);
    if (current && (await current.lease.isCurrent())) return current.lease;
    if (current) headlessKernelOwners.delete(normalizedStoreRoot);

    const pending = pendingHeadlessKernelOwners.get(normalizedStoreRoot);
    if (pending) return pending;
    const acquisition = bindHeadlessKernelOwner(normalizedStoreRoot);
    pendingHeadlessKernelOwners.set(normalizedStoreRoot, acquisition);
    try {
      return await acquisition;
    } finally {
      if (pendingHeadlessKernelOwners.get(normalizedStoreRoot) === acquisition) {
        pendingHeadlessKernelOwners.delete(normalizedStoreRoot);
      }
    }
  },
});

function publicationTempPath(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.${nodeProcess.pid}.${randomUUID()}.cellarer-publish`,
  );
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof nodeFs.open>> | undefined;
  try {
    handle = await nodeFs.open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows does not consistently permit opening directories for FlushFileBuffers.
    if (nodeProcess.platform !== "win32" || (code !== "EPERM" && code !== "EISDIR")) throw error;
  } finally {
    await handle?.close();
  }
}

async function writeDurableTemp(path: string, data: string, mode?: number): Promise<void> {
  const handle = await nodeFs.open(path, "wx", mode);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function snapshotFailure(
  code:
    | "CELLARER_SNAPSHOT_SYMLINK"
    | "CELLARER_SNAPSHOT_NON_REGULAR"
    | "CELLARER_SNAPSHOT_STALE"
    | "CELLARER_SNAPSHOT_UNSUPPORTED"
    | "CELLARER_SNAPSHOT_TIMEOUT"
    | "CELLARER_SNAPSHOT_BUDGET_EXCEEDED",
  path: string,
): Error & { code: string; path: string } {
  return Object.assign(new Error(`safe source snapshot failed at ${path}`), { code, path });
}

function statIdentity(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
  ].join(":");
}

function sameNode(left: BigIntStats, right: BigIntStats): boolean {
  return statIdentity(left) === statIdentity(right);
}

export interface SnapshotRuntimeSupport {
  readonly platform: "darwin" | "linux" | "win32";
  readonly arch: "x64" | "arm64";
}

const SNAPSHOT_MIB = 1024 * 1024;

export const SNAPSHOT_WORKER_BUDGET = Object.freeze({
  // A 192 MiB source expands to just over the former 256 MiB IPC ceiling after JSON framing.
  // 224 MiB total raw data expands to ~299 MiB; 352 MiB leaves bounded room for the separately
  // capped 16 MiB path manifest and 100k identity/mode records.
  timeoutMs: 60_000,
  maxInputBytes: 64 * 1024,
  maxOutputBytes: 352 * SNAPSHOT_MIB,
  maxNodes: 100_000,
  maxSingleFileBytes: 200 * SNAPSHOT_MIB,
  maxTotalFileBytes: 224 * SNAPSHOT_MIB,
  maxRelativePathBytes: 32 * 1024,
  maxTotalPathBytes: 16 * SNAPSHOT_MIB,
});

export interface SnapshotWorkerRequest {
  readonly source: string;
  readonly cwd: string;
  readonly input: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export type SnapshotWorkerRunner = (request: SnapshotWorkerRequest) => string;

export interface RealEnvOptions {
  readonly snapshotWorkerRunner?: SnapshotWorkerRunner;
  readonly resourceSourceExec?: (command: string, args: readonly string[]) => Promise<string>;
  readonly resourceSourceFetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly resourceSourceLimits?: Partial<ResourceSourceLimits>;
}

export interface ResourceSourceLimits {
  readonly maxDownloadBytes: number;
  readonly maxExpandedBytes: number;
  readonly maxSingleFileBytes: number;
  readonly maxTotalFileBytes: number;
  readonly maxArchiveNodes: number;
  readonly maxPathBytes: number;
  readonly maxPathDepth: number;
}

const DEFAULT_RESOURCE_SOURCE_LIMITS: ResourceSourceLimits = Object.freeze({
  maxDownloadBytes: 224 * SNAPSHOT_MIB,
  maxExpandedBytes: 224 * SNAPSHOT_MIB,
  maxSingleFileBytes: SNAPSHOT_WORKER_BUDGET.maxSingleFileBytes,
  maxTotalFileBytes: SNAPSHOT_WORKER_BUDGET.maxTotalFileBytes,
  maxArchiveNodes: SNAPSHOT_WORKER_BUDGET.maxNodes,
  maxPathBytes: SNAPSHOT_WORKER_BUDGET.maxRelativePathBytes,
  maxPathDepth: 256,
});

const defaultSnapshotWorkerRunner: SnapshotWorkerRunner = (request) =>
  execFileSync(nodeProcess.execPath, ["--input-type=module", "--eval", request.source], {
    cwd: request.cwd,
    input: request.input,
    encoding: "utf8",
    env: {},
    maxBuffer: request.maxOutputBytes,
    timeout: request.timeoutMs,
    killSignal: "SIGKILL",
    stdio: ["pipe", "pipe", "pipe"],
  });

export function classifyWindowsSnapshotIdentity(input: {
  readonly symbolic: boolean;
  readonly linkedIdentity: string;
  readonly expectedIdentity: string;
  readonly lexicalPath: string;
  readonly realPath: string;
}): "CELLARER_SNAPSHOT_SYMLINK" | "CELLARER_SNAPSHOT_STALE" | null {
  if (input.symbolic || input.realPath !== input.lexicalPath) {
    return "CELLARER_SNAPSHOT_SYMLINK";
  }
  return input.linkedIdentity === input.expectedIdentity ? null : "CELLARER_SNAPSHOT_STALE";
}

export function snapshotRuntimeSupport(
  platform: string,
  arch: string,
  path = "<snapshot>",
): SnapshotRuntimeSupport {
  if (
    (platform !== "darwin" && platform !== "linux" && platform !== "win32") ||
    (arch !== "x64" && arch !== "arm64")
  ) {
    throw snapshotFailure("CELLARER_SNAPSHOT_UNSUPPORTED", path);
  }
  return Object.freeze({ platform, arch });
}

function requiredSnapshotOpenFlags(path: string): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number" || typeof fsConstants.O_NONBLOCK !== "number") {
    throw snapshotFailure("CELLARER_SNAPSHOT_UNSUPPORTED", path);
  }
  // Node does not expose O_CLOEXEC on every supported POSIX build. These values are stable ABI
  // constants on Darwin and Linux; unknown platforms fail closed instead of guessing.
  const closeOnExecConstant = (fsConstants as typeof fsConstants & { O_CLOEXEC?: number })
    .O_CLOEXEC;
  const closeOnExec =
    typeof closeOnExecConstant === "number"
      ? closeOnExecConstant
      : nodeProcess.platform === "darwin"
        ? 0x01000000
        : nodeProcess.platform === "linux"
          ? 0x00080000
          : undefined;
  if (closeOnExec === undefined) throw snapshotFailure("CELLARER_SNAPSHOT_UNSUPPORTED", path);
  return fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | closeOnExec | fsConstants.O_NONBLOCK;
}

interface SnapshotWorkerNode {
  readonly relativePath: string;
  readonly kind: "file" | "directory";
  readonly mode: number;
  readonly identity: string;
  readonly data?: string;
}

interface SnapshotWorkerResult {
  readonly ok: boolean;
  readonly nodes?: readonly SnapshotWorkerNode[];
  readonly code?: string;
  readonly path?: string;
}

async function snapshotWorkerMain(): Promise<void> {
  const getBuiltinModule = (
    process as typeof process & {
      getBuiltinModule?: (name: string) => unknown;
    }
  ).getBuiltinModule;
  if (!getBuiltinModule) throw new Error("snapshot runtime is unsupported");
  const { Buffer } = getBuiltinModule("node:buffer") as typeof import("node:buffer");
  const { constants, closeSync, fstatSync, openSync, readFileSync, readdirSync, statSync } =
    getBuiltinModule("node:fs") as typeof import("node:fs");
  const input = JSON.parse(readFileSync(0, "utf8")) as {
    expectedRoot: string;
    includeData: boolean;
    budget: {
      maxNodes: number;
      maxSingleFileBytes: number;
      maxTotalFileBytes: number;
      maxRelativePathBytes: number;
      maxTotalPathBytes: number;
    };
  };
  const nodes: SnapshotWorkerNode[] = [];
  const identity = (stat: BigIntStats): string =>
    [
      stat.dev,
      stat.ino,
      stat.mode,
      stat.nlink,
      stat.uid,
      stat.gid,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
      stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
    ].join(":");
  const fail = (code: string, path: string): never => {
    throw Object.assign(new Error("snapshot failed"), { code, path });
  };
  const budget = input.budget;
  if (
    !budget ||
    ![
      budget.maxNodes,
      budget.maxSingleFileBytes,
      budget.maxTotalFileBytes,
      budget.maxRelativePathBytes,
      budget.maxTotalPathBytes,
    ].every((value) => Number.isSafeInteger(value) && value > 0)
  ) {
    fail("CELLARER_SNAPSHOT_BUDGET_EXCEEDED", "");
  }
  let nodeCount = 0;
  let totalFileBytes = 0n;
  let totalPathBytes = 0;
  const reserveNode = (path: string, fileBytes = 0n): void => {
    nodeCount += 1;
    const pathBytes = Buffer.byteLength(path, "utf8");
    totalPathBytes += pathBytes;
    if (
      nodeCount > budget.maxNodes ||
      pathBytes > budget.maxRelativePathBytes ||
      totalPathBytes > budget.maxTotalPathBytes ||
      fileBytes < 0n ||
      fileBytes > BigInt(budget.maxSingleFileBytes) ||
      totalFileBytes + fileBytes > BigInt(budget.maxTotalFileBytes)
    ) {
      fail("CELLARER_SNAPSHOT_BUDGET_EXCEEDED", path);
    }
    totalFileBytes += fileBytes;
  };
  const flags = (() => {
    if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
      return fail("CELLARER_SNAPSHOT_UNSUPPORTED", "");
    }
    const exposed = (constants as typeof constants & { O_CLOEXEC?: number }).O_CLOEXEC;
    const closeOnExec =
      typeof exposed === "number"
        ? exposed
        : process.platform === "darwin"
          ? 0x01000000
          : process.platform === "linux"
            ? 0x00080000
            : undefined;
    if (closeOnExec === undefined) return fail("CELLARER_SNAPSHOT_UNSUPPORTED", "");
    return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec;
  })();

  const visitDirectory = (relativePath: string, expectedIdentity: string): void => {
    reserveNode(relativePath);
    const before = statSync(".", { bigint: true });
    if (!before.isDirectory() || identity(before) !== expectedIdentity) {
      fail("CELLARER_SNAPSHOT_STALE", relativePath);
    }
    for (const name of readdirSync(".").sort((left, right) => left.localeCompare(right))) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
        fail("CELLARER_SNAPSHOT_STALE", relativePath);
      }
      const childPath = relativePath ? `${relativePath}/${name}` : name;
      const fd = (() => {
        try {
          return openSync(name, flags);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          return fail(
            code === "ELOOP" ? "CELLARER_SNAPSHOT_SYMLINK" : "CELLARER_SNAPSHOT_STALE",
            childPath,
          );
        }
      })();
      try {
        const opened = fstatSync(fd, { bigint: true });
        const openedIdentity = identity(opened);
        if (opened.isFile()) {
          reserveNode(childPath, opened.size);
          const data = input.includeData ? readFileSync(fd).toString("base64") : undefined;
          const after = fstatSync(fd, { bigint: true });
          if (identity(after) !== openedIdentity) fail("CELLARER_SNAPSHOT_STALE", childPath);
          nodes.push({
            relativePath: childPath,
            kind: "file",
            mode: Number(after.mode & 0o7777n),
            identity: identity(after),
            ...(data === undefined ? {} : { data }),
          });
        } else if (opened.isDirectory()) {
          process.chdir(name);
          if (identity(statSync(".", { bigint: true })) !== openedIdentity) {
            fail("CELLARER_SNAPSHOT_STALE", childPath);
          }
          visitDirectory(childPath, openedIdentity);
          process.chdir("..");
          if (identity(statSync(".", { bigint: true })) !== identity(before)) {
            fail("CELLARER_SNAPSHOT_STALE", relativePath);
          }
          if (identity(fstatSync(fd, { bigint: true })) !== openedIdentity) {
            fail("CELLARER_SNAPSHOT_STALE", childPath);
          }
        } else {
          fail("CELLARER_SNAPSHOT_NON_REGULAR", childPath);
        }
      } finally {
        closeSync(fd);
      }
    }
    const after = statSync(".", { bigint: true });
    if (identity(after) !== identity(before)) fail("CELLARER_SNAPSHOT_STALE", relativePath);
    nodes.push({
      relativePath,
      kind: "directory",
      mode: Number(after.mode & 0o7777n),
      identity: identity(after),
    });
  };

  try {
    visitDirectory("", input.expectedRoot);
    process.stdout.write(JSON.stringify({ ok: true, nodes }));
  } catch (error) {
    const detail = error as { code?: unknown; path?: unknown };
    process.stdout.write(
      JSON.stringify({
        ok: false,
        code: typeof detail.code === "string" ? detail.code : "CELLARER_SNAPSHOT_STALE",
        path: typeof detail.path === "string" ? detail.path : "",
      }),
    );
  }
}

const SNAPSHOT_WORKER_SOURCE = `(${snapshotWorkerMain.toString()})()`;

interface AnchoredSnapshotWorkerResult extends SnapshotWorkerResult {
  readonly exists?: boolean;
}

async function anchoredSnapshotWorkerMain(): Promise<void> {
  const getBuiltinModule = (
    process as typeof process & { getBuiltinModule?: (name: string) => unknown }
  ).getBuiltinModule;
  if (!getBuiltinModule) throw new Error("snapshot runtime is unsupported");
  const { Buffer } = getBuiltinModule("node:buffer") as typeof import("node:buffer");
  const {
    constants,
    closeSync,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
    statSync,
  } = getBuiltinModule("node:fs") as typeof import("node:fs");
  const pathModule = getBuiltinModule("node:path") as typeof import("node:path");
  const input = JSON.parse(readFileSync(0, "utf8")) as {
    anchorSegments: string[];
    targetSegments: string[];
    includeData: boolean;
    expectedRootPath: string;
    budget: {
      maxNodes: number;
      maxSingleFileBytes: number;
      maxTotalFileBytes: number;
      maxRelativePathBytes: number;
      maxTotalPathBytes: number;
    };
  };
  const nodes: SnapshotWorkerNode[] = [];
  const directories: Array<{
    fd?: number;
    identity: string;
    path: string;
    expectedAbsolute?: string;
  }> = [];
  const identity = (stat: BigIntStats): string =>
    [
      stat.dev,
      stat.ino,
      stat.mode,
      stat.nlink,
      stat.uid,
      stat.gid,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
      stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
    ].join(":");
  // An anchor's parent may gain unrelated siblings while this worker runs. Its stable identity
  // proves inode/owner/mode continuity without treating ordinary directory-content churn as ABA.
  const anchorIdentity = (stat: BigIntStats): string =>
    [
      stat.dev,
      stat.ino,
      stat.mode,
      stat.uid,
      stat.gid,
      stat.isDirectory() ? "directory" : "other",
    ].join(":");
  const fail = (code: string, path: string): never => {
    throw Object.assign(new Error("snapshot failed"), { code, path });
  };
  const budget = input.budget;
  if (
    !budget ||
    ![
      budget.maxNodes,
      budget.maxSingleFileBytes,
      budget.maxTotalFileBytes,
      budget.maxRelativePathBytes,
      budget.maxTotalPathBytes,
    ].every((value) => Number.isSafeInteger(value) && value > 0)
  ) {
    fail("CELLARER_SNAPSHOT_BUDGET_EXCEEDED", "");
  }
  let nodeCount = 0;
  let totalFileBytes = 0n;
  let totalPathBytes = 0;
  const reserveNode = (path: string, fileBytes = 0n): void => {
    nodeCount += 1;
    const pathBytes = Buffer.byteLength(path, "utf8");
    totalPathBytes += pathBytes;
    if (
      nodeCount > budget.maxNodes ||
      pathBytes > budget.maxRelativePathBytes ||
      totalPathBytes > budget.maxTotalPathBytes ||
      fileBytes < 0n ||
      fileBytes > BigInt(budget.maxSingleFileBytes) ||
      totalFileBytes + fileBytes > BigInt(budget.maxTotalFileBytes)
    ) {
      fail("CELLARER_SNAPSHOT_BUDGET_EXCEEDED", path);
    }
    totalFileBytes += fileBytes;
  };
  const flags = (() => {
    if (process.platform === "win32") return constants.O_RDONLY;
    if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
      return fail("CELLARER_SNAPSHOT_UNSUPPORTED", "");
    }
    const exposed = (constants as typeof constants & { O_CLOEXEC?: number }).O_CLOEXEC;
    const closeOnExec =
      typeof exposed === "number"
        ? exposed
        : process.platform === "darwin"
          ? 0x01000000
          : process.platform === "linux"
            ? 0x00080000
            : undefined;
    if (closeOnExec === undefined) return fail("CELLARER_SNAPSHOT_UNSUPPORTED", "");
    return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec;
  })();
  const validSegment = (segment: string): boolean =>
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !segment.includes("\0");
  const windowsPath = (value: string): string => pathModule.resolve(value).toLowerCase();
  const verifyWindowsPath = (
    path: string,
    expectedIdentity: string,
    stableAnchor = false,
  ): void => {
    const linked = (() => {
      try {
        return lstatSync(path, { bigint: true });
      } catch {
        return fail("CELLARER_SNAPSHOT_STALE", path);
      }
    })();
    const classification = classifyWindowsSnapshotIdentity({
      symbolic: linked.isSymbolicLink(),
      linkedIdentity: stableAnchor ? anchorIdentity(linked) : identity(linked),
      expectedIdentity,
      lexicalPath: windowsPath(path),
      realPath: windowsPath(realpathSync.native(path)),
    });
    if (classification) fail(classification, path);
  };
  const verifyDirectories = (): void => {
    for (const directory of directories) {
      if (directory.fd !== undefined) {
        if (anchorIdentity(fstatSync(directory.fd, { bigint: true })) !== directory.identity) {
          fail("CELLARER_SNAPSHOT_STALE", directory.path);
        }
      } else if (directory.expectedAbsolute) {
        verifyWindowsPath(directory.expectedAbsolute, directory.identity, true);
      }
    }
  };
  const enterDirectory = (segment: string, path: string): "entered" | "missing" => {
    if (!validSegment(segment)) fail("CELLARER_SNAPSHOT_STALE", path);
    if (process.platform === "win32") {
      let linked: BigIntStats;
      try {
        linked = lstatSync(segment, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        return fail("CELLARER_SNAPSHOT_STALE", path);
      }
      if (linked.isSymbolicLink()) fail("CELLARER_SNAPSHOT_SYMLINK", path);
      if (!linked.isDirectory()) fail("CELLARER_SNAPSHOT_NON_REGULAR", path);
      const expected = anchorIdentity(linked);
      const expectedAbsolute = pathModule.resolve(segment);
      process.chdir(segment);
      if (anchorIdentity(statSync(".", { bigint: true })) !== expected) {
        fail("CELLARER_SNAPSHOT_STALE", path);
      }
      verifyWindowsPath(expectedAbsolute, expected, true);
      if (windowsPath(realpathSync.native(".")) !== windowsPath(expectedAbsolute)) {
        fail("CELLARER_SNAPSHOT_SYMLINK", path);
      }
      directories.push({ identity: expected, path, expectedAbsolute });
      return "entered";
    }
    let fd: number;
    try {
      fd = openSync(segment, flags);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "missing";
      return fail(code === "ELOOP" ? "CELLARER_SNAPSHOT_SYMLINK" : "CELLARER_SNAPSHOT_STALE", path);
    }
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isDirectory()) {
      closeSync(fd);
      fail("CELLARER_SNAPSHOT_NON_REGULAR", path);
    }
    const expected = anchorIdentity(opened);
    try {
      process.chdir(segment);
      if (anchorIdentity(statSync(".", { bigint: true })) !== expected) {
        fail("CELLARER_SNAPSHOT_STALE", path);
      }
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    directories.push({ fd, identity: expected, path });
    return "entered";
  };
  const visitDirectory = (
    relativePath: string,
    expectedIdentity: string,
    expectedAbsolute = pathModule.resolve("."),
  ): void => {
    reserveNode(relativePath);
    const before = statSync(".", { bigint: true });
    if (
      !before.isDirectory() ||
      identity(before) !== expectedIdentity ||
      (process.platform === "win32" &&
        windowsPath(realpathSync.native(".")) !== windowsPath(expectedAbsolute))
    ) {
      fail("CELLARER_SNAPSHOT_STALE", relativePath);
    }
    for (const name of readdirSync(".").sort((left, right) => left.localeCompare(right))) {
      if (!validSegment(name)) fail("CELLARER_SNAPSHOT_STALE", relativePath);
      const childPath = relativePath ? `${relativePath}/${name}` : name;
      if (process.platform === "win32") {
        const childAbsolute = pathModule.resolve(name);
        const linked = (() => {
          try {
            return lstatSync(name, { bigint: true });
          } catch {
            return fail("CELLARER_SNAPSHOT_STALE", childPath);
          }
        })();
        if (linked.isSymbolicLink()) fail("CELLARER_SNAPSHOT_SYMLINK", childPath);
        const linkedIdentity = identity(linked);
        if (linked.isFile()) {
          reserveNode(childPath, linked.size);
          const fd = (() => {
            try {
              return openSync(name, flags);
            } catch {
              return fail("CELLARER_SNAPSHOT_STALE", childPath);
            }
          })();
          try {
            const opened = fstatSync(fd, { bigint: true });
            if (!opened.isFile() || identity(opened) !== linkedIdentity) {
              fail("CELLARER_SNAPSHOT_STALE", childPath);
            }
            verifyWindowsPath(childAbsolute, linkedIdentity);
            const data = input.includeData ? readFileSync(fd).toString("base64") : undefined;
            const after = fstatSync(fd, { bigint: true });
            if (identity(after) !== linkedIdentity) fail("CELLARER_SNAPSHOT_STALE", childPath);
            verifyWindowsPath(childAbsolute, linkedIdentity);
            nodes.push({
              relativePath: childPath,
              kind: "file",
              mode: Number(after.mode & 0o7777n),
              identity: identity(after),
              ...(data === undefined ? {} : { data }),
            });
          } finally {
            closeSync(fd);
          }
        } else if (linked.isDirectory()) {
          process.chdir(name);
          if (
            identity(statSync(".", { bigint: true })) !== linkedIdentity ||
            windowsPath(realpathSync.native(".")) !== windowsPath(childAbsolute)
          ) {
            fail("CELLARER_SNAPSHOT_STALE", childPath);
          }
          visitDirectory(childPath, linkedIdentity, childAbsolute);
          process.chdir("..");
          verifyWindowsPath(expectedAbsolute, expectedIdentity);
          verifyWindowsPath(childAbsolute, linkedIdentity);
        } else {
          fail("CELLARER_SNAPSHOT_NON_REGULAR", childPath);
        }
        continue;
      }
      const fd = (() => {
        try {
          return openSync(name, flags);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          return fail(
            code === "ELOOP" ? "CELLARER_SNAPSHOT_SYMLINK" : "CELLARER_SNAPSHOT_STALE",
            childPath,
          );
        }
      })();
      try {
        const opened = fstatSync(fd, { bigint: true });
        const openedIdentity = identity(opened);
        if (opened.isFile()) {
          reserveNode(childPath, opened.size);
          const data = input.includeData ? readFileSync(fd).toString("base64") : undefined;
          const after = fstatSync(fd, { bigint: true });
          if (identity(after) !== openedIdentity) fail("CELLARER_SNAPSHOT_STALE", childPath);
          nodes.push({
            relativePath: childPath,
            kind: "file",
            mode: Number(after.mode & 0o7777n),
            identity: identity(after),
            ...(data === undefined ? {} : { data }),
          });
        } else if (opened.isDirectory()) {
          process.chdir(name);
          if (identity(statSync(".", { bigint: true })) !== openedIdentity) {
            fail("CELLARER_SNAPSHOT_STALE", childPath);
          }
          visitDirectory(childPath, openedIdentity);
          process.chdir("..");
          if (identity(statSync(".", { bigint: true })) !== identity(before)) {
            fail("CELLARER_SNAPSHOT_STALE", relativePath);
          }
          if (identity(fstatSync(fd, { bigint: true })) !== openedIdentity) {
            fail("CELLARER_SNAPSHOT_STALE", childPath);
          }
        } else {
          fail("CELLARER_SNAPSHOT_NON_REGULAR", childPath);
        }
      } finally {
        closeSync(fd);
      }
    }
    const after = statSync(".", { bigint: true });
    if (identity(after) !== identity(before)) fail("CELLARER_SNAPSHOT_STALE", relativePath);
    if (process.platform === "win32") verifyWindowsPath(expectedAbsolute, expectedIdentity);
    nodes.push({
      relativePath,
      kind: "directory",
      mode: Number(after.mode & 0o7777n),
      identity: identity(after),
    });
  };

  try {
    let displayPath = input.expectedRootPath;
    for (const segment of input.anchorSegments) {
      displayPath = pathModule.join(displayPath, segment);
      if (enterDirectory(segment, displayPath) !== "entered") {
        verifyDirectories();
        process.stdout.write(JSON.stringify({ ok: true, exists: false, nodes: [] }));
        return;
      }
    }
    if (input.targetSegments.length === 0) fail("CELLARER_SNAPSHOT_STALE", displayPath);
    for (const [index, segment] of input.targetSegments.entries()) {
      displayPath = pathModule.join(displayPath, segment);
      const isFinal = index === input.targetSegments.length - 1;
      if (!isFinal) {
        if (enterDirectory(segment, displayPath) === "missing") {
          verifyDirectories();
          process.stdout.write(JSON.stringify({ ok: true, exists: false, nodes: [] }));
          return;
        }
        continue;
      }
      if (!validSegment(segment)) fail("CELLARER_SNAPSHOT_STALE", displayPath);
      if (process.platform === "win32") {
        let linked: BigIntStats;
        try {
          linked = lstatSync(segment, { bigint: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            verifyDirectories();
            process.stdout.write(JSON.stringify({ ok: true, exists: false, nodes: [] }));
            return;
          }
          return fail("CELLARER_SNAPSHOT_STALE", displayPath);
        }
        if (linked.isSymbolicLink()) fail("CELLARER_SNAPSHOT_SYMLINK", displayPath);
        const linkedIdentity = identity(linked);
        const expectedAbsolute = pathModule.resolve(segment);
        if (linked.isFile()) {
          reserveNode("", linked.size);
          let fd: number;
          try {
            fd = openSync(segment, flags);
          } catch {
            return fail("CELLARER_SNAPSHOT_STALE", displayPath);
          }
          try {
            const opened = fstatSync(fd, { bigint: true });
            if (!opened.isFile() || identity(opened) !== linkedIdentity) {
              fail("CELLARER_SNAPSHOT_STALE", displayPath);
            }
            verifyWindowsPath(expectedAbsolute, linkedIdentity);
            const data = input.includeData ? readFileSync(fd).toString("base64") : undefined;
            const after = fstatSync(fd, { bigint: true });
            if (identity(after) !== linkedIdentity) fail("CELLARER_SNAPSHOT_STALE", displayPath);
            verifyWindowsPath(expectedAbsolute, linkedIdentity);
            nodes.push({
              relativePath: "",
              kind: "file",
              mode: Number(after.mode & 0o7777n),
              identity: identity(after),
              ...(data === undefined ? {} : { data }),
            });
          } finally {
            closeSync(fd);
          }
        } else if (linked.isDirectory()) {
          process.chdir(segment);
          if (
            identity(statSync(".", { bigint: true })) !== linkedIdentity ||
            windowsPath(realpathSync.native(".")) !== windowsPath(expectedAbsolute)
          ) {
            fail("CELLARER_SNAPSHOT_STALE", displayPath);
          }
          visitDirectory("", linkedIdentity, expectedAbsolute);
          verifyWindowsPath(expectedAbsolute, linkedIdentity);
        } else {
          fail("CELLARER_SNAPSHOT_NON_REGULAR", displayPath);
        }
        verifyDirectories();
        process.stdout.write(JSON.stringify({ ok: true, exists: true, nodes }));
        return;
      }
      let fd: number;
      try {
        fd = openSync(segment, flags);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          verifyDirectories();
          process.stdout.write(JSON.stringify({ ok: true, exists: false, nodes: [] }));
          return;
        }
        return fail(
          code === "ELOOP" ? "CELLARER_SNAPSHOT_SYMLINK" : "CELLARER_SNAPSHOT_STALE",
          displayPath,
        );
      }
      try {
        const opened = fstatSync(fd, { bigint: true });
        const openedIdentity = identity(opened);
        if (opened.isFile()) {
          reserveNode("", opened.size);
          const data = input.includeData ? readFileSync(fd).toString("base64") : undefined;
          const after = fstatSync(fd, { bigint: true });
          if (identity(after) !== openedIdentity) fail("CELLARER_SNAPSHOT_STALE", displayPath);
          nodes.push({
            relativePath: "",
            kind: "file",
            mode: Number(after.mode & 0o7777n),
            identity: identity(after),
            ...(data === undefined ? {} : { data }),
          });
        } else if (opened.isDirectory()) {
          process.chdir(segment);
          if (identity(statSync(".", { bigint: true })) !== openedIdentity) {
            fail("CELLARER_SNAPSHOT_STALE", displayPath);
          }
          visitDirectory("", openedIdentity);
          if (identity(fstatSync(fd, { bigint: true })) !== openedIdentity) {
            fail("CELLARER_SNAPSHOT_STALE", displayPath);
          }
        } else {
          fail("CELLARER_SNAPSHOT_NON_REGULAR", displayPath);
        }
      } finally {
        closeSync(fd);
      }
    }
    verifyDirectories();
    process.stdout.write(JSON.stringify({ ok: true, exists: true, nodes }));
  } catch (error) {
    const detail = error as { code?: unknown; path?: unknown };
    process.stdout.write(
      JSON.stringify({
        ok: false,
        code: typeof detail.code === "string" ? detail.code : "CELLARER_SNAPSHOT_STALE",
        path: typeof detail.path === "string" ? detail.path : "",
      }),
    );
  } finally {
    for (const directory of directories.reverse()) {
      if (directory.fd !== undefined) closeSync(directory.fd);
    }
  }
}

const ANCHORED_SNAPSHOT_WORKER_SOURCE = `${classifyWindowsSnapshotIdentity.toString()}\n(${anchoredSnapshotWorkerMain.toString()})()`;

function snapshotTraversalBudget(): Pick<
  typeof SNAPSHOT_WORKER_BUDGET,
  | "maxNodes"
  | "maxSingleFileBytes"
  | "maxTotalFileBytes"
  | "maxRelativePathBytes"
  | "maxTotalPathBytes"
> {
  return {
    maxNodes: SNAPSHOT_WORKER_BUDGET.maxNodes,
    maxSingleFileBytes: SNAPSHOT_WORKER_BUDGET.maxSingleFileBytes,
    maxTotalFileBytes: SNAPSHOT_WORKER_BUDGET.maxTotalFileBytes,
    maxRelativePathBytes: SNAPSHOT_WORKER_BUDGET.maxRelativePathBytes,
    maxTotalPathBytes: SNAPSHOT_WORKER_BUDGET.maxTotalPathBytes,
  };
}

function executeSnapshotWorker(
  runner: SnapshotWorkerRunner,
  source: string,
  cwd: string,
  input: unknown,
  path: string,
): string {
  const serializedInput = JSON.stringify(input);
  if (Buffer.byteLength(serializedInput, "utf8") > SNAPSHOT_WORKER_BUDGET.maxInputBytes) {
    throw snapshotFailure("CELLARER_SNAPSHOT_BUDGET_EXCEEDED", path);
  }
  let output: string;
  try {
    output = runner({
      source,
      cwd,
      input: serializedInput,
      timeoutMs: SNAPSHOT_WORKER_BUDGET.timeoutMs,
      maxOutputBytes: SNAPSHOT_WORKER_BUDGET.maxOutputBytes,
    });
  } catch (error) {
    const detail = error as { code?: unknown; killed?: unknown; signal?: unknown } | null;
    if (detail?.code === "ETIMEDOUT" || detail?.killed === true) {
      throw snapshotFailure("CELLARER_SNAPSHOT_TIMEOUT", path);
    }
    if (detail?.code === "ENOBUFS") {
      throw snapshotFailure("CELLARER_SNAPSHOT_BUDGET_EXCEEDED", path);
    }
    throw snapshotFailure("CELLARER_SNAPSHOT_STALE", path);
  }
  if (
    typeof output !== "string" ||
    Buffer.byteLength(output, "utf8") > SNAPSHOT_WORKER_BUDGET.maxOutputBytes
  ) {
    throw snapshotFailure("CELLARER_SNAPSHOT_BUDGET_EXCEEDED", path);
  }
  return output;
}

function snapshotPathNoFollowSync(
  anchorRoot: string,
  path: string,
  includeData: boolean,
  runner: SnapshotWorkerRunner = defaultSnapshotWorkerRunner,
): FileTreeSnapshot | null {
  snapshotRuntimeSupport(nodeProcess.platform, nodeProcess.arch, path);
  if (!isAbsolute(anchorRoot) || !isAbsolute(path)) {
    throw snapshotFailure("CELLARER_SNAPSHOT_STALE", path);
  }
  const normalizedAnchor = resolve(anchorRoot);
  const normalizedPath = resolve(path);
  const pathRoot = parse(normalizedAnchor).root;
  const targetRelative = relative(normalizedAnchor, normalizedPath);
  if (
    targetRelative.length === 0 ||
    targetRelative === ".." ||
    targetRelative.startsWith(`..${sep}`) ||
    isAbsolute(targetRelative)
  ) {
    throw snapshotFailure("CELLARER_SNAPSHOT_STALE", path);
  }
  const output = executeSnapshotWorker(
    runner,
    ANCHORED_SNAPSHOT_WORKER_SOURCE,
    pathRoot,
    {
      anchorSegments: relative(pathRoot, normalizedAnchor).split(sep).filter(Boolean),
      targetSegments: targetRelative.split(sep).filter(Boolean),
      includeData,
      expectedRootPath: pathRoot,
      budget: snapshotTraversalBudget(),
    },
    path,
  );
  let result: AnchoredSnapshotWorkerResult;
  try {
    result = JSON.parse(output) as AnchoredSnapshotWorkerResult;
  } catch {
    throw snapshotFailure("CELLARER_SNAPSHOT_STALE", path);
  }
  if (result.ok && result.exists === false) return null;
  if (!result.ok || result.exists !== true || !Array.isArray(result.nodes)) {
    const code =
      result.code === "CELLARER_SNAPSHOT_SYMLINK" ||
      result.code === "CELLARER_SNAPSHOT_NON_REGULAR" ||
      result.code === "CELLARER_SNAPSHOT_UNSUPPORTED" ||
      result.code === "CELLARER_SNAPSHOT_BUDGET_EXCEEDED"
        ? result.code
        : "CELLARER_SNAPSHOT_STALE";
    throw snapshotFailure(code, typeof result.path === "string" ? result.path : path);
  }
  const nodes = decodeSnapshotWorkerNodes(result.nodes, includeData, path);
  return Object.freeze({
    rootPath: normalizedPath,
    nodes: Object.freeze(
      nodes.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    ),
  });
}

function runSnapshotWorker(
  rootPath: string,
  expectedRoot: string,
  includeData: boolean,
  runner: SnapshotWorkerRunner,
): FileTreeSnapshotNode[] {
  const output = executeSnapshotWorker(
    runner,
    SNAPSHOT_WORKER_SOURCE,
    rootPath,
    { expectedRoot, includeData, budget: snapshotTraversalBudget() },
    rootPath,
  );
  let result: SnapshotWorkerResult;
  try {
    result = JSON.parse(output) as SnapshotWorkerResult;
  } catch {
    throw snapshotFailure("CELLARER_SNAPSHOT_STALE", rootPath);
  }
  if (!result.ok || !Array.isArray(result.nodes)) {
    const relativePath = typeof result.path === "string" ? result.path : "";
    const path = relativePath ? join(rootPath, ...relativePath.split("/")) : rootPath;
    const code =
      result.code === "CELLARER_SNAPSHOT_SYMLINK" ||
      result.code === "CELLARER_SNAPSHOT_NON_REGULAR" ||
      result.code === "CELLARER_SNAPSHOT_UNSUPPORTED" ||
      result.code === "CELLARER_SNAPSHOT_BUDGET_EXCEEDED"
        ? result.code
        : "CELLARER_SNAPSHOT_STALE";
    throw snapshotFailure(code, path);
  }
  return decodeSnapshotWorkerNodes(result.nodes, includeData, rootPath);
}

function decodeSnapshotWorkerNodes(
  nodes: readonly SnapshotWorkerNode[],
  includeData: boolean,
  rootPath: string,
): FileTreeSnapshotNode[] {
  if (nodes.length > SNAPSHOT_WORKER_BUDGET.maxNodes) {
    throw snapshotFailure("CELLARER_SNAPSHOT_BUDGET_EXCEEDED", rootPath);
  }
  let totalFileBytes = 0;
  let totalPathBytes = 0;
  const seenPaths = new Set<string>();
  return nodes.map((node) => {
    if (
      (node.kind !== "file" && node.kind !== "directory") ||
      typeof node.relativePath !== "string" ||
      typeof node.mode !== "number" ||
      !Number.isSafeInteger(node.mode) ||
      node.mode < 0 ||
      typeof node.identity !== "string" ||
      node.identity.length === 0 ||
      seenPaths.has(node.relativePath) ||
      (node.relativePath !== "" &&
        node.relativePath
          .split("/")
          .some(
            (segment) =>
              segment.length === 0 ||
              segment === "." ||
              segment === ".." ||
              segment.includes("\\") ||
              segment.includes("\0"),
          )) ||
      (node.kind === "directory" && node.data !== undefined) ||
      (includeData && node.kind === "file" && typeof node.data !== "string")
    ) {
      throw snapshotFailure("CELLARER_SNAPSHOT_STALE", rootPath);
    }
    seenPaths.add(node.relativePath);
    const pathBytes = Buffer.byteLength(node.relativePath, "utf8");
    totalPathBytes += pathBytes;
    if (
      pathBytes > SNAPSHOT_WORKER_BUDGET.maxRelativePathBytes ||
      totalPathBytes > SNAPSHOT_WORKER_BUDGET.maxTotalPathBytes
    ) {
      throw snapshotFailure("CELLARER_SNAPSHOT_BUDGET_EXCEEDED", rootPath);
    }
    const data = node.data === undefined ? undefined : Buffer.from(node.data, "base64");
    if (node.data !== undefined && data?.toString("base64") !== node.data) {
      throw snapshotFailure("CELLARER_SNAPSHOT_STALE", rootPath);
    }
    const fileBytes = data?.byteLength ?? 0;
    totalFileBytes += fileBytes;
    if (
      fileBytes > SNAPSHOT_WORKER_BUDGET.maxSingleFileBytes ||
      totalFileBytes > SNAPSHOT_WORKER_BUDGET.maxTotalFileBytes
    ) {
      throw snapshotFailure("CELLARER_SNAPSHOT_BUDGET_EXCEEDED", rootPath);
    }
    return Object.freeze({
      relativePath: node.relativePath,
      kind: node.kind,
      mode: node.mode,
      identity: node.identity,
      ...(data === undefined ? {} : { data: new Uint8Array(data) }),
    });
  });
}

function snapshotFileNoFollowSync(rootPath: string, includeData: boolean): FileTreeSnapshot {
  const before = lstatSync(rootPath, { bigint: true });
  if (before.isSymbolicLink()) {
    throw snapshotFailure("CELLARER_SNAPSHOT_SYMLINK", rootPath);
  }
  if (!before.isFile()) {
    throw snapshotFailure("CELLARER_SNAPSHOT_NON_REGULAR", rootPath);
  }
  const optionalNoFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const optionalNonBlock = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
  const closeOnExec = (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC;
  const optionalCloseOnExec = typeof closeOnExec === "number" ? closeOnExec : 0;
  const fd = (() => {
    try {
      return openSync(
        rootPath,
        fsConstants.O_RDONLY | optionalNoFollow | optionalNonBlock | optionalCloseOnExec,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw snapshotFailure("CELLARER_SNAPSHOT_SYMLINK", rootPath);
      }
      throw error;
    }
  })();
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameNode(before, opened)) {
      throw snapshotFailure("CELLARER_SNAPSHOT_STALE", rootPath);
    }
    if (opened.size < 0n || opened.size > BigInt(SNAPSHOT_WORKER_BUDGET.maxSingleFileBytes)) {
      throw snapshotFailure("CELLARER_SNAPSHOT_BUDGET_EXCEEDED", rootPath);
    }
    const data = includeData ? new Uint8Array(readFileSync(fd)) : undefined;
    const after = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(rootPath, { bigint: true });
    if (!sameNode(opened, after) || !sameNode(after, afterPath)) {
      throw snapshotFailure("CELLARER_SNAPSHOT_STALE", rootPath);
    }
    return Object.freeze({
      rootPath,
      nodes: Object.freeze([
        Object.freeze({
          relativePath: "",
          kind: "file" as const,
          mode: Number(after.mode & 0o7777n),
          identity: statIdentity(after),
          ...(data === undefined ? {} : { data }),
        }),
      ]),
    });
  } finally {
    closeSync(fd);
  }
}

function snapshotTreeNoFollowSync(
  rootPath: string,
  includeData: boolean,
  runner: SnapshotWorkerRunner = defaultSnapshotWorkerRunner,
): FileTreeSnapshot {
  snapshotRuntimeSupport(nodeProcess.platform, nodeProcess.arch, rootPath);
  const before = lstatSync(rootPath, { bigint: true });
  if (before.isSymbolicLink()) {
    throw snapshotFailure("CELLARER_SNAPSHOT_SYMLINK", rootPath);
  }
  if (!before.isDirectory()) {
    throw snapshotFailure("CELLARER_SNAPSHOT_NON_REGULAR", rootPath);
  }
  const fd = openSync(rootPath, requiredSnapshotOpenFlags(rootPath));
  let nodes: FileTreeSnapshotNode[];
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || !sameNode(before, opened)) {
      throw snapshotFailure("CELLARER_SNAPSHOT_STALE", rootPath);
    }
    nodes = runSnapshotWorker(rootPath, statIdentity(opened), includeData, runner);
    const after = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(rootPath, { bigint: true });
    if (!sameNode(opened, after) || !sameNode(after, afterPath)) {
      throw snapshotFailure("CELLARER_SNAPSHOT_STALE", rootPath);
    }
  } finally {
    closeSync(fd);
  }
  return Object.freeze({
    rootPath,
    nodes: Object.freeze(
      nodes.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    ),
  });
}

async function snapshotFileNoFollow(rootPath: string): Promise<FileTreeSnapshot> {
  return snapshotFileNoFollowSync(rootPath, true);
}

async function snapshotTreeNoFollow(
  rootPath: string,
  runner: SnapshotWorkerRunner = defaultSnapshotWorkerRunner,
): Promise<FileTreeSnapshot> {
  return snapshotTreeNoFollowSync(rootPath, true, runner);
}

async function snapshotPathNoFollow(
  anchorRoot: string,
  path: string,
  runner: SnapshotWorkerRunner = defaultSnapshotWorkerRunner,
): Promise<FileTreeSnapshot | null> {
  return snapshotPathNoFollowSync(anchorRoot, path, true, runner);
}

async function verifyTreeSnapshot(
  snapshot: FileTreeSnapshot,
  runner: SnapshotWorkerRunner = defaultSnapshotWorkerRunner,
): Promise<boolean> {
  try {
    const current = snapshotTreeNoFollowSync(snapshot.rootPath, false, runner);
    return (
      current.nodes.length === snapshot.nodes.length &&
      current.nodes.every((node, index) => {
        const expected = snapshot.nodes[index];
        return (
          expected !== undefined &&
          node.relativePath === expected.relativePath &&
          node.kind === expected.kind &&
          node.mode === expected.mode &&
          node.identity === expected.identity
        );
      })
    );
  } catch {
    return false;
  }
}

async function verifyFileSnapshot(snapshot: FileTreeSnapshot): Promise<boolean> {
  try {
    const current = snapshotFileNoFollowSync(snapshot.rootPath, false);
    const expected = snapshot.nodes[0];
    const actual = current.nodes[0];
    return (
      snapshot.nodes.length === 1 &&
      current.nodes.length === 1 &&
      expected !== undefined &&
      actual !== undefined &&
      expected.kind === "file" &&
      actual.kind === "file" &&
      expected.mode === actual.mode &&
      expected.identity === actual.identity
    );
  } catch {
    return false;
  }
}

function toFsLike(snapshotWorkerRunner: SnapshotWorkerRunner): FsLike {
  return {
    readFile: (path) => nodeFs.readFile(path, "utf8"),
    readFileBytes: (path) => nodeFs.readFile(path),
    snapshotFileNoFollow,
    verifyFileSnapshot,
    supportsSafeRecursiveSnapshots: () => {
      try {
        snapshotRuntimeSupport(nodeProcess.platform, nodeProcess.arch);
        return true;
      } catch {
        return false;
      }
    },
    snapshotTreeNoFollow: (path) => snapshotTreeNoFollow(path, snapshotWorkerRunner),
    verifyTreeSnapshot: (snapshot) => verifyTreeSnapshot(snapshot, snapshotWorkerRunner),
    snapshotPathNoFollow: (anchorRoot, path) =>
      snapshotPathNoFollow(anchorRoot, path, snapshotWorkerRunner),
    writeFile: (path, data, opts) =>
      nodeFs.writeFile(path, data, { encoding: "utf8", mode: opts?.mode }),
    writeFileBytes: (path, data, opts) => nodeFs.writeFile(path, data, { mode: opts?.mode }),
    writeFileExclusive: async (path, data, opts) => {
      const dir = dirname(path);
      const temporary = publicationTempPath(path);
      await nodeFs.mkdir(dir, { recursive: true });
      try {
        await writeDurableTemp(temporary, data, opts?.mode);
        try {
          await nodeFs.link(temporary, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw error;
        }
        return true;
      } finally {
        await nodeFs.rm(temporary, { force: true }).catch(() => {});
        await syncDirectory(dir);
      }
    },
    publishFileAtomically: async (path, data, opts) => {
      const dir = dirname(path);
      const temporary = publicationTempPath(path);
      await nodeFs.mkdir(dir, { recursive: true });
      try {
        await writeDurableTemp(temporary, data, opts?.mode);
        await nodeFs.rename(temporary, path);
        await syncDirectory(dir);
      } catch (error) {
        await nodeFs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    },
    appendFile: (path, data) => nodeFs.appendFile(path, data, "utf8"),
    access: (path, mode) =>
      nodeFs.access(path, mode === "read" ? fsConstants.R_OK : fsConstants.W_OK),
    mkdir: async (path, opts) => {
      await nodeFs.mkdir(path, { recursive: opts?.recursive ?? false, mode: opts?.mode });
    },
    chmod: (path, mode) => nodeFs.chmod(path, mode),
    rm: (path, opts) => nodeFs.rm(path, opts),
    readdir: (path) => nodeFs.readdir(path),
    lstat: async (path): Promise<FileStat> => nodeFs.lstat(path),
    stat: async (path): Promise<FileStat> => nodeFs.stat(path),
    readlink: (path) => nodeFs.readlink(path, "utf8"),
    symlink: async (target, path, type?: SymlinkType) => {
      await nodeFs.symlink(target, path, type);
    },
    copyFile: (src, dest) => nodeFs.copyFile(src, dest),
    cp: (src, dest, opts) => nodeFs.cp(src, dest, { recursive: opts?.recursive ?? false }),
    realpath: (path) => nodeFs.realpath(path),
    rename: (oldPath, newPath) => nodeFs.rename(oldPath, newPath),
  };
}

async function probeProcessLiveness(processId: number): Promise<ProcessLiveness> {
  if (!Number.isSafeInteger(processId) || processId <= 0) return "unknown";
  try {
    nodeProcess.kill(processId, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    // EPERM proves that the PID exists even though the caller cannot signal it.
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

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

function createRealResourceSourceTransport(
  fs: FsLike,
  options: Pick<
    RealEnvOptions,
    "resourceSourceExec" | "resourceSourceFetch" | "resourceSourceLimits"
  >,
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

export function createRealEnv(options: RealEnvOptions = {}): Env {
  const fs = toFsLike(options.snapshotWorkerRunner ?? defaultSnapshotWorkerRunner);
  return {
    fs,
    homedir: () => os.homedir(),
    cwd: () => nodeProcess.cwd(),
    platform: nodeProcess.platform as Platform,
    processId: () => nodeProcess.pid,
    hostname: () => os.hostname(),
    probeProcessLiveness,
    randomId: () => randomUUID(),
    now: () => new Date(),
    env: nodeProcess.env,
    headlessLifetimeOwner,
    resourceSourceTransport: createRealResourceSourceTransport(fs, options),
    currentUserOnlyPermissions: {
      supported: (platform) => platform !== "win32",
      set: (path) => nodeFs.chmod(path, 0o600),
      verify: async (path) => {
        const stat = await nodeFs.lstat(path);
        return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0;
      },
    },
  };
}
