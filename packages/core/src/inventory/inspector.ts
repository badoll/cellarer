import { basename } from "node:path";
import type { AgentAdapter } from "../adapters/types.js";
import type { Env } from "../env.js";
import { lstatOrNull } from "../fs/probe.js";
import { serverToRaw } from "../mcp/model.js";
import { canonicalJson } from "../protocol/canonical.js";
import type { InventoryFindingCode } from "../protocol/client-types.js";
import { scanStructuredFileSecretFindings, scanTextForSecrets } from "../secrets/detector.js";
import {
  captureSafeRecursiveSource,
  type SafeRecursiveSnapshot,
  sliceSafeRecursiveSnapshot,
  UnsafeRecursiveSourceError,
} from "../secrets/safe-tree.js";
import { sha256 } from "../store/checksum.js";
import type { InventorySource } from "./enumerator.js";
import type {
  CapturedInventoryCandidateObservation,
  CapturedInventoryPublication,
  CapturedInventorySourceInspection,
  InventoryCandidateObservation,
  InventorySourceFinding,
  InventorySourceInspection,
} from "./types.js";

export async function inspectInventorySource(
  env: Env,
  source: InventorySource,
  adapter: AgentAdapter,
): Promise<InventorySourceInspection> {
  const captured = await inspectInventorySourceCaptured(env, source, adapter);
  return frozenInspection(captured.candidates.map(stripCapturedPublication), captured.findings);
}

export async function inspectInventorySourceCaptured(
  env: Env,
  source: InventorySource,
  adapter: AgentAdapter,
): Promise<CapturedInventorySourceInspection> {
  if ((await lstatOrNull(env, source.path)) === null) return frozenInspection([], []);

  let snapshot: SafeRecursiveSnapshot;
  try {
    snapshot = await captureSafeRecursiveSource(env, source.path);
  } catch (error) {
    return frozenInspection([], [{ code: snapshotFindingCode(error), source }]);
  }

  if (source.kind === "rules") return inspectRules(source, snapshot);
  if (source.kind === "mcp") return inspectMcp(source, snapshot, adapter);
  return inspectSkills(source, snapshot);
}

function inspectRules(
  source: InventorySource,
  snapshot: SafeRecursiveSnapshot,
): CapturedInventorySourceInspection {
  const name = removeKnownExtension(basename(source.path));
  if (snapshot.kind !== "file" || snapshot.files.length !== 1) {
    return frozenInspection(
      [observation(source, snapshot, name, ["INVALID_STRUCTURE"], rawPublication(snapshot))],
      [],
    );
  }
  const content = normalizeRuleContent(snapshot.files[0]?.content ?? "");
  if (content.trim().length === 0) return frozenInspection([], []);
  const findings: InventoryFindingCode[] =
    scanTextForSecrets(content).length > 0 ? ["PROBABLE_SECRET"] : [];
  return frozenInspection(
    [
      observation(
        source,
        snapshot,
        name,
        findings,
        filePublication(snapshot, content),
        undefined,
        sha256(content),
      ),
    ],
    [],
  );
}

function inspectMcp(
  source: InventorySource,
  snapshot: SafeRecursiveSnapshot,
  adapter: AgentAdapter,
): CapturedInventorySourceInspection {
  const fallbackName = removeKnownExtension(basename(source.path));
  if (snapshot.kind !== "file" || snapshot.files.length !== 1 || !adapter.mcp) {
    return frozenInspection(
      [
        observation(
          source,
          snapshot,
          fallbackName,
          ["INVALID_STRUCTURE"],
          rawPublication(snapshot),
        ),
      ],
      [],
    );
  }
  const content = snapshot.files[0]?.content ?? "";
  if (content.trim().length === 0) return frozenInspection([], []);
  const structured = scanStructuredFileSecretFindings(source.path, content);
  const hasSecret =
    scanTextForSecrets(content).length > 0 ||
    structured.some((finding) => finding.rule !== "structured-parse-error");
  try {
    const decoded = adapter.mcp.codec.decode(content, adapter.mcp.serversKey);
    const candidates = Object.entries(decoded.servers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, server]) => {
        const canonical = canonicalJson(serverToRaw(server));
        const serialized = `${JSON.stringify(serverToRaw(server), null, 2)}\n`;
        return observation(
          source,
          snapshot,
          name,
          hasSecret ? ["PROBABLE_SECRET"] : [],
          filePublication(snapshot, serialized),
          name,
          sha256(canonical),
        );
      });
    return frozenInspection(candidates, []);
  } catch {
    return frozenInspection(
      [observation(source, snapshot, fallbackName, ["PARSE_FAILED"], rawPublication(snapshot))],
      [],
    );
  }
}

function inspectSkills(
  source: InventorySource,
  snapshot: SafeRecursiveSnapshot,
): CapturedInventorySourceInspection {
  if (snapshot.kind !== "directory") {
    return frozenInspection(
      [
        observation(
          source,
          snapshot,
          basename(source.path),
          ["INVALID_STRUCTURE"],
          rawPublication(snapshot),
        ),
      ],
      [],
    );
  }
  const childNames = snapshot.directories
    .map((directory) => directory.relativePath)
    .filter((path) => path.length > 0 && !path.includes("/"))
    .sort((left, right) => left.localeCompare(right));
  const candidates = childNames.map((name) => {
    const child = sliceSafeRecursiveSnapshot(snapshot, name);
    const hasManifest = child.files.some((file) => file.relativePath === "SKILL.md");
    const hasSecret = child.files.some(
      (file) =>
        scanTextForSecrets(file.content).length > 0 ||
        scanStructuredFileSecretFindings(file.relativePath, file.content).some(
          (finding) => finding.rule !== "structured-parse-error",
        ),
    );
    const findings: InventoryFindingCode[] = [
      ...(!hasManifest ? (["INVALID_STRUCTURE"] as const) : []),
      ...(hasSecret ? (["PROBABLE_SECRET"] as const) : []),
    ];
    return observation(source, child, name, findings, directoryPublication(child), name);
  });
  return frozenInspection(candidates, []);
}

function observation(
  source: InventorySource,
  snapshot: SafeRecursiveSnapshot,
  name: string,
  findings: readonly InventoryFindingCode[],
  publication: CapturedInventoryPublication,
  relativePath?: string,
  contentFingerprint = snapshot.fingerprint,
): CapturedInventoryCandidateObservation {
  return Object.freeze({
    kind: source.kind,
    name,
    normalizedName: normalizeInventoryName(name),
    contentFingerprint,
    physicalIdentity: snapshot.identity,
    source,
    snapshot,
    publication,
    ...(relativePath ? { relativePath } : {}),
    findings: Object.freeze([...new Set(findings)].sort()),
  });
}

function frozenInspection<Candidate extends InventoryCandidateObservation>(
  candidates: readonly Candidate[],
  findings: readonly InventorySourceFinding[],
): {
  readonly candidates: readonly Candidate[];
  readonly findings: readonly InventorySourceFinding[];
} {
  return Object.freeze({
    candidates: Object.freeze([...candidates]),
    findings: Object.freeze([...findings]),
  });
}

function stripCapturedPublication(
  candidate: CapturedInventoryCandidateObservation,
): InventoryCandidateObservation {
  const { snapshot: _snapshot, publication: _publication, ...observation } = candidate;
  return Object.freeze(observation);
}

function filePublication(
  snapshot: SafeRecursiveSnapshot,
  data: string,
): CapturedInventoryPublication {
  const file = snapshot.files[0];
  if (!file) throw new UnsafeRecursiveSourceError(snapshot.rootPath, "non-regular");
  return Object.freeze({
    kind: "file",
    data,
    mode: file.mode,
    fingerprint: sha256(data),
  });
}

function directoryPublication(snapshot: SafeRecursiveSnapshot): CapturedInventoryPublication {
  return Object.freeze({
    kind: "directory",
    nodes: Object.freeze(
      snapshot.tree.nodes.map((node) =>
        node.kind === "directory"
          ? Object.freeze({ path: node.relativePath, kind: "directory" as const, mode: node.mode })
          : Object.freeze({
              path: node.relativePath,
              kind: "file" as const,
              mode: node.mode,
              data: new TextDecoder("utf-8", { fatal: true }).decode(node.data ?? new Uint8Array()),
              digest: sha256(node.data ?? new Uint8Array()),
            }),
      ),
    ),
    fingerprint: snapshot.fingerprint,
  });
}

function rawPublication(snapshot: SafeRecursiveSnapshot): CapturedInventoryPublication {
  return snapshot.kind === "file"
    ? filePublication(snapshot, snapshot.files[0]?.content ?? "")
    : directoryPublication(snapshot);
}

function snapshotFindingCode(error: unknown): InventoryFindingCode {
  if (!(error instanceof UnsafeRecursiveSourceError)) return "SOURCE_UNREADABLE";
  if (error.reason === "symbolic-link") return "UNSAFE_LINK";
  if (error.reason === "unsupported") return "UNSUPPORTED_SNAPSHOT";
  if (error.reason === "stale") return "SNAPSHOT_STALE";
  return "SOURCE_UNREADABLE";
}

function removeKnownExtension(name: string): string {
  return name.replace(/\.(?:json|jsonc|toml|yaml|yml|md|mdc)$/i, "");
}

export function normalizeInventoryName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeRuleContent(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n").trimEnd();
  return normalized.length > 0 ? `${normalized}\n` : "";
}
