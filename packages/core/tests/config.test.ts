import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAdapterSpecs, loadConfig, parseConfig } from "../src/store/config.js";
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
  agents: {
    cursor: { enabled: true },
    codex: { mcp: { mergeStrategy: "merge" } },
  },
  adapters: {
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
    expect(cfg.agents.cursor?.enabled).toBe(true);
    expect(cfg.agents.codex?.mcp?.mergeStrategy).toBe("merge");
    expect(cfg.adapters["claude-code"]?.rules?.global).toBe("~/custom-claude/CLAUDE.md");
    expect(cfg.adapters["my-agent"]?.displayName).toBe("My Agent");
  });

  it("applies defaults for a minimal config", () => {
    const cfg = parseConfig("");
    expect(cfg.version).toBe(1);
    expect(cfg.defaults.method).toBe("symlink");
    expect(cfg.defaults.collections).toEqual(["default"]);
    expect(cfg.defaults.secretMode).toBe("env");
    expect(cfg.collections).toEqual({});
    expect(cfg.artifacts).toEqual({});
    expect(cfg.agents).toEqual({});
    expect(cfg.adapters).toEqual({});
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

  it("rejects removed adapter override/custom fields", () => {
    expect(() => parseConfig(JSON.stringify({ adapterOverrides: {} }))).toThrow();
    expect(() => parseConfig(JSON.stringify({ customAdapters: [] }))).toThrow();
    expect(() => parseConfig(JSON.stringify({ builtinAdapters: {} }))).toThrow();
  });

  it("rejects removed channel config fields", () => {
    expect(() => parseConfig(JSON.stringify({ defaults: { channels: ["common"] } }))).toThrow();
    expect(() => parseConfig(JSON.stringify({ channels: { common: {} } }))).toThrow();
    expect(() =>
      parseConfig(JSON.stringify({ artifacts: { "rules/x": { channels: ["common"] } } })),
    ).toThrow();
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
      expect(cfg.adapters).toEqual({});
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
  });
});
