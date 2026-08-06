import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor, inspectAgents } from "../src/index.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

async function writeConfig(t: TmpEnv, config: unknown): Promise<string> {
  const storeRoot = t.path("home", ".cellarer");
  await t.env.fs.mkdir(storeRoot, { recursive: true });
  await t.env.fs.writeFile(join(storeRoot, "config.json"), JSON.stringify(config));
  return storeRoot;
}

describe("diagnostics", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
  });

  afterEach(() => t.cleanup());

  it("inspects default adapters with detect results, capabilities, and paths", async () => {
    await t.env.fs.mkdir(t.path("home", ".codex"), { recursive: true });

    const report = await inspectAgents(t.env, {
      storeRoot,
      scope: "global",
      agents: ["codex", "claude-code"],
    });

    expect(report.warnings).toEqual([]);
    expect(report.agents.map((agent) => agent.id)).toEqual(["codex", "claude-code"]);
    expect(report.agents.find((agent) => agent.id === "codex")).toMatchObject({
      detected: true,
      root: t.path("home", ".codex"),
      supportedCapabilities: ["rules", "mcp", "skills"],
      paths: {
        rules: t.path("home", ".codex", "AGENTS.md"),
        mcp: t.path("home", ".codex", "config.toml"),
        skillsDir: t.path("home", ".codex", "skills"),
      },
    });
    expect(report.agents.find((agent) => agent.id === "claude-code")?.detected).toBe(false);
  });

  it("reports an uninitialized store without blocking adapter inspection", async () => {
    const report = await doctor(t.env, { storeRoot, scope: "global", agents: ["codex"] });

    expect(report.checks.find((check) => check.id === "store-root")?.status).toBe("error");
    expect(report.checks.find((check) => check.id === "config")?.status).toBe("error");
    expect(report.checks.find((check) => check.id === "store-rules")?.status).toBe("error");
    expect(report.agents.map((agent) => agent.id)).toEqual(["codex"]);
  });

  it("reports initialized store checks as ok", async () => {
    await initStore(t.env, storeRoot);

    const report = await doctor(t.env, { storeRoot, scope: "global", agents: ["codex"] });

    expect(report.checks.find((check) => check.id === "store-root")?.status).toBe("ok");
    expect(report.checks.find((check) => check.id === "config")?.status).toBe("ok");
    expect(report.checks.find((check) => check.id === "store-rules")?.status).toBe("ok");
    expect(report.defaultMethod).toBe("symlink");
  });

  it("reports a pre-release reset diagnostic for legacy ownership state", async () => {
    await initStore(t.env, storeRoot);
    const statePath = join(storeRoot, "state.json");
    await t.env.fs.writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            artifact: "mcp/alpha",
            agent: "codex",
            scope: "global",
            capability: "mcp",
            target: t.path("home", ".codex", "config.toml"),
            method: "write",
            checksum: "sha256:old",
            backup: null,
            generated: false,
            appliedAt: "2026-06-30T08:00:00.000Z",
          },
        ],
      }),
    );

    const report = await doctor(t.env, { storeRoot, scope: "global", agents: ["codex"] });

    expect(report.checks.find((check) => check.id === "ownership-state")).toMatchObject({
      status: "error",
      path: statePath,
    });
    expect(report.checks.find((check) => check.id === "ownership-state")?.message).toMatch(
      /pre-release.*back up.*remove.*state\.json/i,
    );
  });

  it("turns unreadable config probes into doctor errors", async () => {
    await initStore(t.env, storeRoot);
    const configPath = t.path("home", ".cellarer", "config.json");
    const err = Object.assign(new Error("mock EACCES"), { code: "EACCES" });
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        readFile: (path: string) =>
          path === configPath ? Promise.reject(err) : t.env.fs.readFile(path),
      },
    };

    const report = await doctor(env, { storeRoot, scope: "global", agents: ["codex"] });

    expect(report.checks.find((check) => check.id === "config")).toMatchObject({
      status: "error",
      path: configPath,
    });
  });

  it("turns write access failures into doctor errors", async () => {
    await initStore(t.env, storeRoot);
    const target = t.path("home", ".claude", "CLAUDE.md");
    await t.env.fs.mkdir(t.path("home", ".claude"), { recursive: true });
    await t.env.fs.writeFile(target, "# existing");
    const err = Object.assign(new Error("mock EACCES"), { code: "EACCES" });
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        access: (path: string, mode: "read" | "write") =>
          path === target && mode === "write" ? Promise.reject(err) : t.env.fs.access(path, mode),
      },
    };

    const report = await doctor(env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
    });

    const claude = report.agents.find((agent) => agent.id === "claude-code");
    expect(claude?.checks.find((check) => check.id === "claude-code.rules.writable")).toMatchObject(
      {
        status: "error",
        path: target,
      },
    );
  });

  it("does not treat a regular file parent as a creatable directory", async () => {
    await initStore(t.env, storeRoot);
    await writeConfig(t, {
      version: 1,
      customAdapters: {
        blocked: {
          skills: { global: "~/.blocked/skills/child" },
        },
      },
    });
    const parentFile = t.path("home", ".blocked", "skills");
    await t.env.fs.mkdir(t.path("home", ".blocked"), { recursive: true });
    await t.env.fs.writeFile(parentFile, "not a directory");

    const report = await doctor(t.env, { storeRoot, scope: "global", agents: ["blocked"] });

    expect(
      report.agents[0]?.checks.find((check) => check.id === "blocked.skills.writable"),
    ).toMatchObject({
      status: "error",
      path: t.path("home", ".blocked", "skills", "child"),
      message: `parent path is not a directory: ${parentFile}`,
    });
  });

  it("reports existing targets with the wrong filesystem shape", async () => {
    await initStore(t.env, storeRoot);
    await t.env.fs.mkdir(t.path("home", ".claude", "CLAUDE.md"), { recursive: true });
    await t.env.fs.mkdir(t.path("home", ".codex"), { recursive: true });
    await t.env.fs.writeFile(t.path("home", ".codex", "skills"), "not a directory");

    const report = await doctor(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code", "codex"],
    });

    const claude = report.agents.find((agent) => agent.id === "claude-code");
    const codex = report.agents.find((agent) => agent.id === "codex");
    expect(claude?.checks.find((check) => check.id === "claude-code.rules.writable")).toMatchObject(
      {
        status: "error",
        message: "rules target exists but is a directory",
      },
    );
    expect(codex?.checks.find((check) => check.id === "codex.skills.writable")).toMatchObject({
      status: "error",
      message: "skills target exists but is not a directory",
    });
  });

  it("reports bad adapter path expansion without throwing", async () => {
    const customStore = await writeConfig(t, {
      version: 1,
      customAdapters: {
        bad: {
          rules: { project: "~/.ssh/owned.md" },
        },
      },
    });

    const report = await inspectAgents(t.env, {
      storeRoot: customStore,
      scope: "project",
      dir: t.path("project"),
      agents: ["bad"],
    });

    expect(report.agents).toHaveLength(1);
    expect(report.agents[0]?.warnings.join("\n")).toContain("path expansion failed");
  });
});
