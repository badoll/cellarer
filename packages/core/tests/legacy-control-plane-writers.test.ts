import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import * as core from "../src/index.js";
import { writeRuleArtifact } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

type LegacyControlPlaneWriters = {
  saveCollections?: (
    env: Env,
    storeRoot: string,
    collections: Record<string, { description?: string }>,
  ) => Promise<unknown>;
  deleteCustomAdapterConfig?: (env: Env, storeRoot: string, adapterId: string) => Promise<unknown>;
};

const legacy = core as typeof core & LegacyControlPlaneWriters;

describe("legacy control-plane writer removal", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await core.initializeStore(t.env, storeRoot);
  });

  afterEach(() => t.cleanup());

  it("keeps all five obsolete writers out of the public Core API", () => {
    const publicCore = core as unknown as Record<string, unknown>;
    expect(
      [
        "saveCollections",
        "saveDefaults",
        "setAgentEnabled",
        "upsertAdapterConfig",
        "deleteCustomAdapterConfig",
      ].filter((name) => typeof publicCore[name] === "function"),
    ).toEqual([]);
  });

  it("does not expose a bulk collection writer that can leave dangling membership", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await core.mutateCollection(t.env, {
      storeRoot,
      action: "create",
      collectionName: "work",
      description: "Work",
      resourceIds: ["rules/style"],
    });
    const beforeStore = await t.env.fs.snapshotTreeNoFollow(storeRoot);

    if (legacy.saveCollections) {
      await legacy.saveCollections(t.env, storeRoot, {
        default: { description: "Default" },
      });
    }

    expect(legacy.saveCollections).toBeUndefined();
    await expect(t.env.fs.snapshotTreeNoFollow(storeRoot)).resolves.toEqual(beforeStore);
    const config = await core.loadConfig(t.env, storeRoot);
    for (const artifact of Object.values(config.artifacts)) {
      for (const collectionName of artifact.collections) {
        expect(config.collections).toHaveProperty(collectionName);
      }
    }
  });

  it("does not expose custom-adapter deletion outside the dependency-guarded mutation service", async () => {
    await core.mutateCustomAdapter(t.env, {
      storeRoot,
      action: "add",
      agentId: "desired-agent",
      adapter: { rules: { global: "~/.desired-agent/RULES.md" } },
    });
    const beforeStore = await t.env.fs.snapshotTreeNoFollow(storeRoot);

    if (legacy.deleteCustomAdapterConfig) {
      await legacy.deleteCustomAdapterConfig(t.env, storeRoot, "desired-agent");
    }

    expect(legacy.deleteCustomAdapterConfig).toBeUndefined();
    await expect(t.env.fs.snapshotTreeNoFollow(storeRoot)).resolves.toEqual(beforeStore);
    await expect(core.loadConfig(t.env, storeRoot)).resolves.toHaveProperty(
      "customAdapters.desired-agent",
    );
  });

  it("keeps an enabled custom adapter and all transaction state unchanged when removal is guarded", async () => {
    await core.mutateCustomAdapter(t.env, {
      storeRoot,
      action: "add",
      agentId: "desired-agent",
      adapter: { rules: { global: "~/.desired-agent/RULES.md" } },
    });
    const beforeStore = await t.env.fs.snapshotTreeNoFollow(storeRoot);
    const beforeRevision = await core.readStoreRevision(t.env, storeRoot);
    const beforeReceipts = await core.listOperationReceipts(t.env, storeRoot);

    await expect(
      core.mutateCustomAdapter(t.env, {
        storeRoot,
        action: "remove",
        agentId: "desired-agent",
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_CONFLICT",
      details: {
        dependencies: {
          ownedTargets: [],
          desiredSelections: ["agent:desired-agent:enabled"],
        },
      },
    });

    await expect(t.env.fs.snapshotTreeNoFollow(storeRoot)).resolves.toEqual(beforeStore);
    await expect(core.readStoreRevision(t.env, storeRoot)).resolves.toBe(beforeRevision);
    await expect(core.listOperationReceipts(t.env, storeRoot)).resolves.toEqual(beforeReceipts);
  });
});
