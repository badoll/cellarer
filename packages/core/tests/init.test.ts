import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initStore, loadRegistry, parseConfig } from "../src/index.js";
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

  it("creates store/rules + config.json", async () => {
    const r = await initStore(t.env, storeRoot);
    expect(r.createdConfig).toBe(true);
    expect(
      (await t.env.fs.lstat(t.path("home", ".cellarer", "store", "rules"))).isDirectory(),
    ).toBe(true);
    const json = await t.env.fs.readFile(t.path("home", ".cellarer", "config.json"));
    const cfg = parseConfig(json);
    expect(cfg.adapters).toEqual({});
    const reg = await loadRegistry(t.env, storeRoot);
    expect(reg.get("claude-code")).toBeDefined();
    expect(reg.get("codex")).toBeDefined();
  });

  it("the packaged config template parses cleanly against the schema (no drift)", async () => {
    const r = await initStore(t.env, storeRoot);
    expect(r.createdConfig).toBe(true);
    const cfg = parseConfig(await t.env.fs.readFile(t.path("home", ".cellarer", "config.json")));
    expect(cfg.defaults.method).toBe("symlink");
    expect(cfg.defaults.os?.win32?.method).toBe("copy");
  });

  it("is idempotent: does not overwrite an existing config.json", async () => {
    await initStore(t.env, storeRoot);
    await t.env.fs.writeFile(t.path("home", ".cellarer", "config.json"), '{ "version": 1 }\n');
    const r = await initStore(t.env, storeRoot);
    expect(r.createdConfig).toBe(false);
    expect(await t.env.fs.readFile(t.path("home", ".cellarer", "config.json"))).toBe(
      '{ "version": 1 }\n',
    );
  });
});
