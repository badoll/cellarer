import { listActivity } from "./activity.js";
import { loadRegistry } from "./adapters/registry.js";
import { type AgentDoctorReport, doctor } from "./diagnostics.js";
import { inCollections, plan } from "./engine/plan.js";
import { status } from "./engine/status.js";
import type { DistributeOptions, StatusItem } from "./engine/types.js";
import type { Env } from "./env.js";
import type { Capability, Scope } from "./model/index.js";
import type {
  AssertExact,
  DashboardAgentReadiness,
  DashboardCapabilityReadiness,
  DashboardCoverageGroup,
  DashboardDriftCounts,
  DashboardSummaryResult,
  ExactContract,
  ExactMutableContract,
} from "./protocol/client-types.js";
import { loadConfig } from "./store/config.js";
import { collectLedgerSecretRefStats, entryKey, loadLedger } from "./store/ledger.js";
import { listMcpArtifacts, listRuleArtifacts, listSkillArtifacts } from "./store/store.js";

const DASHBOARD_CAPABILITIES: Capability[] = ["rules", "mcp", "skills"];

export type {
  AgentReadinessState,
  DashboardAgentCounts,
  DashboardAgentReadiness,
  DashboardArtifactCounts,
  DashboardCapabilityReadiness,
  DashboardCoverageGroup,
  DashboardDriftCounts,
  DashboardSecretRefStat,
  DashboardSummaryResult,
} from "./protocol/client-types.js";

export interface DashboardSummaryOptions {
  storeRoot: string;
  scope?: Scope;
  dir?: string;
  agents?: string[];
  collections?: string[];
  capabilities?: Capability[];
  activityLimit?: number;
  includePlanCoverage?: boolean;
}

interface ArtifactLike {
  id: string;
  kind: Capability;
  collections: string[];
}

async function dashboardSummaryImplementation(env: Env, opts: DashboardSummaryOptions) {
  const scope = opts.scope ?? "global";
  const capabilities = opts.capabilities ?? DASHBOARD_CAPABILITIES;
  const [config, registry, ledger, ruleArtifacts, mcpArtifacts, skillArtifacts, statusItems] =
    await Promise.all([
      loadConfig(env, opts.storeRoot),
      loadRegistry(env, opts.storeRoot),
      loadLedger(env, opts.storeRoot),
      listRuleArtifacts(env, opts.storeRoot),
      listMcpArtifacts(env, opts.storeRoot),
      listSkillArtifacts(env, opts.storeRoot),
      status(env, { storeRoot: opts.storeRoot }),
    ]);

  const tag = (id: string): string[] => config.artifacts[id]?.collections ?? [];
  const artifacts: ArtifactLike[] = [
    ...ruleArtifacts.map((artifact) => ({
      ...artifact,
      kind: "rules" as const,
      collections: tag(artifact.id),
    })),
    ...mcpArtifacts.map((artifact) => ({
      ...artifact,
      kind: "mcp" as const,
      collections: tag(artifact.id),
    })),
    ...skillArtifacts.map((artifact) => ({
      ...artifact,
      kind: "skills" as const,
      collections: tag(artifact.id),
    })),
  ];
  const enabledAgentIds = registry
    .list()
    .filter((agent) => config.adapterOverrides[agent.id]?.enabled !== false)
    .map((agent) => agent.id);
  const selectedAgents = opts.agents && opts.agents.length > 0 ? opts.agents : enabledAgentIds;
  const collections = dashboardCollections(
    config.defaults.collections,
    Object.keys(config.collections),
    artifacts,
    opts.collections,
  );

  const doctorReport = await doctor(env, {
    storeRoot: opts.storeRoot,
    scope,
    dir: opts.dir,
    agents: selectedAgents,
  });
  const agents = doctorReport.agents.map(agentReadiness);
  const activity = await listActivity(env, opts.storeRoot, { limit: opts.activityLimit ?? 8 });
  const coverage =
    opts.includePlanCoverage === false
      ? []
      : await coverageGroups(
          env,
          opts,
          selectedAgents,
          collections,
          capabilities,
          artifacts,
          statusItems,
          ledger.owners,
        );

  const artifactCounts = {
    rules: ruleArtifacts.length,
    mcp: mcpArtifacts.length,
    skills: skillArtifacts.length,
    total: ruleArtifacts.length + mcpArtifacts.length + skillArtifacts.length,
  };
  const driftCounts = driftCount(statusItems);
  const warnings = [...doctorReport.warnings, ...activity.warnings];
  const optionalDir: { dir?: string } = { dir: opts.dir };
  const latestScan = activity.events.find((event) => event.action === "scan-import");
  const optionalLatestScan: { latestScanSummary?: (typeof activity.events)[number] } = {
    latestScanSummary: latestScan,
  };

  return {
    generatedAt: env.now().toISOString(),
    localSafety: {
      localOnly: true as const,
      host: "127.0.0.1" as const,
      database: false as const,
      secrets: "masked" as const,
    },
    scope,
    ...optionalDir,
    collections,
    capabilities,
    artifactCounts,
    agentCounts: {
      registered: registry.list().length,
      detected: agents.filter((agent) => agent.detected).length,
      ready: agents.filter((agent) => agent.status === "ready").length,
      warning: agents.filter((agent) => agent.status === "warning").length,
      missing: agents.filter((agent) => agent.status === "not-found").length,
    },
    driftCounts,
    secretRefs: collectLedgerSecretRefStats(ledger),
    isEmptyStore: artifactCounts.total === 0 && ledger.owners.length === 0,
    agents,
    distributionCoverage: coverage,
    driftItems: statusItems.filter((item) => item.status !== "ok"),
    latestActivity: activity.events,
    ...optionalLatestScan,
    warnings,
  };
}

export async function dashboardSummary(
  env: Env,
  opts: DashboardSummaryOptions,
): Promise<DashboardSummaryResult> {
  return dashboardSummaryImplementation(env, opts);
}

export type DashboardSummaryProducerContract = AssertExact<
  ExactContract<Awaited<ReturnType<typeof dashboardSummaryImplementation>>, DashboardSummaryResult>
>;

function dashboardCollections(
  defaults: string[],
  configured: string[],
  artifacts: ArtifactLike[],
  explicit: string[] | undefined,
): string[] {
  if (explicit && explicit.length > 0) return [...new Set(explicit)];
  const used = artifacts.flatMap((artifact) => artifact.collections);
  const collections = [...new Set([...configured, ...used])];
  return collections.length > 0 ? collections : defaults;
}

function agentReadiness(agent: AgentDoctorReport) {
  const capabilityRows = DASHBOARD_CAPABILITIES.map((capability) =>
    capabilityReadiness(agent, capability),
  );
  const warnings = [
    ...agent.warnings,
    ...agent.checks.filter((check) => check.status !== "ok").map((check) => check.message),
  ];
  const statusState = (
    !agent.enabled
      ? "disabled"
      : !agent.detected
        ? "not-found"
        : agent.supportedCapabilities.length === 0
          ? "unsupported"
          : warnings.length > 0
            ? "warning"
            : "ready"
  ) as ProducedAgentReadinessState;
  const baselineRoot: { root?: string } = { root: agent.root };
  return {
    id: agent.id,
    displayName: agent.displayName,
    enabled: agent.enabled,
    scope: agent.scope,
    ...baselineRoot,
    detected: agent.detected,
    status: statusState,
    supportedCapabilities: agent.supportedCapabilities,
    capabilities: capabilityRows,
    warnings,
  };
}

export type DashboardAgentReadinessProducerContract = AssertExact<
  ExactMutableContract<ReturnType<typeof agentReadiness>, DashboardAgentReadiness>
>;

function capabilityReadiness(agent: AgentDoctorReport, capability: Capability) {
  const supported = agent.supportedCapabilities.includes(capability);
  const checks = agent.checks.filter((check) => check.id === `${agent.id}.${capability}.writable`);
  const warnings = checks.filter((check) => check.status !== "ok").map((check) => check.message);
  const status: ProducedCapabilityReadinessState = !supported
    ? "unsupported"
    : warnings.length > 0
      ? "warning"
      : "ready";
  return { capability, status, paths: targetPaths(agent, capability), warnings };
}

export type DashboardCapabilityReadinessProducerContract = AssertExact<
  ExactContract<ReturnType<typeof capabilityReadiness>, DashboardCapabilityReadiness>
>;

type ProducedAgentReadinessState =
  | "disabled"
  | "not-found"
  | "detected"
  | "ready"
  | "warning"
  | "unsupported";
type ProducedCapabilityReadinessState = "ready" | "warning" | "unsupported";

function targetPaths(agent: AgentDoctorReport, capability: Capability): string[] {
  if (capability === "rules" && agent.paths.rules) return [agent.paths.rules];
  if (capability === "mcp" && agent.paths.mcp) return [agent.paths.mcp];
  if (capability === "skills" && agent.paths.skillsDir) return [agent.paths.skillsDir];
  return [];
}

async function coverageGroups(
  env: Env,
  opts: DashboardSummaryOptions,
  agents: string[],
  collections: string[],
  capabilities: Capability[],
  artifacts: ArtifactLike[],
  statusItems: StatusItem[],
  ledgerEntries: {
    artifactIds: string[];
    agent: string;
    scope: Scope;
    target: string;
    receipt: { appliedAt: string };
  }[],
) {
  const scopes: Scope[] = opts.dir ? ["global", "project"] : ["global"];
  const groups: ReturnType<typeof coverageGroup>[] = [];
  for (const collection of collections) {
    for (const scope of scopes) {
      const p = await plan(env, {
        storeRoot: opts.storeRoot,
        scope,
        dir: scope === "project" ? opts.dir : undefined,
        agents,
        collections: [collection],
        capabilities,
        secretMode: "env",
        dryRun: true,
      } satisfies DistributeOptions);
      const desired = p.actions.filter((action) => {
        if (action.op !== "skip") return true;
        return !/not supported|capability .* not supported/.test(action.reason ?? "");
      });
      const nonSkip = desired.filter((action) => action.op !== "skip");
      const statusByKey = new Map(
        statusItems.map((item) => [statusIdentityKey(item), item.status]),
      );
      let appliedCount = 0;
      let driftedCount = 0;
      let missingCount = 0;
      let brokenLinkCount = 0;
      const blockedCount = desired.filter((action) => action.op === "skip").length;
      for (const action of nonSkip) {
        const state = statusByKey.get(entryKey(action));
        if (state === "ok") appliedCount += 1;
        else if (state === "drifted") driftedCount += 1;
        else if (state === "missing") missingCount += 1;
        else if (state === "broken-link") brokenLinkCount += 1;
      }
      const desiredCount = desired.length;
      const percentage = desiredCount > 0 ? Math.round((appliedCount / desiredCount) * 100) : null;
      const artifactIds = artifacts
        .filter(
          (artifact) =>
            capabilities.includes(artifact.kind) &&
            inCollections(artifact.collections, [collection]),
        )
        .map((artifact) => artifact.id);
      const lastAppliedAt = latestAppliedAt(ledgerEntries, collection, scope, artifacts);
      groups.push(
        coverageGroup({
          collection,
          scope,
          percentage,
          appliedCount,
          desiredCount,
          driftedCount,
          missingCount,
          brokenLinkCount,
          blockedCount,
          targetsCount: new Set(nonSkip.map((action) => action.target)).size,
          artifactsCount: artifactIds.length,
          lastAppliedAt,
          emptyReason:
            desiredCount === 0
              ? "No supported desired units for this collection and scope."
              : undefined,
        }),
      );
    }
  }
  return groups;
}

export type DashboardCoverageProducerContract = AssertExact<
  ExactContract<ReturnType<typeof coverageGroup>, DashboardCoverageGroup>
>;

function coverageGroup(input: {
  collection: string;
  scope: Scope;
  percentage: number | null;
  appliedCount: number;
  desiredCount: number;
  driftedCount: number;
  missingCount: number;
  brokenLinkCount: number;
  blockedCount: number;
  targetsCount: number;
  artifactsCount: number;
  lastAppliedAt?: string;
  emptyReason?: string;
}) {
  return { ...input };
}

function latestAppliedAt(
  entries: { artifactIds: string[]; scope: Scope; receipt: { appliedAt: string } }[],
  collection: string,
  scope: Scope,
  artifacts: ArtifactLike[],
): string | undefined {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const times = entries
    .filter((entry) => entry.scope === scope)
    .filter((entry) => {
      return entry.artifactIds.some((id) => {
        const artifact = byId.get(id);
        return artifact ? inCollections(artifact.collections, [collection]) : false;
      });
    })
    .map((entry) => entry.receipt.appliedAt)
    .sort();
  return times.at(-1);
}

function driftCount(items: StatusItem[]) {
  const counts = { ok: 0, drifted: 0, missing: 0, "broken-link": 0 };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

export type DashboardDriftCountsProducerContract = AssertExact<
  ExactContract<ReturnType<typeof driftCount>, DashboardDriftCounts>
>;

export function statusIdentityKey(
  item: Pick<StatusItem, "agent" | "scope" | "capability" | "target">,
): string {
  return entryKey(item);
}
