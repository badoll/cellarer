import { apply, dashboardSummary } from "@cellarer/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../../core/src/store/config.js";
import { initStore, writeRuleArtifact } from "../../core/src/store/store.js";
import { ensureBaseDirs, makeTmpEnv } from "../../core/tests/helpers/env.js";
import { CoverageList } from "../client/App.js";
import {
  type AgentInfo,
  type ArtifactsResponse,
  buildDashboardSummary,
  buildDistributionMatrix,
  type PlanAction,
  type StatusItem,
} from "../client/dashboard-model.js";
import {
  configurationLabel,
  destinationLabel,
  resourceKindLabel,
  summarizeResourceCounts,
} from "../client/product-model.js";

const emptyArtifacts: ArtifactsResponse = {
  rules: [],
  mcp: [],
  skills: [],
  collections: [],
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

describe("product model helpers", () => {
  it("presents the Core configuration outcome without treating empty or partial coverage as healthy", () => {
    expect(configurationLabel("incomplete")).toBe("Configuration incomplete");
    expect(configurationLabel("no-op")).toBe("No resources to verify");
    expect(configurationLabel("healthy")).toBe("Configuration healthy");
    expect(configurationLabel("unhealthy")).toBe("Configuration unhealthy");
  });

  it("labels destinations with user-facing language", () => {
    expect(destinationLabel("user")).toBe("User-level");
    expect(destinationLabel("project")).toBe("Project-level");
  });

  it("labels resource kinds", () => {
    expect(resourceKindLabel("skills")).toBe("Skills");
    expect(resourceKindLabel("mcp")).toBe("MCP");
    expect(resourceKindLabel("rules")).toBe("Rules");
  });

  it("summarizes resource state counts", () => {
    expect(
      summarizeResourceCounts([{ state: "managed" }, { state: "managed" }, { state: "drifted" }]),
    ).toEqual({
      managed: 2,
      discovered: 0,
      synced: 0,
      drifted: 1,
      missing: 0,
      blocked: 0,
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

describe("Core-backed coverage cards", () => {
  it("renders no-op, healthy, and disabled coverage with independent runtime evidence", async () => {
    const t = makeTmpEnv();
    try {
      await ensureBaseDirs(t);
      const storeRoot = t.path("home", ".cellarer");
      await initStore(t.env, storeRoot);
      const options = {
        storeRoot,
        scope: "global" as const,
        agents: ["claude-code"],
        capabilities: ["rules" as const],
      };
      const render = async () => {
        const summary = await dashboardSummary(t.env, options);
        return {
          group: summary.distributionCoverage[0],
          html: renderToStaticMarkup(
            createElement(CoverageList, { groups: summary.distributionCoverage }),
          ),
        };
      };
      const empty = await render();
      expect(empty.group).toMatchObject({
        configuration: "no-op",
        coverage: { expected: 1, observed: 1, complete: true },
      });
      expect(empty.html).toContain("No resources to verify");
      expect(empty.html).toContain("Native Agent loading: unknown");
      await writeRuleArtifact(t.env, storeRoot, "style", "Be clear");
      await apply(t.env, options);
      const healthy = await render();
      expect(healthy.group).toMatchObject({ configuration: "healthy", percentage: 100 });
      expect(healthy.html).toContain("Configuration healthy");
      const config = await loadConfig(t.env, storeRoot);
      config.adapterOverrides["claude-code"] = { enabled: false };
      await saveConfig(t.env, storeRoot, config);
      const disabled = await render();
      expect(disabled.group).toMatchObject({
        configuration: "incomplete",
        coverage: { expected: 1, observed: 0, complete: false },
      });
      expect(disabled.html).toContain("Configuration incomplete");
      expect(disabled.html).toContain("AGENT_DISABLED");
      expect(disabled.html).not.toContain("Configuration healthy");
    } finally {
      await t.cleanup();
    }
  });
});
