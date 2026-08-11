import { listActivity } from "../activity.js";
import { loadRegistry } from "../adapters/registry.js";
import { inCollections } from "../engine/plan.js";
import { type ScanItem, scanPlan } from "../engine/scan.js";
import { status } from "../engine/status.js";
import type { DriftStatus, StatusItem } from "../engine/types.js";
import type { Env } from "../env.js";
import type { Capability, Scope } from "../model/index.js";
import type {
  AssertExact,
  Destination,
  ExactContract,
  ResourceCatalogCounts,
  ResourceCatalogItem,
  ResourceCatalogResult,
  ResourceState,
  ResourceSyncTarget,
} from "../protocol/client-types.js";
import { loadConfig } from "../store/config.js";
import { loadLedger } from "../store/ledger.js";
import { listMcpArtifacts, listRuleArtifacts, listSkillArtifacts } from "../store/store.js";
import { loadResourceRecord } from "./model.js";

export type {
  Destination,
  ResourceCatalogCounts,
  ResourceCatalogItem,
  ResourceCatalogResult,
  ResourceState,
  ResourceSyncTarget,
} from "../protocol/client-types.js";

export interface ResourceCatalogOptions {
  storeRoot: string;
  kind?: Capability;
  agents?: string[];
  collections?: string[];
  destination?: Destination;
  dir?: string;
  includeDiscovered?: boolean;
}

async function resourceCatalogImplementation(env: Env, opts: ResourceCatalogOptions) {
  const [config, ledger, activity, ruleArtifacts, mcpArtifacts, skillArtifacts, statusItems] =
    await Promise.all([
      loadConfig(env, opts.storeRoot),
      loadLedger(env, opts.storeRoot),
      listActivity(env, opts.storeRoot, { limit: 256 }),
      listRuleArtifacts(env, opts.storeRoot),
      listMcpArtifacts(env, opts.storeRoot),
      listSkillArtifacts(env, opts.storeRoot),
      status(env, {
        storeRoot: opts.storeRoot,
        scope: destinationToScope(opts.destination),
        dir: opts.dir,
        agents: opts.agents,
      }),
    ]);

  const counts = emptyCounts();
  const warnings = [...activity.warnings];

  const lastActivityByArtifact = new Map<string, string>();
  for (const event of activity.events) {
    for (const artifactIdentity of event.resources?.artifactIds ?? []) {
      for (const artifactId of expandConcreteArtifactIdentities(artifactIdentity)) {
        if (!lastActivityByArtifact.has(artifactId))
          lastActivityByArtifact.set(artifactId, event.time);
      }
    }
  }

  const allArtifacts = [...ruleArtifacts, ...mcpArtifacts, ...skillArtifacts];
  const artifactsWithRecords = await Promise.all(
    allArtifacts
      .filter((artifact) => !opts.kind || artifact.kind === opts.kind)
      .map(async (artifact) => ({
        artifact,
        record: await loadResourceRecord(env, opts.storeRoot, artifact),
      })),
  );
  const filteredArtifacts = artifactsWithRecords.filter(({ record }) => {
    const collections = config.artifacts[record.resourceId]?.collections ?? [];
    if (opts.collections && opts.collections.length > 0) {
      return inCollections(collections, opts.collections);
    }
    return true;
  });

  const resources: ReturnType<typeof catalogItem>[] = [];
  for (const { artifact, record } of filteredArtifacts) {
    const collections = config.artifacts[record.resourceId]?.collections ?? [];
    const syncTargets = statusItems
      .filter((item) => statusMatchesArtifact(item, record.resourceId))
      .map((item) =>
        resourceSyncTarget(
          item.agent,
          scopeToDestination(item.scope),
          item.scope,
          item.target,
          statusToResourceState(item.status),
        ),
      );

    counts.managed += 1;
    for (const target of syncTargets) counts[target.state] += 1;

    resources.push(
      catalogItem({
        id: record.resourceId,
        kind: record.kind,
        name: record.name,
        state: "managed",
        collections,
        sourcePath: artifact.sourcePath,
        currentRevision: record.currentRevision,
        provenance: record.currentRevision.source,
        syncTargets,
        secretRefs: collectArtifactSecretRefs(ledger.owners, record.resourceId),
        lastActivityAt: lastActivityByArtifact.get(record.resourceId),
      }),
    );
  }

  if (shouldIncludeDiscovered(opts)) {
    const discovered = await discoveredResources(env, opts, config);
    resources.push(...discovered.resources);
    warnings.push(...discovered.warnings);
    addCounts(counts, discovered.counts);
  }

  return {
    generatedAt: env.now().toISOString(),
    resources,
    counts,
    warnings,
  };
}

export async function resourceCatalog(
  env: Env,
  opts: ResourceCatalogOptions,
): Promise<ResourceCatalogResult> {
  return resourceCatalogImplementation(env, opts);
}

export type ResourceCatalogProducerContract = AssertExact<
  ExactContract<Awaited<ReturnType<typeof resourceCatalogImplementation>>, ResourceCatalogResult>
>;
export type ResourceCatalogItemProducerContract = AssertExact<
  ExactContract<ReturnType<typeof catalogItem>, ResourceCatalogItem>
>;

function shouldIncludeDiscovered(opts: ResourceCatalogOptions): boolean {
  if (opts.includeDiscovered === false) return false;
  return !opts.collections || opts.collections.length === 0;
}

async function discoveredResources(
  env: Env,
  opts: ResourceCatalogOptions,
  config: Awaited<ReturnType<typeof loadConfig>>,
) {
  const destination = opts.destination ?? "user";
  const scope: Scope = destination === "project" ? "project" : "global";
  const registry = await loadRegistry(env, opts.storeRoot);
  const agentIds =
    opts.agents && opts.agents.length > 0
      ? opts.agents
      : registry
          .list()
          .filter((agent) => config.adapterOverrides[agent.id]?.enabled !== false)
          .map((agent) => agent.id);
  const resources: ReturnType<typeof catalogItem>[] = [];
  const counts = emptyCounts();
  const warnings = [...registry.warnings];

  for (const agent of agentIds) {
    const plan = await scanPlan(env, {
      storeRoot: opts.storeRoot,
      agent,
      scope,
      dir: opts.dir,
      capabilities: opts.kind ? [opts.kind] : undefined,
      conflict: "keep-mine",
    });
    warnings.push(...plan.warnings);

    for (const item of plan.items) {
      if (item.status === "conflict" && item.action === "skip") continue;
      const state: ResourceState = item.action === "skip" ? "blocked" : "discovered";
      counts[state] += 1;
      resources.push(discoveredResourceItem(item, agent, destination, state));
    }
  }

  return { resources, counts, warnings };
}

function discoveredResourceItem(
  item: ScanItem,
  agent: string,
  destination: Destination,
  state: ResourceState,
) {
  return catalogItem({
    id: `discovered:${agent}:${item.kind}:${item.name}:${item.source}`,
    kind: item.kind,
    name: item.name,
    state,
    collections: [],
    discovered: discoveredDescriptor(agent, destination, item.source),
    syncTargets: [],
    secretRefs: item.secretRefs ?? [],
  });
}

function catalogItem(input: {
  id: string;
  kind: Capability;
  name: string;
  state: ResourceState;
  collections: string[];
  sourcePath?: ResourceCatalogItem["sourcePath"];
  currentRevision?: ResourceCatalogItem["currentRevision"];
  provenance?: ResourceCatalogItem["provenance"];
  discovered?: ResourceCatalogItem["discovered"];
  syncTargets: ReturnType<typeof resourceSyncTarget>[];
  secretRefs: string[];
  lastActivityAt?: string;
}) {
  return { ...input };
}

function addCounts(target: ResourceCatalogCounts, source: ResourceCatalogCounts): void {
  target.managed += source.managed;
  target.discovered += source.discovered;
  target.synced += source.synced;
  target.drifted += source.drifted;
  target.missing += source.missing;
  target.blocked += source.blocked;
}

function collectArtifactSecretRefs(
  entries: { artifactIds: string[]; secretRefs?: string[] }[],
  artifactId: string,
): string[] {
  const refs = new Set<string>();
  for (const entry of entries) {
    if (!entry.artifactIds.includes(artifactId)) continue;
    for (const ref of entry.secretRefs ?? []) refs.add(ref);
  }
  return [...refs].sort();
}

function statusMatchesArtifact(item: StatusItem, artifactId: string): boolean {
  return expandConcreteArtifactIdentities(item.artifact).includes(artifactId);
}

function expandConcreteArtifactIdentities(identity: string): string[] {
  const parts = identity.split(",").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => !isConcreteArtifactId(part))) return [];
  return [...new Set(parts)];
}

function isConcreteArtifactId(value: string): boolean {
  return /^(rules|mcp|skills)\/[^/*,\s]+$/.test(value);
}

function emptyCounts() {
  return {
    managed: 0,
    discovered: 0,
    synced: 0,
    drifted: 0,
    missing: 0,
    blocked: 0,
  };
}

export type ResourceCatalogCountsProducerContract = AssertExact<
  ExactContract<ReturnType<typeof emptyCounts>, ResourceCatalogCounts>
>;

function resourceSyncTarget(
  agent: string,
  destination: Destination,
  scope: Scope,
  target: string,
  state: "synced" | "drifted" | "missing" | "blocked",
  reason?: string,
) {
  const optionalReason: { reason?: string } = reason === undefined ? {} : { reason };
  return { agent, destination, scope, target, state, ...optionalReason };
}

export type ResourceSyncTargetProducerContract = AssertExact<
  ExactContract<ReturnType<typeof resourceSyncTarget>, ResourceSyncTarget>
>;

function discoveredDescriptor(agent: string, destination: Destination, source: string) {
  return { agent, destination, source };
}

export type DiscoveredResourceProducerContract = AssertExact<
  ExactContract<
    ReturnType<typeof discoveredDescriptor>,
    NonNullable<ResourceCatalogItem["discovered"]>
  >
>;

function destinationToScope(destination: Destination | undefined): Scope | undefined {
  if (!destination) return undefined;
  return destination === "project" ? "project" : "global";
}

function scopeToDestination(scope: Scope): Destination {
  return scope === "project" ? "project" : "user";
}

function statusToResourceState(
  status: DriftStatus,
): Exclude<ResourceState, "managed" | "discovered"> {
  if (status === "ok") return "synced";
  if (status === "broken-link") return "missing";
  return status;
}
