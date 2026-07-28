import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverySummary } from "../src/index.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("discovery summary", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });

  afterEach(() => t.cleanup());

  it("counts discovered agent-native resources without importing them", async () => {
    await t.env.fs.mkdir(t.path("home", ".codex", "skills", "study"), { recursive: true });
    await t.env.fs.writeFile(t.path("home", ".codex", "AGENTS.md"), "# user rules");
    await t.env.fs.writeFile(
      t.path("home", ".codex", "config.toml"),
      `[mcp_servers.ctx]\ncommand = "npx"\n`,
    );

    const summary = await discoverySummary(t.env, {
      storeRoot,
      agents: ["codex"],
      destination: "user",
    });

    expect(summary.agents).toContainEqual(
      expect.objectContaining({
        agent: "codex",
        detected: true,
        counts: { rules: 1, mcp: 1, skills: 1 },
      }),
    );
    expect(summary.totals).toEqual({ rules: 1, mcp: 1, skills: 1 });
  });

  it("returns project discovery only when a project dir is provided", async () => {
    const project = t.path("project");
    await t.env.fs.mkdir(project, { recursive: true });
    await t.env.fs.writeFile(t.path("project", "AGENTS.md"), "# project rules");

    const summary = await discoverySummary(t.env, {
      storeRoot,
      agents: ["codex"],
      destination: "project",
      dir: project,
    });

    expect(summary.totals.rules).toBe(1);
  });
});
