import { listActivity } from "../activity.js";
import type { Env } from "../env.js";
import { inCollections } from "../engine/plan.js";
import { status } from "../engine/status.js";
import type { DriftStatus, StatusItem } from "../engine/types.js";
import type { Capability, Collection, Scope } from "../model/index.js";
import { scanTextForSecrets } from "../secrets/detector.js";
import { loadConfig } from "../store/config.js";
import { loadLedger } from "../store/ledger.js";
import {
  listMcpArtifacts,
  listRuleArtifacts,
  listSkillArtifacts,
  skillProvenancePath,
} from "../store/store.js";

export type ResourceState =
  | "managed"
  | "discovered"
  | "synced"
  | "drifted"
  | "missing"
  | "blocked";

export type Destination = "user" | "project";

export interface ResourceSyncTarget {
  agent: string;
  destination: Destination;
  scope: Scope;
  target: string;
  state: Exclude<ResourceState, "managed" | "discovered">;
  reason?: string;
}

export interface ResourceCatalogItem {
  id: string;
  kind: Capability;
  name: string;
  state: ResourceState;
  collections: Collection[];
  sourcePath?: string;
  provenance?: {
    source?: string;
    resolvedUrl?: string;
    ref?: string | null;
    commit?: string | null;
  };
  discovered?: {
    agent: string;
    destination: Destination;
    source: string;
  };
  syncTargets: ResourceSyncTarget[];
  secretRefs: string[];
  lastActivityAt?: string;
}

export interface ResourceCatalogCounts {
  managed: number;
  discovered: number;
  synced: number;
  drifted: number;
  missing: number;
  blocked: number;
}

export interface ResourceCatalogOptions {
  storeRoot: string;
  kind?: Capability;
  agents?: string[];
  collections?: string[];
  destination?: Destination;
  dir?: string;
  includeDiscovered?: boolean;
}

export interface ResourceCatalogResult {
  generatedAt: string;
  resources: ResourceCatalogItem[];
  counts: ResourceCatalogCounts;
  warnings: string[];
}

export async function resourceCatalog(
  env: Env,
  opts: ResourceCatalogOptions,
): Promise<ResourceCatalogResult> {
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
    for (const artifactIdentity of event.references?.artifactIds ?? []) {
      for (const artifactId of expandConcreteArtifactIdentities(artifactIdentity)) {
        if (!lastActivityByArtifact.has(artifactId)) lastActivityByArtifact.set(artifactId, event.time);
      }
    }
  }

  const allArtifacts = [...ruleArtifacts, ...mcpArtifacts, ...skillArtifacts];
  const filteredArtifacts = allArtifacts.filter((artifact) => {
    if (opts.kind && artifact.kind !== opts.kind) return false;
    const collections = config.artifacts[artifact.id]?.collections ?? [];
    if (opts.collections && opts.collections.length > 0) {
      return inCollections(collections, opts.collections);
    }
    return true;
  });

  const resources: ResourceCatalogItem[] = [];
  for (const artifact of filteredArtifacts) {
    const collections = config.artifacts[artifact.id]?.collections ?? [];
    const syncTargets = statusItems
      .filter((item) => statusMatchesArtifact(item, artifact.id))
      .map((item) => ({
        agent: item.agent,
        destination: scopeToDestination(item.scope),
        scope: item.scope,
        target: item.target,
        state: statusToResourceState(item.status),
      }));

    counts.managed += 1;
    for (const target of syncTargets) counts[target.state] += 1;

    resources.push({
      id: artifact.id,
      kind: artifact.kind,
      name: artifact.name,
      state: "managed",
      collections,
      sourcePath: artifact.sourcePath,
      provenance:
        artifact.kind === "skills" ? await readSkillProvenance(env, opts.storeRoot, artifact.name) : undefined,
      syncTargets,
      secretRefs: collectArtifactSecretRefs(ledger.entries, artifact.id),
      lastActivityAt: lastActivityByArtifact.get(artifact.id),
    });
  }

  return {
    generatedAt: env.now().toISOString(),
    resources,
    counts,
    warnings,
  };
}

function collectArtifactSecretRefs(
  entries: { artifact: string; secretRefs?: string[] }[],
  artifactId: string,
): string[] {
  const refs = new Set<string>();
  for (const entry of entries) {
    if (!expandConcreteArtifactIdentities(entry.artifact).includes(artifactId)) continue;
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

function emptyCounts(): ResourceCatalogCounts {
  return {
    managed: 0,
    discovered: 0,
    synced: 0,
    drifted: 0,
    missing: 0,
    blocked: 0,
  };
}

function destinationToScope(destination: Destination | undefined): Scope | undefined {
  if (!destination) return undefined;
  return destination === "project" ? "project" : "global";
}

function scopeToDestination(scope: Scope): Destination {
  return scope === "project" ? "project" : "user";
}

function statusToResourceState(status: DriftStatus): Exclude<ResourceState, "managed" | "discovered"> {
  if (status === "ok") return "synced";
  if (status === "broken-link") return "missing";
  return status;
}

async function readSkillProvenance(
  env: Env,
  storeRoot: string,
  name: string,
): Promise<ResourceCatalogItem["provenance"] | undefined> {
  const path = skillProvenancePath(storeRoot, name);
  try {
    const raw = await env.fs.readFile(path);
    const parsed = JSON.parse(raw) as {
      source?: string;
      resolvedUrl?: string;
      ref?: string | null;
      commit?: string | null;
    };
    return {
      source: sanitizeOptionalString(parsed.source),
      resolvedUrl: sanitizeOptionalString(parsed.resolvedUrl),
      ref: parsed.ref ?? null,
      commit: parsed.commit ?? null,
    };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw err;
  }
}

function sanitizeOptionalString(value: string | undefined): string | undefined {
  if (!value) return value;
  return scanTextForSecrets(value).length > 0 ? "[redacted secret]" : value;
}
