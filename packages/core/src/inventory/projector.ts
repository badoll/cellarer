import { relative, sep } from "node:path";
import { loadRegistryFromConfig } from "../adapters/registry.js";
import type { AgentAdapter } from "../adapters/types.js";
import type { Env } from "../env.js";
import { serverFromRaw, serverToRaw } from "../mcp/model.js";
import { canonicalJson } from "../protocol/canonical.js";
import type {
  InventoryCoverage,
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
import {
  groupInventoryCandidates,
  inventoryFinding,
  projectEffectiveResources,
} from "./grouper.js";
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

      const projected = projectRefreshResult(
        env,
        inspected.candidates,
        managed,
        findings,
        enumeration.sources.length,
        [
          ...enumeration.sources.map(
            (source): InventoryCoverage => ({
              adapterId: source.adapterId,
              sourceId: source.discovery?.sourceId,
              ...(source.boundaryRoot
                ? {
                    location: `${source.scope === "global" ? "~" : "<project>"}/${relative(source.boundaryRoot, source.path).split(sep).join("/")}`,
                  }
                : {}),
              ...(source.discovery
                ? {
                    bounds: {
                      maxDepth: source.discovery.maxDepth,
                      maxEntries: source.discovery.maxEntries,
                      maxBytes: source.discovery.maxBytes,
                    },
                  }
                : {}),
              kind: source.kind,
              scope: source.scope,
              dimension: "source",
              status: inspected.findings.some((finding) => finding.source.id === source.id)
                ? "unavailable"
                : "observed",
              mode: source.discoveryMode ?? "placement-only",
              reason:
                source.discoveryMode === "declared"
                  ? "Declared bounded source; absent paths are empty observations."
                  : "Placement-only fallback; native discovery is unknown.",
            }),
          ),
          ...enumeration.findings
            .filter((finding) => finding.code !== "ADAPTER_DETECTION_FAILED")
            .map(
              (finding): InventoryCoverage => ({
                adapterId: finding.adapterId,
                scope: finding.scope,
                ...(finding.kind ? { kind: finding.kind } : {}),
                dimension: "source",
                status: finding.code === "SOURCE_OUTSIDE_BOUNDARY" ? "excluded" : "unavailable",
                mode: registry.get(finding.adapterId)?.discovery ? "declared" : "placement-only",
                reason: finding.code,
              }),
            ),
          ...registry
            .list()
            .filter((adapter) => !options.agentId || adapter.id === options.agentId)
            .flatMap((adapter) =>
              (
                ["plugins", "managed", "ancestors", "nested-projects", "native-expansion"] as const
              ).map(
                (dimension): InventoryCoverage => ({
                  adapterId: adapter.id,
                  dimension,
                  status: "excluded",
                  mode: adapter.discovery ? "declared" : "placement-only",
                  reason:
                    "Outside the explicitly declared user and project boundary; not searched.",
                }),
              ),
            ),
        ],
      );
      const incomplete = new Set(
        inspected.findings.map((finding) => `${finding.source.adapterId}\0${finding.source.kind}`),
      );
      for (const finding of enumeration.findings) {
        for (const kind of finding.kind ? [finding.kind] : ["rules", "mcp", "skills"])
          incomplete.add(`${finding.adapterId}\0${kind}`);
      }
      const result = Object.freeze({
        ...projected,
        resolutionContext: enumeration.projectRoot ? ("project" as const) : ("user" as const),
        effectiveResources: projectEffectiveResources(inspected.candidates, incomplete),
      });
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
  coverage: readonly InventoryCoverage[] = [],
): InventoryRefreshResult {
  const candidates = groupInventoryCandidates(env, observations, managed);
  const findings = Object.freeze([...inputFindings]);
  const completeness =
    findings.length === 0
      ? "complete"
      : candidates.length > 0 ||
          findings.some((finding) => finding.code === "SOURCE_BUDGET_EXCEEDED")
        ? "partial"
        : "failed";
  return Object.freeze({
    generatedAt: env.now().toISOString(),
    coverage: Object.freeze(coverage),
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

function captureKey(source: InventorySource): string {
  return JSON.stringify([
    source.kind,
    source.path,
    source.boundaryRoot,
    source.discovery?.maxDepth,
    source.discovery?.maxEntries,
    source.discovery?.maxBytes,
    source.kind === "mcp" ? source.adapterId : null,
  ]);
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
    const key = captureKey(source);
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
    const key = captureKey(result.source);
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
