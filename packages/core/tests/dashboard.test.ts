import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dashboardSummary,
  initStore,
  saveLedger,
  writeMcpArtifact,
  writeRuleArtifact,
} from "../src/index.js";
import { tagArtifactCollections } from "../src/store/config.js";
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

  it("reports secret reference counts by ledger entry", async () => {
    await saveLedger(t.env, storeRoot, {
      version: 1,
      entries: [
        {
          artifact: "mcp/ctx",
          agent: "codex",
          scope: "global",
          capability: "mcp",
          target: t.path("home", ".codex", "config.toml"),
          method: "write",
          checksum: "sha256:1",
          backup: null,
          generated: false,
          appliedAt: "2026-06-30T08:00:00.000Z",
          secretRefs: ["API_KEY", "API_KEY"],
        },
        {
          artifact: "mcp/db",
          agent: "codex",
          scope: "global",
          capability: "mcp",
          target: t.path("home", ".codex", "db.toml"),
          method: "write",
          checksum: "sha256:2",
          backup: null,
          generated: false,
          appliedAt: "2026-06-30T08:01:00.000Z",
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
