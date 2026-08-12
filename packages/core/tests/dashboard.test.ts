import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planActionPresentationClass } from "../src/engine/plan-presentation.js";
import { dashboardSummary } from "../src/index.js";
import type { PlanAction } from "../src/model/index.js";
import { loadConfig, saveConfig, tagArtifactCollections } from "../src/store/config.js";
import { saveLedger } from "../src/store/ledger.js";
import { initStore, writeMcpArtifact, writeRuleArtifact } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("dashboard summary", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });
  afterEach(() => t.cleanup());

  it("summarizes an empty store without fake coverage percentages", async () => {
    const summary = await dashboardSummary(t.env, {
      storeRoot,
      agents: ["codex"],
      capabilities: ["rules"],
    });

    expect(summary.isEmptyStore).toBe(true);
    expect(summary.artifactCounts.total).toBe(0);
    expect(summary.distributionCoverage).toContainEqual(
      expect.objectContaining({
        scope: "global",
        percentage: null,
        desiredCount: 0,
      }),
    );
    expect(Object.hasOwn(summary, "latestScanSummary")).toBe(true);
    expect(summary.latestScanSummary).toBeUndefined();
  });

  it("requires an explicit project dir before including project coverage", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    const globalOnly = await dashboardSummary(t.env, {
      storeRoot,
      agents: ["codex"],
      capabilities: ["rules"],
    });
    const project = t.path("project");
    await t.env.fs.mkdir(project, { recursive: true });
    const withProject = await dashboardSummary(t.env, {
      storeRoot,
      dir: project,
      agents: ["codex"],
      capabilities: ["rules"],
    });

    expect(new Set(globalOnly.distributionCoverage.map((group) => group.scope))).toEqual(
      new Set(["global"]),
    );
    expect(new Set(withProject.distributionCoverage.map((group) => group.scope))).toEqual(
      new Set(["global", "project"]),
    );
  });

  it("excludes unsupported capability cells from the coverage denominator", async () => {
    await writeMcpArtifact(t.env, storeRoot, "ctx", { kind: "stdio", command: "npx" });

    const summary = await dashboardSummary(t.env, {
      storeRoot,
      agents: ["agents-md"],
      capabilities: ["mcp"],
    });

    expect(summary.distributionCoverage[0]).toMatchObject({
      desiredCount: 0,
      percentage: null,
    });
  });

  it("keeps unsupported classification stable across action copies and serialization", () => {
    const action: PlanAction = {
      artifact: "mcp/*",
      artifactIds: [],
      agent: "agents-md",
      scope: "global",
      capability: "mcp",
      target: "",
      method: "symlink",
      op: "skip",
      reason: "capability mcp/global not supported",
    };
    const classified = action;
    const supportedScopes: readonly PlanAction["scope"][] = [];

    expect([
      planActionPresentationClass(classified, supportedScopes),
      planActionPresentationClass({ ...classified }, supportedScopes),
      planActionPresentationClass(structuredClone(classified), supportedScopes),
    ]).toEqual(["unsupported", "unsupported", "unsupported"]);
  });

  it("keeps coverage classification stable when only a blocked reason wording changes", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    const config = await loadConfig(t.env, storeRoot);
    config.customAdapters.wording = {
      rules: { global: "../not supported/reason.md" },
      capabilities: { rules: ["global"], mcp: [], skills: [] },
    };
    await saveConfig(t.env, storeRoot, config);

    const before = await dashboardSummary(t.env, {
      storeRoot,
      agents: ["wording"],
      capabilities: ["rules"],
    });
    const changed = await loadConfig(t.env, storeRoot);
    const wording = changed.customAdapters.wording;
    if (!wording?.rules) throw new Error("missing wording adapter");
    wording.rules.global = "../different presentation wording/reason.md";
    await saveConfig(t.env, storeRoot, changed);
    const after = await dashboardSummary(t.env, {
      storeRoot,
      agents: ["wording"],
      capabilities: ["rules"],
    });

    const presentation = (summary: typeof before) => {
      const group = summary.distributionCoverage[0];
      return {
        desiredCount: group?.desiredCount,
        blockedCount: group?.blockedCount,
        percentage: group?.percentage,
      };
    };
    expect(presentation(before)).toEqual({
      desiredCount: 1,
      blockedCount: 1,
      percentage: 0,
    });
    expect(presentation(after)).toEqual(presentation(before));
  });

  it("reports secret reference counts by ledger entry", async () => {
    await saveLedger(t.env, storeRoot, {
      version: 2,
      owners: [
        {
          agent: "codex",
          scope: "global",
          capability: "mcp",
          target: t.path("home", ".codex", "config.toml"),
          artifactIds: ["mcp/ctx"],
          receipt: {
            method: "write",
            fingerprint: "sha256:1",
            backup: null,
            generated: false,
            appliedAt: "2026-06-30T08:00:00.000Z",
          },
          secretRefs: ["API_KEY", "API_KEY"],
        },
        {
          agent: "codex",
          scope: "global",
          capability: "mcp",
          target: t.path("home", ".codex", "db.toml"),
          artifactIds: ["mcp/db"],
          receipt: {
            method: "write",
            fingerprint: "sha256:2",
            backup: null,
            generated: false,
            appliedAt: "2026-06-30T08:01:00.000Z",
          },
          secretRefs: ["API_KEY"],
        },
      ],
    });

    const summary = await dashboardSummary(t.env, { storeRoot, agents: ["codex"] });

    expect(summary.secretRefs).toEqual([{ name: "API_KEY", ledgerEntryCount: 2 }]);
  });

  it("uses doctor-backed readiness states", async () => {
    await t.env.fs.mkdir(t.path("home", ".codex"), { recursive: true });

    const ready = await dashboardSummary(t.env, { storeRoot, agents: ["codex"] });
    const missing = await dashboardSummary(t.env, { storeRoot, agents: ["claude-code"] });

    expect(ready.agents[0]).toMatchObject({ id: "codex", status: "ready" });
    expect(missing.agents[0]).toMatchObject({ id: "claude-code", status: "not-found" });
  });

  it("retains the root own-key when agent detection cannot produce a root", async () => {
    const config = await loadConfig(t.env, storeRoot);
    config.customAdapters.broken = {
      detect: { project: ["~/.ssh"] },
      rules: { project: "{dir}/AGENTS.md" },
    };
    await saveConfig(t.env, storeRoot, config);
    const project = t.path("project");
    await t.env.fs.mkdir(project, { recursive: true });

    const summary = await dashboardSummary(t.env, {
      storeRoot,
      scope: "project",
      dir: project,
      agents: ["broken"],
      includePlanCoverage: false,
    });

    expect(summary.agents[0]?.root).toBeUndefined();
    expect(Object.hasOwn(summary.agents[0] ?? {}, "root")).toBe(true);
  });

  it("uses explicit collection filters for coverage groups", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await tagArtifactCollections(t.env, storeRoot, ["rules/style"], "internal");

    const summary = await dashboardSummary(t.env, {
      storeRoot,
      collections: ["internal"],
      agents: ["codex"],
      capabilities: ["rules"],
    });

    expect(summary.collections).toEqual(["internal"]);
    expect(summary.distributionCoverage.map((group) => group.collection)).toEqual(["internal"]);
    expect(summary.distributionCoverage[0]?.artifactsCount).toBe(1);
  });
});
