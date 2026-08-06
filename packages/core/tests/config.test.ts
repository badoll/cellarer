import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CellarerConfig,
  initialConfigText,
  loadAdapterSpecs,
  loadConfig,
  packagedConfigText,
  parseConfig,
  parsePackagedConfigForSettings,
  saveConfig,
} from "../src/store/config.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const SAMPLE = JSON.stringify({
  version: 1,
  defaults: {
    method: "symlink",
    collections: ["default"],
    secretMode: "env",
    os: { win32: { method: "copy" } },
  },
  collections: {
    default: { description: "Default" },
    internal: { description: "Internal" },
  },
  artifacts: {
    "rules/coding-style": { collections: ["default"] },
    "mcp/company-gateway": { collections: ["internal"] },
  },
  adapterOverrides: {
    cursor: { enabled: true },
    codex: { mcp: { mergeStrategy: "merge" } },
  },
  customAdapters: {
    "claude-code": {
      rules: { global: "~/custom-claude/CLAUDE.md" },
    },
    "my-agent": {
      displayName: "My Agent",
      rules: { global: "~/.myagent/RULES.md" },
    },
  },
});

describe("store/config", () => {
  it("parses a full config.json with defaults", () => {
    const cfg = parseConfig(SAMPLE);
    expect(cfg.defaults.method).toBe("symlink");
    expect(cfg.defaults.collections).toEqual(["default"]);
    expect(cfg.defaults.secretMode).toBe("env");
    expect(cfg.defaults.os?.win32?.method).toBe("copy");
    expect(cfg.collections.default?.description).toBe("Default");
    expect(cfg.artifacts["rules/coding-style"]?.collections).toEqual(["default"]);
    expect(cfg.adapterOverrides.cursor?.enabled).toBe(true);
    expect(cfg.adapterOverrides.codex?.mcp?.mergeStrategy).toBe("merge");
    expect(cfg.customAdapters["claude-code"]?.rules?.global).toBe("~/custom-claude/CLAUDE.md");
    expect(cfg.customAdapters["my-agent"]?.displayName).toBe("My Agent");
  });

  it("applies defaults for a minimal config", () => {
    const cfg = parseConfig("");
    expect(cfg.version).toBe(1);
    expect(cfg.defaults.method).toBe("symlink");
    expect(cfg.defaults.collections).toEqual(["default"]);
    expect(cfg.defaults.secretMode).toBe("env");
    expect(cfg.collections).toEqual({});
    expect(cfg.artifacts).toEqual({});
    expect(cfg.adapterOverrides).toEqual({});
    expect(cfg.customAdapters).toEqual({});
  });

  it("rejects an invalid method (strict schema)", () => {
    expect(() => parseConfig(JSON.stringify({ defaults: { method: "hardlink" } }))).toThrow();
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(() => parseConfig(JSON.stringify({ bogus: true }))).toThrow();
  });

  it("rejects adapter arrays in user config", () => {
    expect(() =>
      parseConfig(
        JSON.stringify({
          adapter: [{ id: "claude-code", rules: { global: "~/.claude/CLAUDE.md" } }],
        }),
      ),
    ).toThrow();
  });

  it("accepts split adapter maps and rejects legacy or malformed fields", () => {
    expect(parseConfig(JSON.stringify({ adapterOverrides: {}, customAdapters: {} }))).toMatchObject(
      { adapterOverrides: {}, customAdapters: {} },
    );
    expect(() => parseConfig(JSON.stringify({ customAdapters: [] }))).toThrow();
    expect(() => parseConfig(JSON.stringify({ builtinAdapters: {} }))).toThrow();
    expect(() => parseConfig(JSON.stringify({ agents: {}, adapters: {} }))).toThrow();
  });

  it("rejects removed channel config fields", () => {
    expect(() => parseConfig(JSON.stringify({ defaults: { channels: ["common"] } }))).toThrow();
    expect(() => parseConfig(JSON.stringify({ channels: { common: {} } }))).toThrow();
    expect(() =>
      parseConfig(JSON.stringify({ artifacts: { "rules/x": { channels: ["common"] } } })),
    ).toThrow();
  });

  it.each([
    ["defaults collection", { defaults: { collections: [""] } }],
    ["artifact collection", { artifacts: { "rules/style": { collections: [""] } } }],
    ["adapter display name", { adapterOverrides: { custom: { displayName: "" } } }],
    ["global detection path", { adapterOverrides: { custom: { detect: { global: [""] } } } }],
    ["project detection path", { adapterOverrides: { custom: { detect: { project: [""] } } } }],
    ["global rules path", { customAdapters: { custom: { rules: { global: "" } } } }],
    ["project rules path", { customAdapters: { custom: { rules: { project: "" } } } }],
    ["global MCP path", { adapterOverrides: { custom: { mcp: { global: "" } } } }],
    ["project MCP path", { adapterOverrides: { custom: { mcp: { project: "" } } } }],
    ["MCP servers key", { adapterOverrides: { custom: { mcp: { serversKey: "" } } } }],
    ["MCP dialect env key", { adapterOverrides: { custom: { mcp: { dialect: { envKey: "" } } } } }],
    ["MCP dialect URL key", { adapterOverrides: { custom: { mcp: { dialect: { urlKey: "" } } } } }],
    [
      "MCP dialect type field",
      { adapterOverrides: { custom: { mcp: { dialect: { typeField: "" } } } } },
    ],
    [
      "MCP dialect stdio type",
      { adapterOverrides: { custom: { mcp: { dialect: { stdioType: "" } } } } },
    ],
    [
      "MCP dialect remote type",
      { adapterOverrides: { custom: { mcp: { dialect: { remoteType: "" } } } } },
    ],
    ["global skills path", { customAdapters: { custom: { skills: { global: "" } } } }],
    ["project skills path", { customAdapters: { custom: { skills: { project: "" } } } }],
    ["collection name", { collections: { "": {} } }],
    ["artifact ID", { artifacts: { "": {} } }],
    ["adapter override ID", { adapterOverrides: { "": { enabled: true } } }],
    ["custom adapter ID", { customAdapters: { "": { rules: { global: "RULES.md" } } } }],
  ])("rejects an empty canonical string for %s", (_field, config) => {
    expect(() => parseConfig(JSON.stringify(config))).toThrow();
  });

  it.each([
    " ",
    "agent id",
    "agent\nname",
    "agent\u007fname",
    "-agent",
    "agent-",
    ".agent",
    "agent/name",
    "agent:name",
    "__proto__",
    "prototype",
    "constructor",
  ])("rejects unsafe adapter map key %j", (agentId) => {
    for (const field of ["adapterOverrides", "customAdapters"] as const) {
      const value =
        field === "adapterOverrides"
          ? { enabled: true }
          : { rules: { global: "~/.agent/RULES.md" } };
      const config = { [field]: Object.fromEntries([[agentId, value]]) };
      expect(() => parseConfig(JSON.stringify(config))).toThrow();
    }
  });

  it.each([
    "agents-md",
    "claude-code",
    "codex",
    "cursor",
    "gemini-cli",
    "opencode",
    "windsurf",
    "custom_agent.v2",
  ])("keeps defined and canonical adapter id %s valid", (agentId) => {
    const parsed = parseConfig(
      JSON.stringify({
        adapterOverrides: { [agentId]: { enabled: true } },
        customAdapters: { [agentId]: { rules: { global: "~/.agent/RULES.md" } } },
      }),
    );
    expect(parsed.adapterOverrides).toHaveProperty(agentId);
    expect(parsed.customAdapters).toHaveProperty(agentId);
  });

  it.each([
    "C:/x",
    "C:x",
    "c:/x",
    "//server/share",
    "\\\\server\\share",
    "\\\\?\\C:\\x",
    "/absolute",
    "./rules/style.md",
    "rules/./style.md",
    "rules/../style.md",
    "../rules/style.md",
    "rules//style.md",
    "rules/style.md/",
    "rules:style.md",
    "rules/%2e%2e/style.md",
    "rules/%2Fstyle.md",
  ])("rejects non-portable or non-normalized suppression source %s", (source) => {
    expect(() =>
      parseConfig(
        JSON.stringify({
          artifacts: {
            "rules/style": {
              secretPatternSuppressions: [{ source, rule: "github-pat", patternVersion: 1 }],
            },
          },
        }),
      ),
    ).toThrow();
  });

  it.each([
    "rules/style.md",
    "rules/nested/style.v2-guide.md",
    ".hidden/style-file.md",
    "rules/100%-style.md",
  ])("accepts normalized store-relative suppression source %s", (source) => {
    expect(
      parseConfig(
        JSON.stringify({
          artifacts: {
            "rules/style": {
              secretPatternSuppressions: [{ source, rule: "github-pat", patternVersion: 1 }],
            },
          },
        }),
      ).artifacts["rules/style"]?.secretPatternSuppressions?.[0]?.source,
    ).toBe(source);
  });

  describe("loadConfig from disk", () => {
    let t: TmpEnv;
    beforeEach(async () => {
      t = makeTmpEnv();
      await ensureBaseDirs(t);
    });
    afterEach(() => t.cleanup());

    it("returns packaged defaults when config.json is absent", async () => {
      const cfg = await loadConfig(t.env, t.path("store"));
      expect(cfg.defaults.method).toBe("symlink");
      expect(cfg.customAdapters).toEqual({});
      const adapters = await loadAdapterSpecs(t.env, t.path("store"));
      expect(adapters.specs.map((a) => a.id)).toContain("codex");
    });

    it("reads and parses config.json from the store root", async () => {
      const storeRoot = t.path("store");
      await t.env.fs.mkdir(storeRoot, { recursive: true });
      await t.env.fs.writeFile(t.path("store", "config.json"), SAMPLE);
      const cfg = await loadConfig(t.env, storeRoot);
      expect(cfg.defaults.os?.win32?.method).toBe("copy");
    });

    it("saves config updates for later reads", async () => {
      const storeRoot = t.path("store");
      await t.env.fs.mkdir(storeRoot, { recursive: true });
      const cfg = parseConfig(await initialConfigText(t.env));
      cfg.adapterOverrides.codex = { enabled: false };
      cfg.customAdapters["my-agent"] = {
        displayName: "My Agent",
        rules: { global: "~/.my-agent/RULES.md" },
      };

      await saveConfig(t.env, storeRoot, cfg);

      const loaded = await loadConfig(t.env, storeRoot);
      expect(loaded.adapterOverrides.codex?.enabled).toBe(false);
      expect(loaded.customAdapters["my-agent"]?.rules?.global).toBe("~/.my-agent/RULES.md");
    });

    it("rejects an invalid runtime config before persistence effects", async () => {
      const storeRoot = t.path("store");
      await t.env.fs.mkdir(storeRoot, { recursive: true });
      const path = t.path("store", "config.json");
      await t.env.fs.writeFile(path, SAMPLE);
      const before = await t.env.fs.readFile(path);
      const invalid = {
        ...parseConfig(SAMPLE),
        defaults: { ...parseConfig(SAMPLE).defaults, collections: [""] },
      } as CellarerConfig;

      await expect(saveConfig(t.env, storeRoot, invalid)).rejects.toThrow();
      expect(await t.env.fs.readFile(path)).toBe(before);
    });

    it("rejects a non-portable runtime suppression source before persistence effects", async () => {
      const storeRoot = t.path("store");
      await t.env.fs.mkdir(storeRoot, { recursive: true });
      const path = t.path("store", "config.json");
      await t.env.fs.writeFile(path, SAMPLE);
      const before = await t.env.fs.readFile(path);
      const valid = parseConfig(SAMPLE);
      const invalid = {
        ...valid,
        artifacts: {
          ...valid.artifacts,
          "rules/unsafe": {
            collections: [],
            secretPatternSuppressions: [{ source: "C:/x", rule: "github-pat", patternVersion: 1 }],
          },
        },
      } as CellarerConfig;

      await expect(saveConfig(t.env, storeRoot, invalid)).rejects.toThrow();
      expect(await t.env.fs.readFile(path)).toBe(before);
    });

    it("exposes packaged built-in adapter ids for settings", async () => {
      const packaged = parsePackagedConfigForSettings(await packagedConfigText(t.env));
      expect(Object.keys(packaged.builtinAdapters)).toContain("codex");
    });
  });
});
