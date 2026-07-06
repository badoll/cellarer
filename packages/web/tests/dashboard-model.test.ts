import { describe, expect, it } from "vitest";
import {
  type AgentInfo,
  type ArtifactsResponse,
  buildDashboardSummary,
  buildDistributionMatrix,
  type PlanAction,
  type StatusItem,
} from "../client/dashboard-model.js";

const emptyArtifacts: ArtifactsResponse = {
  rules: [],
  mcp: [],
  skills: [],
  channels: [],
};

const codex: AgentInfo = {
  id: "codex",
  displayName: "Codex",
  detected: true,
  root: "/home/.codex",
  capabilities: {
    rules: ["global", "project"],
    mcp: ["global"],
    skills: ["global", "project"],
  },
};

const claude: AgentInfo = {
  id: "claude-code",
  displayName: "Claude Code",
  detected: false,
  root: "/home/.claude",
  capabilities: {
    rules: ["global", "project"],
    mcp: ["global", "project"],
    skills: ["global"],
  },
};

describe("dashboard model summary", () => {
  it("marks an empty store without treating missing data as drift", () => {
    const summary = buildDashboardSummary({
      artifacts: emptyArtifacts,
      agents: [codex, claude],
      statusItems: [],
      secretNames: [],
    });

    expect(summary).toMatchObject({
      artifactTotal: 0,
      detectedAgentCount: 1,
      registeredAgentCount: 2,
      driftItemCount: 0,
      ledgerEntryCount: 0,
      secretRefCount: 0,
      isEmptyStore: true,
    });
  });
});

describe("distribution matrix", () => {
  it("uses status ok as applied and supported empty cells as empty", () => {
    const matrix = buildDistributionMatrix({
      agents: [codex],
      statusItems: [status("codex", "rules", "global", "ok")],
    });

    expect(cell(matrix, "rules", "codex:global")).toMatchObject({
      state: "applied",
      count: 1,
    });
    expect(cell(matrix, "skills", "codex:project")).toMatchObject({
      state: "empty",
      count: 0,
    });
  });

  it("keeps drifted, missing, and broken-link states backed by status output", () => {
    const matrix = buildDistributionMatrix({
      agents: [codex],
      statusItems: [
        status("codex", "rules", "global", "drifted"),
        status("codex", "mcp", "global", "missing"),
        status("codex", "skills", "project", "broken-link"),
      ],
    });

    expect(cell(matrix, "rules", "codex:global").state).toBe("drifted");
    expect(cell(matrix, "mcp", "codex:global").state).toBe("missing");
    expect(cell(matrix, "skills", "codex:project").state).toBe("broken-link");
  });

  it("marks unsupported cells from adapter capability scopes", () => {
    const matrix = buildDistributionMatrix({
      agents: [codex],
      statusItems: [],
    });

    expect(cell(matrix, "mcp", "codex:project")).toMatchObject({
      state: "unsupported",
      count: 0,
    });
  });

  it("uses current dry-run plan actions for pending and skipped states", () => {
    const matrix = buildDistributionMatrix({
      agents: [codex],
      statusItems: [],
      planActions: [
        action("codex", "rules", "global", "write"),
        action("codex", "mcp", "global", "skip"),
      ],
    });

    expect(cell(matrix, "rules", "codex:global").state).toBe("pending");
    expect(cell(matrix, "mcp", "codex:global").state).toBe("skipped");
  });

  it("marks mixed real states as partial", () => {
    const matrix = buildDistributionMatrix({
      agents: [claude],
      statusItems: [
        status("claude-code", "rules", "global", "ok"),
        status("claude-code", "rules", "global", "drifted"),
      ],
      planActions: [action("claude-code", "rules", "global", "write")],
    });

    expect(cell(matrix, "rules", "claude-code:global")).toMatchObject({
      state: "partial",
      count: 3,
      details: ["applied", "drifted", "pending"],
    });
  });
});

function status(
  agent: string,
  capability: StatusItem["capability"],
  scope: StatusItem["scope"],
  driftStatus: StatusItem["status"],
): StatusItem {
  return {
    artifact: `${capability}/demo`,
    agent,
    capability,
    scope,
    target: `/tmp/${agent}/${capability}`,
    status: driftStatus,
  };
}

function action(
  agent: string,
  capability: PlanAction["capability"],
  scope: PlanAction["scope"],
  op: PlanAction["op"],
): PlanAction {
  return {
    agent,
    capability,
    scope,
    target: `/tmp/${agent}/${capability}`,
    op,
  };
}

function cell(
  matrix: ReturnType<typeof buildDistributionMatrix>,
  capability: StatusItem["capability"],
  columnId: string,
) {
  const row = matrix.rows.find((candidate) => candidate.capability === capability);
  if (!row) throw new Error(`missing row ${capability}`);
  const found = row.cells[columnId];
  if (!found) throw new Error(`missing cell ${columnId}`);
  return found;
}
