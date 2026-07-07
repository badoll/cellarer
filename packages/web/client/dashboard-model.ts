import type { Capability, Scope } from "@cellarer/core";

export const DASHBOARD_CAPABILITIES: Capability[] = ["rules", "mcp", "skills"];

export type DriftStatus = "ok" | "drifted" | "missing" | "broken-link";
export type MatrixCellState =
  | "applied"
  | "pending"
  | "partial"
  | "drifted"
  | "missing"
  | "broken-link"
  | "unsupported"
  | "skipped"
  | "empty";

export interface ArtifactRow {
  id: string;
  name: string;
  collections: string[];
}

export interface ArtifactsResponse {
  rules: ArtifactRow[];
  mcp: ArtifactRow[];
  skills: ArtifactRow[];
  collections: string[];
}

export interface AgentInfo {
  id: string;
  displayName: string;
  capabilities: Partial<Record<Capability, Scope[] | string[]>>;
  detected: boolean;
  root: string;
}

export interface StatusItem {
  artifact: string;
  agent: string;
  scope: Scope;
  capability: Capability;
  target: string;
  status: DriftStatus;
}

export interface PlanAction {
  artifact?: string;
  agent: string;
  capability: Capability;
  scope: Scope;
  target: string;
  op: string;
  reason?: string;
}

export interface DashboardSummary {
  artifactTotal: number;
  artifactCounts: Record<Capability, number>;
  detectedAgentCount: number;
  registeredAgentCount: number;
  driftItemCount: number;
  ledgerEntryCount: number;
  secretRefCount: number;
  isEmptyStore: boolean;
}

export interface MatrixColumn {
  id: string;
  agentId: string;
  agentName: string;
  scope: Scope;
}

export interface MatrixCell {
  state: MatrixCellState;
  count: number;
  details: MatrixCellState[];
}

export interface MatrixRow {
  capability: Capability;
  cells: Record<string, MatrixCell>;
}

export interface DistributionMatrix {
  columns: MatrixColumn[];
  rows: MatrixRow[];
}

const SCOPE_ORDER: Scope[] = ["global", "project"];

export function buildDashboardSummary(args: {
  artifacts: ArtifactsResponse;
  agents: AgentInfo[];
  statusItems: StatusItem[];
  secretNames: string[];
}): DashboardSummary {
  const artifactCounts = {
    rules: args.artifacts.rules.length,
    mcp: args.artifacts.mcp.length,
    skills: args.artifacts.skills.length,
  };
  const artifactTotal = artifactCounts.rules + artifactCounts.mcp + artifactCounts.skills;
  const ledgerEntryCount = args.statusItems.length;
  return {
    artifactTotal,
    artifactCounts,
    detectedAgentCount: args.agents.filter((agent) => agent.detected).length,
    registeredAgentCount: args.agents.length,
    driftItemCount: args.statusItems.filter((item) => item.status !== "ok").length,
    ledgerEntryCount,
    secretRefCount: args.secretNames.length,
    isEmptyStore: artifactTotal === 0 && ledgerEntryCount === 0,
  };
}

export function buildDistributionMatrix(args: {
  agents: AgentInfo[];
  statusItems: StatusItem[];
  planActions?: PlanAction[];
}): DistributionMatrix {
  const planActions = args.planActions ?? [];
  const columns = args.agents.flatMap((agent) =>
    scopesForAgent(agent, args.statusItems, planActions).map((scope) => ({
      id: matrixColumnId(agent.id, scope),
      agentId: agent.id,
      agentName: agent.displayName,
      scope,
    })),
  );

  return {
    columns,
    rows: DASHBOARD_CAPABILITIES.map((capability) => ({
      capability,
      cells: Object.fromEntries(
        columns.map((column) => [
          column.id,
          matrixCell({
            agent: args.agents.find((candidate) => candidate.id === column.agentId),
            capability,
            scope: column.scope,
            statusItems: args.statusItems,
            planActions,
          }),
        ]),
      ),
    })),
  };
}

export function matrixColumnId(agentId: string, scope: Scope): string {
  return `${agentId}:${scope}`;
}

function scopesForAgent(
  agent: AgentInfo,
  statusItems: StatusItem[],
  planActions: PlanAction[],
): Scope[] {
  const scopes = new Set<Scope>();
  for (const capability of DASHBOARD_CAPABILITIES) {
    for (const scope of capabilityScopes(agent, capability)) scopes.add(scope);
  }
  for (const item of statusItems) {
    if (item.agent === agent.id) scopes.add(item.scope);
  }
  for (const action of planActions) {
    if (action.agent === agent.id) scopes.add(action.scope);
  }
  if (scopes.size === 0) scopes.add("global");
  return SCOPE_ORDER.filter((scope) => scopes.has(scope));
}

function matrixCell(args: {
  agent: AgentInfo | undefined;
  capability: Capability;
  scope: Scope;
  statusItems: StatusItem[];
  planActions: PlanAction[];
}): MatrixCell {
  const statusStates = args.statusItems
    .filter(
      (item) =>
        item.agent === args.agent?.id &&
        item.scope === args.scope &&
        item.capability === args.capability,
    )
    .map(statusToCellState);
  const planStates = args.planActions
    .filter(
      (action) =>
        action.agent === args.agent?.id &&
        action.scope === args.scope &&
        action.capability === args.capability,
    )
    .map((action) => (action.op === "skip" ? "skipped" : "pending") satisfies MatrixCellState);

  const realStates = [...statusStates, ...planStates];
  if (realStates.length === 0) {
    return {
      state:
        args.agent && supportsCapability(args.agent, args.capability, args.scope)
          ? "empty"
          : "unsupported",
      count: 0,
      details: [],
    };
  }

  const uniqueStates = [...new Set(realStates)];
  return {
    state: uniqueStates.length === 1 ? uniqueStates[0] : "partial",
    count: realStates.length,
    details: uniqueStates,
  };
}

function statusToCellState(item: StatusItem): MatrixCellState {
  if (item.status === "ok") return "applied";
  return item.status;
}

function supportsCapability(agent: AgentInfo, capability: Capability, scope: Scope): boolean {
  return capabilityScopes(agent, capability).includes(scope);
}

function capabilityScopes(agent: AgentInfo, capability: Capability): Scope[] {
  return (agent.capabilities[capability] ?? []).filter(isScope);
}

function isScope(value: string): value is Scope {
  return value === "global" || value === "project";
}
