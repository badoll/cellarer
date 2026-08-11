import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsSummary } from "../src/index.js";
import { loadConfig, saveConfig } from "../src/store/config.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("settings summary", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });

  afterEach(() => t.cleanup());

  it("summarizes library location and collections without exposing mutation helpers", async () => {
    const summary = await settingsSummary(t.env, { storeRoot });
    expect(summary.storeRoot).toBe(storeRoot);
    expect(summary.collections.map((collection) => collection.name)).toContain("default");
    expect(summary.defaults.collections).toEqual(["default"]);
  });

  it("retains an own undefined description key for collection consumers", async () => {
    const config = await loadConfig(t.env, storeRoot);
    config.collections.empty = {};
    await saveConfig(t.env, storeRoot, config);
    const summary = await settingsSummary(t.env, { storeRoot });
    const collection = summary.collections.find(({ name }) => name === "empty");

    expect(collection).toBeDefined();
    expect(Object.hasOwn(collection ?? {}, "description")).toBe(true);
    expect(collection?.description).toBeUndefined();
  });
});
