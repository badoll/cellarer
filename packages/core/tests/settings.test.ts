import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  deleteCustomAdapterConfig,
  loadAdapterSpecs,
  loadConfig,
  saveCollections,
  saveDefaults,
  setAgentEnabled,
  settingsSummary,
  upsertAdapterConfig,
} from "../src/index.js";
import { listOperationReceipts, readOperationJournal } from "../src/protocol/journal.js";
import { readStoreRevision } from "../src/protocol/store-revision.js";
import { initStore } from "../src/store/store.js";
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

  it("rejects an external config drift before the mutation lock without overwriting it", async () => {
    const configPath = t.path("home", ".cellarer", "config.json");
    const external = `${JSON.stringify({ version: 1, external: true }, null, 2)}\n`;
    const driftEnv = driftBeforeMutationLock(t.env, async () => {
      await t.env.fs.writeFile(configPath, external);
    });

    await expect(saveDefaults(driftEnv, storeRoot, { method: "copy" })).rejects.toMatchObject({
      code: "TARGET_PRECONDITION_CONFLICT",
      conflict: { code: "TARGET_PRECONDITION_CONFLICT", target: configPath },
    });
    await expect(t.env.fs.readFile(configPath)).resolves.toBe(external);
  });

  it("fails before publication when config drifts after the journal starts executing", async () => {
    const configPath = t.path("home", ".cellarer", "config.json");
    const external = `${JSON.stringify({ version: 1, external: true }, null, 2)}\n`;
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    let injected = false;
    const driftEnv: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          await publishFileAtomically(path, data, opts);
          if (!injected && path.endsWith("operations/active.json")) {
            const journal = JSON.parse(data) as { status?: string };
            if (journal.status === "executing") {
              injected = true;
              await publishFileAtomically(configPath, external, { mode: 0o600 });
            }
          }
        },
      },
    };

    await expect(saveDefaults(driftEnv, storeRoot, { method: "copy" })).rejects.toMatchObject({
      code: "PARTIAL_FAILURE",
      conflict: { code: "PARTIAL_FAILURE" },
    });
    await expect(t.env.fs.readFile(configPath)).resolves.toBe(external);
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "recovery-required",
      actions: [
        {
          status: "failed",
          receipt: { error: { code: "TARGET_PRECONDITION_CONFLICT" } },
        },
      ],
    });
  });

  it("does not commit when config bytes change after atomic publication", async () => {
    const configPath = t.path("home", ".cellarer", "config.json");
    const external = '{ "version": 1, "externalAfterPublish": true }\n';
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    let injected = false;
    const driftEnv: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          await publishFileAtomically(path, data, opts);
          if (!injected && path === configPath) {
            injected = true;
            await publishFileAtomically(configPath, external, { mode: 0o600 });
          }
        },
      },
    };

    await expect(saveDefaults(driftEnv, storeRoot, { method: "copy" })).rejects.toMatchObject({
      code: "PARTIAL_FAILURE",
    });
    await expect(t.env.fs.readFile(configPath)).resolves.toBe(external);
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "recovery-required",
      actions: [
        {
          status: "failed",
          receipt: { error: { code: "PUBLICATION_POSTCONDITION_FAILED" } },
        },
      ],
    });
  });

  it("does not commit when config mode changes after atomic publication", async () => {
    const configPath = t.path("home", ".cellarer", "config.json");
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    let injected = false;
    const driftEnv: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          await publishFileAtomically(path, data, opts);
          if (!injected && path === configPath) {
            injected = true;
            await t.env.fs.chmod(configPath, 0o644);
          }
        },
      },
    };

    await expect(saveDefaults(driftEnv, storeRoot, { method: "copy" })).rejects.toMatchObject({
      code: "PARTIAL_FAILURE",
    });
    expect((await t.env.fs.lstat(configPath)).mode & 0o777).toBe(0o644);
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "recovery-required",
      actions: [
        {
          status: "failed",
          receipt: { error: { code: "PUBLICATION_POSTCONDITION_FAILED" } },
        },
      ],
    });
  });

  it("records a failed receipt when the only signed publication fails", async () => {
    const configPath = t.path("home", ".cellarer", "config.json");
    const configBefore = await t.env.fs.readFile(configPath);
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    const failingEnv: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          if (path === configPath) {
            const error = new Error("simulated settings publication failure") as Error & {
              code: string;
            };
            error.code = "EIO";
            throw error;
          }
          return publishFileAtomically(path, data, opts);
        },
      },
    };

    await expect(saveDefaults(failingEnv, storeRoot, { method: "copy" })).rejects.toMatchObject({
      code: "PARTIAL_FAILURE",
      conflict: { code: "PARTIAL_FAILURE" },
    });
    await expect(t.env.fs.readFile(configPath)).resolves.toBe(configBefore);
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
    await expect(listOperationReceipts(t.env, storeRoot)).resolves.toMatchObject([
      {
        outcome: "compensated",
        resultingRevision: 0,
        actionReceipts: [{ target: configPath, outcome: "failed", error: { code: "EIO" } }],
      },
    ]);
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

function driftBeforeMutationLock(env: Env, drift: () => Promise<void>): Env {
  const writeFileExclusive = env.fs.writeFileExclusive;
  let injected = false;
  return {
    ...env,
    fs: {
      ...env.fs,
      writeFileExclusive: async (path, data, opts) => {
        if (!injected && path.endsWith("mutation.lock")) {
          injected = true;
          await drift();
        }
        return writeFileExclusive(path, data, opts);
      },
    },
  };
}
