import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinAdapters } from "../src/adapters/builtin.js";
import { markdownRulesCodec } from "../src/adapters/codec.js";
import { loadRegistry } from "../src/adapters/registry.js";
import { GENERATED_HEADER } from "../src/markers.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("adapters/codec markdownRulesCodec", () => {
  it("renders via the shared markers format and detects generated content", () => {
    const out = markdownRulesCodec.render([{ relPath: "rules/a.md", content: "A" }]);
    expect(out.startsWith(GENERATED_HEADER)).toBe(true);
    expect(markdownRulesCodec.isGenerated(out)).toBe(true);
    expect(markdownRulesCodec.isGenerated("hand written")).toBe(false);
  });
});

describe("adapters/builtin", () => {
  const adapters = Object.fromEntries(builtinAdapters().map((a) => [a.id, a]));

  it("registers the four M1 builtin agents", () => {
    expect(Object.keys(adapters).sort()).toEqual(
      ["agents-md", "claude-code", "codex", "cursor"].sort(),
    );
  });

  describe("path calibration (matches §4 machine facts)", () => {
    let t: TmpEnv;
    beforeEach(() => {
      t = makeTmpEnv();
    });
    afterEach(() => t.cleanup());

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
      // skills 目录名是 skills-cursor(非 skills)
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
      // 绝对 dir:不重复拼接。
      expect(cc.paths(w.env, "project", "/abs/work/proj").rules).toBe("/abs/work/proj/CLAUDE.md");
      // 相对 dir:相对注入的 cwd absolutize,且不出现 proj/proj 双拼。
      expect(cc.paths(w.env, "project", "proj").rules).toBe("/abs/work/proj/CLAUDE.md");
      w.cleanup();
    });

    it("project dir containing $-metachars is not corrupted by String.replace", () => {
      const cc = adapters["claude-code"]!;
      // $$ / $& 等若用裸 String.replace 会被重新解释;函数 replacer 原样保留。
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
    let t: TmpEnv;
    beforeEach(async () => {
      t = makeTmpEnv();
      await ensureBaseDirs(t);
    });
    afterEach(() => t.cleanup());

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

describe("adapters/registry (builtin + declarative override)", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    await t.env.fs.mkdir(t.path("home", ".cellarer"), { recursive: true });
  });
  afterEach(() => t.cleanup());

  it("loads builtins when no declarative adapters exist", async () => {
    const reg = await loadRegistry(t.env, t.path("home", ".cellarer"));
    expect(reg.get("claude-code")).toBeDefined();
    expect(reg.list().length).toBe(4);
  });

  it("loads a valid declarative adapter from ~/.cellarer/adapters/*.toml", async () => {
    const dir = t.path("home", ".cellarer", "adapters");
    await t.env.fs.mkdir(dir, { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "adapters", "my-agent.toml"),
      `id = "my-agent"
displayName = "My Agent"
[detect]
global = ["~/.myagent"]
[rules]
global = "~/.myagent/RULES.md"
project = "{dir}/RULES.md"
capabilities = { rules = ["global", "project"], mcp = [], skills = [] }
`,
    );
    const reg = await loadRegistry(t.env, t.path("home", ".cellarer"));
    const a = reg.get("my-agent");
    expect(a).toBeDefined();
    expect(a!.displayName).toBe("My Agent");
    expect(a!.paths(t.env, "global").rules).toBe(t.path("home", ".myagent", "RULES.md"));
  });

  it("skips an invalid declarative adapter and records a warning", async () => {
    const dir = t.path("home", ".cellarer", "adapters");
    await t.env.fs.mkdir(dir, { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "adapters", "broken.toml"),
      `displayName = "No id"\n`,
    );
    const reg = await loadRegistry(t.env, t.path("home", ".cellarer"));
    expect(reg.get("broken")).toBeUndefined();
    expect(reg.warnings.some((w) => w.includes("broken.toml"))).toBe(true);
    // 其余内置适配器不受影响
    expect(reg.get("claude-code")).toBeDefined();
  });

  it("a declarative adapter with a builtin id overrides the builtin (patch paths)", async () => {
    const dir = t.path("home", ".cellarer", "adapters");
    await t.env.fs.mkdir(dir, { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "adapters", "cursor.toml"),
      `id = "cursor"
displayName = "Cursor (patched)"
[detect]
global = ["~/.cursor"]
[rules]
global = "~/.cursor/custom.mdc"
capabilities = { rules = ["global"], mcp = [], skills = [] }
`,
    );
    const reg = await loadRegistry(t.env, t.path("home", ".cellarer"));
    const cursor = reg.get("cursor")!;
    expect(cursor.displayName).toBe("Cursor (patched)");
    expect(cursor.paths(t.env, "global").rules).toBe(t.path("home", ".cursor", "custom.mdc"));
  });

  it("project adapters override global adapters", async () => {
    const gdir = t.path("home", ".cellarer", "adapters");
    await t.env.fs.mkdir(gdir, { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "adapters", "shared.toml"),
      `id = "shared"
displayName = "Global"
[rules]
global = "~/.shared/R.md"
capabilities = { rules = ["global"], mcp = [], skills = [] }
`,
    );
    const projAdapters = t.path("proj", ".cellarer", "adapters");
    await t.env.fs.mkdir(projAdapters, { recursive: true });
    await t.env.fs.writeFile(
      t.path("proj", ".cellarer", "adapters", "shared.toml"),
      `id = "shared"
displayName = "Project"
[rules]
global = "~/.shared/R.md"
capabilities = { rules = ["global"], mcp = [], skills = [] }
`,
    );
    const reg = await loadRegistry(t.env, t.path("home", ".cellarer"), t.path("proj"));
    expect(reg.get("shared")!.displayName).toBe("Project");
  });

  it("infers capabilities from declared path templates (TOML inline-key pitfall safe)", async () => {
    const dir = t.path("home", ".cellarer", "adapters");
    await t.env.fs.mkdir(dir, { recursive: true });
    // inline capabilities 写在 [rules] 表之后 → TOML 归入 rules.capabilities(常见坑);
    // 期望仍能从路径模板推断 rules: [global, project],mcp/skills 为空。
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "adapters", "inferred.toml"),
      `id = "inferred"
displayName = "Inferred Caps"
[rules]
global = "~/.inferred/RULES.md"
project = "{dir}/RULES.md"
capabilities = { rules = ["global", "project"], mcp = [], skills = [] }
`,
    );
    const reg = await loadRegistry(t.env, t.path("home", ".cellarer"));
    const a = reg.get("inferred")!;
    expect(a.capabilities.rules).toEqual(["global", "project"]);
    expect(a.capabilities.mcp).toEqual([]);
    expect(a.capabilities.skills).toEqual([]);
  });
});
