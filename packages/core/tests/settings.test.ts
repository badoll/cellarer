import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteCustomAdapterConfig,
  initStore,
  loadAdapterSpecs,
  loadConfig,
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
    const before = await loadConfig(t.env, storeRoot);
    await expect(
      saveCollections(t.env, storeRoot, {
        work: { description: "Work" },
      }),
    ).rejects.toThrow(/collections\.default must exist/);
    const after = await loadConfig(t.env, storeRoot);
    expect(after).toEqual(before);
  });

  it("rejects defaults that point at a missing collection", async () => {
    const before = await loadConfig(t.env, storeRoot);
    await expect(
      saveDefaults(t.env, storeRoot, {
        collections: ["missing"],
      }),
    ).rejects.toThrow(/defaults\.collections contains unknown collection: missing/);
    const after = await loadConfig(t.env, storeRoot);
    expect(after).toEqual(before);
  });

  it("rejects empty default collections", async () => {
    const before = await loadConfig(t.env, storeRoot);
    await expect(
      saveDefaults(t.env, storeRoot, {
        collections: [],
      }),
    ).rejects.toThrow(/defaults\.collections must contain at least one collection/);
    const after = await loadConfig(t.env, storeRoot);
    expect(after).toEqual(before);
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

  it("stores built-in adapter patches and still resolves merged specs", async () => {
    const patch = {
      displayName: "Codex Override",
      mcp: { mergeStrategy: "overwrite" as const },
    };

    await upsertAdapterConfig(t.env, storeRoot, "codex", patch);

    const config = await loadConfig(t.env, storeRoot);
    expect(config.adapters.codex).toEqual(patch);

    const specs = await loadAdapterSpecs(t.env, storeRoot);
    expect(specs.specs.find((spec) => spec.id === "codex")).toMatchObject({
      id: "codex",
      displayName: "Codex Override",
      mcp: {
        mergeStrategy: "overwrite",
        global: "~/.codex/config.toml",
        project: "{dir}/.codex/config.toml",
        format: "toml",
        serversKey: "mcp_servers",
      },
    });
  });

  it("rejects invalid built-in adapter patches", async () => {
    await expect(
      upsertAdapterConfig(t.env, storeRoot, "codex", {
        mcp: {
          format: "yaml",
        },
      } as unknown as Parameters<typeof upsertAdapterConfig>[3]),
    ).rejects.toThrow();
  });
});
