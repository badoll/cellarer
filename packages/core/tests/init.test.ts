import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG_TOML, initStore, parseConfig } from "../src/index.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("store/initStore", () => {
  let t: TmpEnv;
  let storeRoot: string;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
  });
  afterEach(() => t.cleanup());

  it("creates store/rules + adapters dirs and a default cellarer.toml", async () => {
    const r = await initStore(t.env, storeRoot);
    expect(r.createdConfig).toBe(true);
    expect(
      (await t.env.fs.lstat(t.path("home", ".cellarer", "store", "rules"))).isDirectory(),
    ).toBe(true);
    expect((await t.env.fs.lstat(t.path("home", ".cellarer", "adapters"))).isDirectory()).toBe(
      true,
    );
    const toml = await t.env.fs.readFile(t.path("home", ".cellarer", "cellarer.toml"));
    expect(toml).toBe(DEFAULT_CONFIG_TOML);
  });

  it("the default config template parses cleanly against the schema (no drift)", () => {
    const cfg = parseConfig(DEFAULT_CONFIG_TOML);
    expect(cfg.defaults.method).toBe("symlink");
    expect(cfg.defaults.os?.win32?.method).toBe("copy");
  });

  it("is idempotent: does not overwrite an existing cellarer.toml", async () => {
    await initStore(t.env, storeRoot);
    await t.env.fs.writeFile(t.path("home", ".cellarer", "cellarer.toml"), "# user edits\n");
    const r = await initStore(t.env, storeRoot);
    expect(r.createdConfig).toBe(false);
    expect(await t.env.fs.readFile(t.path("home", ".cellarer", "cellarer.toml"))).toBe(
      "# user edits\n",
    );
  });
});
