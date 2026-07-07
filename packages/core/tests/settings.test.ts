import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteCustomAdapterConfig,
  initStore,
  saveCollections,
  saveDefaults,
  setAgentEnabled,
  settingsSummary,
  upsertAdapterConfig,
} from "../src/index.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("settings and agent config writes", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });

  afterEach(() => t.cleanup());

  it("summarizes library location and collections", async () => {
    const summary = await settingsSummary(t.env, { storeRoot });
    expect(summary.storeRoot).toBe(storeRoot);
    expect(summary.collections.map((c) => c.name)).toContain("default");
    expect(summary.defaults.collections).toEqual(["default"]);
  });

  it("saves collections and sync defaults", async () => {
    await saveCollections(t.env, storeRoot, {
      default: { description: "Default" },
      work: { description: "Work" },
    });
    const cfg = await saveDefaults(t.env, storeRoot, {
      collections: ["work"],
      method: "copy",
      secretMode: "env",
    });

    expect(cfg.collections.work?.description).toBe("Work");
    expect(cfg.defaults.collections).toEqual(["work"]);
    expect(cfg.defaults.method).toBe("copy");
  });

  it("updates agent enabled state", async () => {
    const cfg = await setAgentEnabled(t.env, storeRoot, "codex", false);
    expect(cfg.agents.codex?.enabled).toBe(false);
  });

  it("rejects collections without the default collection", async () => {
    await expect(
      saveCollections(t.env, storeRoot, {
        work: { description: "Work" },
      }),
    ).rejects.toThrow(/collections\.default must exist/);
  });

  it("rejects defaults that point at a missing collection", async () => {
    await expect(
      saveDefaults(t.env, storeRoot, {
        collections: ["missing"],
      }),
    ).rejects.toThrow(/defaults\.collections contains unknown collection: missing/);
  });

  it("rejects empty default collections", async () => {
    await expect(
      saveDefaults(t.env, storeRoot, {
        collections: [],
      }),
    ).rejects.toThrow(/defaults\.collections must contain at least one collection/);
  });

  it("upserts and deletes a custom adapter", async () => {
    await upsertAdapterConfig(t.env, storeRoot, "my-agent", {
      displayName: "My Agent",
      rules: { global: "~/.my-agent/RULES.md" },
    });
    let summary = await settingsSummary(t.env, { storeRoot });
    expect(summary.customAdapterIds).toContain("my-agent");

    await deleteCustomAdapterConfig(t.env, storeRoot, "my-agent");
    summary = await settingsSummary(t.env, { storeRoot });
    expect(summary.customAdapterIds).not.toContain("my-agent");
  });

  it("refuses to delete built-in adapters", async () => {
    await expect(deleteCustomAdapterConfig(t.env, storeRoot, "codex")).rejects.toThrow(
      /built-in adapter/,
    );
  });

  it("rejects invalid custom adapter upserts", async () => {
    await expect(
      upsertAdapterConfig(t.env, storeRoot, "my-agent", {
        displayName: "My Agent",
      }),
    ).rejects.toThrow(/invalid custom adapter "my-agent"/);
  });
});
