import { basename, relative, sep } from "node:path";
import type { Env } from "../env.js";
import { isWithinRoot } from "../fs/safety.js";
import type {
  InventoryCandidate,
  InventoryFinding,
  InventoryFindingCode,
  InventoryFindingRemediation,
  InventoryRelatedAdapter,
  InventorySourceProvenance,
} from "../protocol/client-types.js";
import { sha256 } from "../store/checksum.js";
import type { InventorySource } from "./enumerator.js";
import type { InventoryCandidateObservation, ManagedInventoryRevision } from "./types.js";

export function groupInventoryCandidates(
  env: Env,
  observations: readonly InventoryCandidateObservation[],
  managed: readonly ManagedInventoryRevision[],
): readonly InventoryCandidate[] {
  const groups = new Map<string, InventoryCandidateObservation[]>();
  for (const observation of observations) {
    const key = candidateKey(observation);
    const current = groups.get(key) ?? [];
    current.push(observation);
    groups.set(key, current);
  }
  const conflictKeys = new Map<string, Set<string>>();
  for (const observation of observations) {
    const key = `${observation.kind}\0${observation.normalizedName}`;
    const fingerprints = conflictKeys.get(key) ?? new Set<string>();
    fingerprints.add(observation.contentFingerprint);
    conflictKeys.set(key, fingerprints);
  }

  return Object.freeze(
    [...groups.values()]
      .map((items) =>
        projectCandidate(
          env,
          items,
          managed,
          (conflictKeys.get(`${items[0]?.kind}\0${items[0]?.normalizedName}`)?.size ?? 0) > 1,
        ),
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}

function projectCandidate(
  env: Env,
  observations: readonly InventoryCandidateObservation[],
  managed: readonly ManagedInventoryRevision[],
  conflict: boolean,
): InventoryCandidate {
  const first = observations[0];
  if (!first) throw new TypeError("Inventory candidate group cannot be empty");
  const id = candidateId(first.kind, first.normalizedName, first.contentFingerprint);
  const conflictGroupId = conflict
    ? `inventory-conflict:v1:${digest(`${first.kind}\0${first.normalizedName}`)}`
    : undefined;
  const codes = new Set(observations.flatMap((observation) => observation.findings));
  if (conflict) codes.add("CONFLICT");
  const match = managed.find(
    (item) =>
      item.kind === first.kind &&
      item.normalizedName === first.normalizedName &&
      item.contentFingerprint === first.contentFingerprint,
  );
  const state = codes.size > 0 ? "needs-attention" : match ? "in-store" : "ready";
  const sources = projectSources(env, observations);
  const relatedAdapters = mergeAdapters(sources.flatMap((source) => source.adapters));

  return Object.freeze({
    id,
    kind: first.kind,
    name: observations.map((item) => item.name).sort()[0] ?? first.name,
    contentFingerprint: first.contentFingerprint,
    state,
    defaultSelected: state === "ready",
    sources,
    relatedAdapters,
    findings: Object.freeze([...codes].sort().map((code) => inventoryFinding(code, "candidate"))),
    ...(match
      ? { managedMatch: { resourceId: match.resourceId, revisionId: match.revisionId } }
      : {}),
    ...(conflictGroupId ? { conflictGroupId } : {}),
  } satisfies InventoryCandidate);
}

function projectSources(
  env: Env,
  observations: readonly InventoryCandidateObservation[],
): readonly InventorySourceProvenance[] {
  const sources = new Map<
    string,
    { source: InventorySource; location: string; adapters: InventoryRelatedAdapter[] }
  >();
  for (const observation of observations) {
    const location = redactedSourceLocation(env, observation.source, observation.relativePath);
    const id = `inventory-source:v1:${digest(`${observation.kind}\0${observation.source.scope}\0${location}`)}`;
    const adapter = adapterProjection(observation.source);
    const existing = sources.get(id);
    if (existing) {
      existing.adapters.push(adapter);
    } else {
      sources.set(id, { source: observation.source, location, adapters: [adapter] });
    }
  }
  return Object.freeze(
    [...sources.entries()]
      .map(([id, item]) =>
        Object.freeze({
          id,
          kind: item.source.kind,
          scope: item.source.scope,
          location: item.location,
          adapters: mergeAdapters(item.adapters),
        }),
      )
      .sort((left, right) => left.location.localeCompare(right.location)),
  );
}

function mergeAdapters(
  adapters: readonly InventoryRelatedAdapter[],
): readonly InventoryRelatedAdapter[] {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  return Object.freeze([...byId.values()].sort((left, right) => left.id.localeCompare(right.id)));
}

function adapterProjection(source: InventorySource): InventoryRelatedAdapter {
  return Object.freeze({
    id: source.adapterId,
    displayName: source.displayName,
    enabled: source.enabled,
    detected: source.detected,
  });
}

function redactedSourceLocation(
  env: Env,
  source: InventorySource,
  candidateRelativePath: string | undefined,
): string {
  const path = candidateRelativePath ? `${source.path}${sep}${candidateRelativePath}` : source.path;
  const root = source.boundaryRoot ?? (source.scope === "global" ? env.homedir() : env.cwd());
  if (isWithinRoot(root, path)) {
    const suffix = relative(root, path).split(sep).join("/");
    return source.scope === "global" ? `~/${suffix}` : `<project>/${suffix}`;
  }
  return source.scope === "global" ? `~/${basename(path)}` : `<project>/${basename(path)}`;
}

function candidateKey(observation: InventoryCandidateObservation): string {
  return `${observation.kind}\0${observation.normalizedName}\0${observation.contentFingerprint}`;
}

function candidateId(kind: string, normalizedName: string, fingerprint: string): string {
  return `inventory-candidate:v1:${kind}:${digest(`${kind}\0${normalizedName}\0${fingerprint}`)}`;
}

function digest(value: string): string {
  return sha256(value).slice("sha256:".length);
}

export function inventoryFinding(
  code: InventoryFindingCode,
  scope: InventoryFinding["scope"],
  sourceId?: string,
): InventoryFinding {
  const finding = Object.freeze({
    code,
    severity: findingSeverity(code),
    scope,
    remediation: findingRemediation(code),
    ...(sourceId ? { sourceId } : {}),
  });
  return finding;
}

function findingSeverity(code: InventoryFindingCode): InventoryFinding["severity"] {
  return code === "ADAPTER_DETECTION_FAILED" ? "warning" : "blocked";
}

function findingRemediation(code: InventoryFindingCode): InventoryFindingRemediation {
  if (code === "ADAPTER_DETECTION_FAILED" || code === "ADAPTER_PATHS_FAILED") {
    return "review-adapter";
  }
  if (code === "UNSAFE_LINK") return "remove-unsafe-link";
  if (code === "SNAPSHOT_STALE" || code === "STORE_SNAPSHOT_STALE") return "retry-refresh";
  if (code === "INVALID_STRUCTURE" || code === "PARSE_FAILED") return "fix-structure";
  if (code === "PROBABLE_SECRET") return "remove-secret-values";
  if (code === "CONFLICT") return "resolve-conflict";
  if (code === "STORE_SNAPSHOT_UNSAFE" || code === "STORE_PROJECTION_FAILED") {
    return "repair-store";
  }
  return "check-source-access";
}
