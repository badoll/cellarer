import { loadRegistryFromConfig } from "../adapters/registry.js";
import type { AgentAdapter } from "../adapters/types.js";
import type { Env } from "../env.js";
import { serverFromRaw, serverToRaw } from "../mcp/model.js";
import { canonicalJson } from "../protocol/canonical.js";
import type {
  InventoryFinding,
  InventoryFindingCode,
  InventoryRefreshResult,
} from "../protocol/client-types.js";
import { observeAtStableStoreRevision } from "../protocol/store-revision.js";
import { loadResourceRecord } from "../resources/model.js";
import { captureSafeRecursiveSource } from "../secrets/safe-tree.js";
import { sha256 } from "../store/checksum.js";
import type { CellarerConfig } from "../store/config.js";
import { observeStoreConfigSnapshot } from "../store/snapshot.js";
import { listMcpArtifacts, listRuleArtifacts, listSkillArtifacts } from "../store/store.js";
import {
  enumerateInventorySources,
  type InventoryEnumerationFinding,
  type InventorySource,
  inspectInventorySourcesBounded,
} from "./enumerator.js";
import { groupInventoryCandidates, inventoryFinding } from "./grouper.js";
import {
  inspectInventorySourceCaptured,
  normalizeInventoryName,
  normalizeRuleContent,
} from "./inspector.js";
import type {
  CapturedInventoryCandidateObservation,
  InventoryCandidateObservation,
  InventorySourceFinding,
  ManagedInventoryRevision,
} from "./types.js";

const DEFAULT_CONCURRENCY = 4;
const MAX_REFRESH_ATTEMPTS = 2;

export interface InventoryRefreshOptions {
  readonly storeRoot: string;
  readonly projectRoot?: string;
  readonly agentId?: string;
  readonly concurrency?: number;
}

export interface InventoryRefreshCapture {
  readonly result: InventoryRefreshResult;
  readonly candidates: readonly CapturedInventoryCandidateObservation[];
  readonly canonicalStoreRoot?: string;
  readonly storeRevision?: number;
  readonly projectRoot?: string;
  readonly configuration?: CellarerConfig;
}

export async function refreshInventory(
  env: Env,
  options: InventoryRefreshOptions,
): Promise<InventoryRefreshResult> {
  return (await captureInventoryRefresh(env, options)).result;
}

export async function captureInventoryRefresh(
  env: Env,
  options: InventoryRefreshOptions,
): Promise<InventoryRefreshCapture> {
  for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt += 1) {
    let snapshotObservation: Awaited<ReturnType<typeof observeStoreConfigSnapshot>>;
    try {
      snapshotObservation = await observeStoreConfigSnapshot(env, options.storeRoot);
    } catch {
      return failedCapture(env, "STORE_PROJECTION_FAILED");
    }
    if (!snapshotObservation.ok) {
      return failedCapture(
        env,
        snapshotObservation.error.code === "STALE_STORE_SNAPSHOT"
          ? "STORE_SNAPSHOT_STALE"
          : "STORE_SNAPSHOT_UNSAFE",
      );
    }
    const snapshot = snapshotObservation.snapshot;

    try {
      const registry = await loadRegistryFromConfig(env, snapshot.configuration);
      const enumeration = await enumerateInventorySources(env, {
        adapters: registry.list(),
        configuration: snapshot.configuration,
        ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
        ...(options.agentId ? { agentId: options.agentId } : {}),
      });
      const inspected = await inspectSources(
        env,
        enumeration.sources,
        registry.get,
        options.concurrency ?? DEFAULT_CONCURRENCY,
      );
      let managed: readonly ManagedInventoryRevision[] = [];
      const findings: InventoryFinding[] = [
        ...enumeration.findings.map((finding) => enumerationFinding(finding)),
        ...inspected.findings.map((finding) => sourceFinding(env, finding)),
      ];
      try {
        const stableManaged = await observeAtStableStoreRevision(
          env,
          snapshot.canonicalStoreRoot,
          () => loadManagedInventory(env, snapshot.canonicalStoreRoot),
        );
        if (stableManaged.revision !== snapshot.revision) continue;
        managed = stableManaged.value;
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === "REVISION_CHANGED_DURING_PLANNING") {
          continue;
        }
        findings.push(inventoryFinding("STORE_PROJECTION_FAILED", "refresh"));
      }

      const result = projectRefreshResult(
        env,
        inspected.candidates,
        managed,
        findings,
        enumeration.sources.length,
      );
      return Object.freeze({
        result,
        candidates: inspected.candidates,
        canonicalStoreRoot: snapshot.canonicalStoreRoot,
        storeRevision: snapshot.revision,
        configuration: snapshot.configuration,
        ...(enumeration.projectRoot ? { projectRoot: enumeration.projectRoot } : {}),
      });
    } catch {
      return failedCapture(env, "STORE_PROJECTION_FAILED");
    }
  }
  return failedCapture(env, "STORE_SNAPSHOT_STALE");
}

function projectRefreshResult(
  env: Env,
  observations: readonly InventoryCandidateObservation[],
  managed: readonly ManagedInventoryRevision[],
  inputFindings: readonly InventoryFinding[],
  observedSources: number,
): InventoryRefreshResult {
  const candidates = groupInventoryCandidates(env, observations, managed);
  const findings = Object.freeze([...inputFindings]);
  const completeness =
    findings.length === 0 ? "complete" : candidates.length > 0 ? "partial" : "failed";
  return Object.freeze({
    generatedAt: env.now().toISOString(),
    candidates,
    findings,
    counts: Object.freeze({
      total: candidates.length,
      ready: candidates.filter((candidate) => candidate.state === "ready").length,
      needsAttention: candidates.filter((candidate) => candidate.state === "needs-attention")
        .length,
      inStore: candidates.filter((candidate) => candidate.state === "in-store").length,
      observedSources,
      failedSources: findings.filter((finding) => finding.scope === "source").length,
    }),
    completeness,
  });
}

async function inspectSources(
  env: Env,
  sources: readonly InventorySource[],
  getAdapter: (id: string) => AgentAdapter | undefined,
  concurrency: number,
): Promise<{
  readonly candidates: readonly CapturedInventoryCandidateObservation[];
  readonly findings: readonly InventorySourceFinding[];
}> {
  const work = new Map<string, InventorySource[]>();
  for (const source of sources) {
    const key = `${source.kind}\0${source.path}${source.kind === "mcp" ? `\0${source.adapterId}` : ""}`;
    const group = work.get(key) ?? [];
    group.push(source);
    work.set(key, group);
  }
  const primarySources = [...work.values()]
    .map((group) => group[0])
    .filter(Boolean) as InventorySource[];
  const inspected = await inspectInventorySourcesBounded(
    primarySources,
    concurrency,
    async (source) => {
      const adapter = getAdapter(source.adapterId);
      if (!adapter) throw new Error("registered Inventory adapter disappeared");
      return inspectInventorySourceCaptured(env, source, adapter);
    },
  );
  const candidates: CapturedInventoryCandidateObservation[] = [];
  const findings: InventorySourceFinding[] = [];
  for (const result of inspected) {
    const key = `${result.source.kind}\0${result.source.path}${
      result.source.kind === "mcp" ? `\0${result.source.adapterId}` : ""
    }`;
    const equivalentSources = work.get(key) ?? [result.source];
    if (!result.ok) {
      findings.push(
        ...equivalentSources.map((source) => ({ code: "SOURCE_UNREADABLE" as const, source })),
      );
      continue;
    }
    for (const source of equivalentSources) {
      candidates.push(...result.value.candidates.map((candidate) => ({ ...candidate, source })));
      findings.push(...result.value.findings.map((finding) => ({ ...finding, source })));
    }
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    findings: Object.freeze(findings),
  });
}

async function loadManagedInventory(
  env: Env,
  storeRoot: string,
): Promise<readonly ManagedInventoryRevision[]> {
  const artifacts = (
    await Promise.all([
      listRuleArtifacts(env, storeRoot),
      listMcpArtifacts(env, storeRoot),
      listSkillArtifacts(env, storeRoot),
    ])
  ).flat();
  const managed = await Promise.all(
    artifacts.map(async (artifact): Promise<ManagedInventoryRevision> => {
      const [record, snapshot] = await Promise.all([
        loadResourceRecord(env, storeRoot, artifact),
        captureSafeRecursiveSource(env, artifact.sourcePath),
      ]);
      let contentFingerprint = snapshot.fingerprint;
      if (artifact.kind === "rules") {
        contentFingerprint = sha256(normalizeRuleContent(snapshot.files[0]?.content ?? ""));
      } else if (artifact.kind === "mcp") {
        const parsed = serverFromRaw(JSON.parse(snapshot.files[0]?.content ?? ""));
        contentFingerprint = sha256(canonicalJson(serverToRaw(parsed)));
      }
      return Object.freeze({
        resourceId: record.resourceId,
        kind: record.kind,
        normalizedName: normalizeInventoryName(record.name),
        contentFingerprint,
        revisionId: record.currentRevision.id,
      });
    }),
  );
  return Object.freeze(managed);
}

function enumerationFinding(finding: InventoryEnumerationFinding): InventoryFinding {
  return inventoryFinding(finding.code, "source");
}

function sourceFinding(env: Env, finding: InventorySourceFinding): InventoryFinding {
  const sourceId = sha256(
    `${finding.source.kind}\0${finding.source.scope}\0${
      finding.source.scope === "global" ? "~" : "<project>"
    }\0${finding.source.path.startsWith(env.homedir()) ? finding.source.path.slice(env.homedir().length) : "source"}`,
  );
  return inventoryFinding(finding.code, "source", `inventory-source:v1:${sourceId.slice(7)}`);
}

function failedResult(env: Env, code: InventoryFindingCode): InventoryRefreshResult {
  return Object.freeze({
    generatedAt: env.now().toISOString(),
    candidates: Object.freeze([]),
    findings: Object.freeze([inventoryFinding(code, "refresh")]),
    counts: Object.freeze({
      total: 0,
      ready: 0,
      needsAttention: 0,
      inStore: 0,
      observedSources: 0,
      failedSources: 0,
    }),
    completeness: "failed",
  });
}

function failedCapture(env: Env, code: InventoryFindingCode): InventoryRefreshCapture {
  return Object.freeze({
    result: failedResult(env, code),
    candidates: Object.freeze([]),
  });
}
