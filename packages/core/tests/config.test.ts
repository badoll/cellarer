import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/store/config.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const SAMPLE = `
[defaults]
method = "symlink"
channels = ["common"]
secret_mode = "env"

[defaults.os.win32]
method = "copy"

[channels.common]
description = "通用"
[channels.internal]
description = "内网专用"

[artifacts."rules/coding-style"]
channels = ["common"]
[artifacts."mcp/company-gateway"]
channels = ["internal"]

[agents.cursor]
enabled = true
[agents.codex.mcp]
merge_strategy = "merge"
`;

describe("store/config", () => {
  it("parses a full cellarer.toml with defaults", () => {
    const cfg = parseConfig(SAMPLE);
    expect(cfg.defaults.method).toBe("symlink");
    expect(cfg.defaults.channels).toEqual(["common"]);
    expect(cfg.defaults.secret_mode).toBe("env");
    expect(cfg.defaults.os?.win32?.method).toBe("copy");
    expect(cfg.channels.common?.description).toBe("通用");
    expect(cfg.artifacts["rules/coding-style"]?.channels).toEqual(["common"]);
    expect(cfg.agents.cursor?.enabled).toBe(true);
    expect(cfg.agents.codex?.mcp?.merge_strategy).toBe("merge");
  });

  it("applies defaults for a minimal config", () => {
    const cfg = parseConfig("");
    expect(cfg.defaults.method).toBe("symlink");
    expect(cfg.defaults.channels).toEqual(["common"]);
    expect(cfg.defaults.secret_mode).toBe("env");
    expect(cfg.channels).toEqual({});
    expect(cfg.artifacts).toEqual({});
    expect(cfg.agents).toEqual({});
  });

  it("rejects an invalid method (strict schema)", () => {
    expect(() => parseConfig(`[defaults]\nmethod = "hardlink"\n`)).toThrow();
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(() => parseConfig(`[bogus]\nx = 1\n`)).toThrow();
  });

  describe("loadConfig from disk", () => {
    let t: TmpEnv;
    beforeEach(async () => {
      t = makeTmpEnv();
      await ensureBaseDirs(t);
    });
    afterEach(() => t.cleanup());

    it("returns defaults when cellarer.toml is absent", async () => {
      const cfg = await loadConfig(t.env, t.path("store"));
      expect(cfg.defaults.method).toBe("symlink");
    });

    it("reads and parses cellarer.toml from the store root", async () => {
      const storeRoot = t.path("store");
      await t.env.fs.mkdir(storeRoot, { recursive: true });
      await t.env.fs.writeFile(t.path("store", "cellarer.toml"), SAMPLE);
      const cfg = await loadConfig(t.env, storeRoot);
      expect(cfg.defaults.os?.win32?.method).toBe("copy");
    });
  });
});
