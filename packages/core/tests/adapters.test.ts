import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markdownRulesCodec } from "../src/adapters/codec.js";
import { loadRegistry } from "../src/adapters/registry.js";
import { specToAdapter } from "../src/adapters/spec.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import { GENERATED_HEADER } from "../src/markers.js";
import { loadAdapterSpecs } from "../src/store/config.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

async function defaultAdapters(t: TmpEnv): Promise<Record<string, AgentAdapter>> {
  const specs = (await loadAdapterSpecs(t.env, t.path("home", ".cellarer"))).specs;
  return Object.fromEntries(specs.map((spec) => [spec.id, specToAdapter(spec)]));
}

async function writeConfig(t: TmpEnv, config: unknown): Promise<string> {
  const storeRoot = t.path("home", ".cellarer");
  await t.env.fs.mkdir(storeRoot, { recursive: true });
  await t.env.fs.writeFile(t.path("home", ".cellarer", "config.json"), JSON.stringify(config));
  return storeRoot;
}

describe("adapters/codec markdownRulesCodec", () => {
  it("renders via the shared markers format", () => {
    const out = markdownRulesCodec.render([{ relPath: "rules/a.md", content: "A" }]);
    expect(out.startsWith(GENERATED_HEADER)).toBe(true);
    expect(out).toContain("<!-- Source: rules/a.md -->");
    expect(out).toContain("A");
  });
});

describe("adapters/config defaults", () => {
  let t: TmpEnv;
  let adapters: Record<string, AgentAdapter>;

  beforeEach(async () => {
    t = makeTmpEnv();
    adapters = await defaultAdapters(t);
  });
  afterEach(() => t.cleanup());

  it("registers the default agents (M1 four + M5 gemini/opencode/windsurf)", async () => {
    expect(Object.keys(adapters).sort()).toEqual(
      ["agents-md", "claude-code", "codex", "cursor", "gemini-cli", "opencode", "windsurf"].sort(),
    );
  });

  describe("path calibration (matches §4 machine facts)", () => {
    it("claude-code: global ~/.claude/CLAUDE.md, project ./CLAUDE.md", () => {
      const cc = adapters["claude-code"]!;
      expect(cc.paths(t.env, "global").rules).toBe(t.path("home", ".claude", "CLAUDE.md"));
      expect(cc.paths(t.env, "project", t.path("proj")).rules).toBe(t.path("proj", "CLAUDE.md"));
    });

    it("codex: global ~/.codex/AGENTS.md", () => {
      expect(adapters.codex!.paths(t.env, "global").rules).toBe(
        t.path("home", ".codex", "AGENTS.md"),
      );
    });

    it("cursor: rules use the .mdc extension under .cursor/rules", () => {
      const cursor = adapters.cursor!;
      expect(cursor.paths(t.env, "global").rules).toBe(
        t.path("home", ".cursor", "rules", "cellarer.mdc"),
      );
      expect(cursor.paths(t.env, "project", t.path("proj")).rules).toBe(
        t.path("proj", ".cursor", "rules", "cellarer.mdc"),
      );
      expect(cursor.paths(t.env, "global").skillsDir).toBe(
        t.path("home", ".cursor", "skills-cursor"),
      );
    });

    it("agents-md: shared skills pool ~/.agents/skills", () => {
      expect(adapters["agents-md"]!.paths(t.env, "global").skillsDir).toBe(
        t.path("home", ".agents", "skills"),
      );
    });

    it("project {dir} expands without double-joining (relative dir absolutized via cwd)", () => {
      const w = makeTmpEnv({ cwd: "/abs/work" });
      const cc = adapters["claude-code"]!;
      expect(cc.paths(w.env, "project", "/abs/work/proj").rules).toBe("/abs/work/proj/CLAUDE.md");
      expect(cc.paths(w.env, "project", "proj").rules).toBe("/abs/work/proj/CLAUDE.md");
      w.cleanup();
    });

    it("project dir containing $-metachars is not corrupted by String.replace", () => {
      const cc = adapters["claude-code"]!;
      expect(cc.paths(t.env, "project", "/work/proj$$tmp").rules).toBe("/work/proj$$tmp/CLAUDE.md");
      expect(cc.paths(t.env, "project", "/work/a$&b").rules).toBe("/work/a$&b/CLAUDE.md");
    });
  });

  describe("capabilities", () => {
    it("agents-md declares no mcp capability", () => {
      expect(adapters["agents-md"]!.capabilities.mcp).toEqual([]);
      expect(adapters["agents-md"]!.capabilities.rules).toEqual(["global", "project"]);
    });
  });

  describe("detect", () => {
    beforeEach(async () => {
      await ensureBaseDirs(t);
    });

    it("reports installed when the global root dir exists", async () => {
      await t.env.fs.mkdir(t.path("home", ".claude"), { recursive: true });
      const d = await adapters["claude-code"]!.detect(t.env, "global");
      expect(d.installed).toBe(true);
      expect(d.root).toBe(t.path("home", ".claude"));
    });

    it("reports not-installed when the global root is absent", async () => {
      const d = await adapters.codex!.detect(t.env, "global");
      expect(d.installed).toBe(false);
    });

    it("project scope is installed when the dir exists", async () => {
      const proj = t.path("proj");
      await t.env.fs.mkdir(proj, { recursive: true });
      const d = await adapters["agents-md"]!.detect(t.env, "project", proj);
      expect(d.installed).toBe(true);
      expect(d.root).toBe(proj);
    });
  });
});

describe("adapters/registry (built-ins + key-based config)", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  it("loads configured defaults when config.json is absent", async () => {
    const reg = await loadRegistry(t.env, t.path("home", ".cellarer"));
    expect(reg.get("claude-code")).toBeDefined();
    expect(reg.list().length).toBe(7);
  });

  it("loads a custom adapter from config.json", async () => {
    const storeRoot = await writeConfig(t, {
      version: 1,
      adapters: {
        "my-agent": {
          displayName: "My Agent",
          detect: { global: ["~/.myagent"] },
          rules: { global: "~/.myagent/RULES.md", project: "{dir}/RULES.md" },
        },
      },
    });
    const reg = await loadRegistry(t.env, storeRoot);
    const a = reg.get("my-agent");
    expect(a).toBeDefined();
    expect(a!.displayName).toBe("My Agent");
    expect(a!.paths(t.env, "global").rules).toBe(t.path("home", ".myagent", "RULES.md"));
  });

  it("patches a built-in adapter through adapters keyed by id", async () => {
    const storeRoot = await writeConfig(t, {
      version: 1,
      adapters: {
        "claude-code": {
          detect: { global: ["~/Library/Application Support/Claude"] },
          rules: { global: "~/Library/Application Support/Claude/CLAUDE.md" },
        },
      },
    });
    const reg = await loadRegistry(t.env, storeRoot);
    const claude = reg.get("claude-code")!;
    expect(claude.displayName).toBe("Claude Code");
    expect(claude.paths(t.env, "global").rules).toBe(
      t.path("home", "Library", "Application Support", "Claude", "CLAUDE.md"),
    );
    expect(claude.paths(t.env, "project", t.path("proj")).rules).toBe(t.path("proj", "CLAUDE.md"));
    expect(claude.mcp?.serversKey).toBe("mcpServers");
  });

  it("treats a built-in adapter key as a built-in patch", async () => {
    const storeRoot = await writeConfig(t, {
      version: 1,
      adapters: {
        "claude-code": {
          displayName: "Claude Somewhere Else",
          rules: { global: "~/.fake/CLAUDE.md" },
        },
      },
    });
    const reg = await loadRegistry(t.env, storeRoot);
    const claude = reg.get("claude-code")!;
    expect(claude.displayName).toBe("Claude Somewhere Else");
    expect(claude.paths(t.env, "global").rules).toBe(t.path("home", ".fake", "CLAUDE.md"));
    expect(reg.list().filter((a) => a.id === "claude-code")).toHaveLength(1);
    expect(reg.warnings).toEqual([]);
  });

  it("rejects a custom adapter entry without rules, mcp, or skills", async () => {
    const storeRoot = await writeConfig(t, {
      version: 1,
      adapters: {
        empty: {
          displayName: "Empty",
        },
      },
    });
    await expect(loadRegistry(t.env, storeRoot)).rejects.toThrow(/invalid custom adapter "empty"/);
  });

  it("infers capabilities from declared path templates", async () => {
    const storeRoot = await writeConfig(t, {
      version: 1,
      adapters: {
        inferred: {
          displayName: "Inferred Caps",
          rules: { global: "~/.inferred/RULES.md", project: "{dir}/RULES.md" },
        },
      },
    });
    const reg = await loadRegistry(t.env, storeRoot);
    const a = reg.get("inferred")!;
    expect(a.capabilities.rules).toEqual(["global", "project"]);
    expect(a.capabilities.mcp).toEqual([]);
    expect(a.capabilities.skills).toEqual([]);
  });

  it("config adapter honors mcp field dialect", async () => {
    const storeRoot = await writeConfig(t, {
      version: 1,
      adapters: {
        quirky: {
          mcp: {
            global: "~/.quirky/mcp.json",
            format: "json",
            serversKey: "mcp",
            dialect: { commandStyle: "array", envKey: "environment" },
          },
        },
      },
    });
    const reg = await loadRegistry(t.env, storeRoot);
    const codec = reg.get("quirky")?.mcp?.codec;
    expect(codec).toBeDefined();
    const content = codec!.encode(
      { servers: {}, doc: {}, serversKey: "mcp" },
      { s: { kind: "stdio", command: "npx", args: ["x"], env: { K: "v" } } },
    );
    const parsed = JSON.parse(content);
    expect(parsed.mcp.s.command).toEqual(["npx", "x"]);
    expect(parsed.mcp.s.environment).toEqual({ K: "v" });
  });

  describe("path traversal guard (§6.6 分享场景越界防护)", () => {
    async function loadWith(id: string, adapter: unknown) {
      const storeRoot = await writeConfig(t, { version: 1, adapters: { [id]: adapter } });
      return loadRegistry(t.env, storeRoot);
    }

    it("rejects an absolute path outside home/project on global paths()", async () => {
      const reg = await loadWith("evil", {
        rules: { global: "/etc/evil.md" },
      });
      const a = reg.get("evil")!;
      expect(() => a.paths(t.env, "global")).toThrow(/escapes its global/);
    });

    it("rejects a ~/../ escape that normalizes outside home", async () => {
      const reg = await loadWith("evil", {
        rules: { global: "~/../../etc/evil.md" },
      });
      const a = reg.get("evil")!;
      expect(() => a.paths(t.env, "global")).toThrow(/escapes its global/);
    });

    it("rejects a {dir}/../ escape on project paths()", async () => {
      const reg = await loadWith("evil", {
        rules: { project: "{dir}/../../escape.md" },
      });
      const a = reg.get("evil")!;
      expect(() => a.paths(t.env, "project", t.path("proj"))).toThrow(/escapes/);
    });

    it("rejects a project-scope ~/ template escalating into the home dir", async () => {
      const reg = await loadWith("evil", {
        rules: { project: "~/.ssh/authorized_keys" },
      });
      const a = reg.get("evil")!;
      expect(() => a.paths(t.env, "project", t.path("proj"))).toThrow(/escapes its project/);
    });

    it("allows a legitimate ~/ and {dir}/ template", async () => {
      const reg = await loadWith("ok", {
        rules: { global: "~/.ok/R.md", project: "{dir}/R.md" },
      });
      const a = reg.get("ok")!;
      expect(a.paths(t.env, "global").rules).toBe(t.path("home", ".ok", "R.md"));
      expect(a.paths(t.env, "project", t.path("proj")).rules).toBe(t.path("proj", "R.md"));
    });
  });
});
