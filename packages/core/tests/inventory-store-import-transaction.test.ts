import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  applyInventoryStoreImportPlan,
  planInventoryStoreImport,
} from "../src/inventory/import.js";
import { refreshInventory } from "../src/inventory/projector.js";
import { createAuthorizedMutationPlan } from "../src/protocol/canonical.js";
import { operationJournalPath, readOperationJournal } from "../src/protocol/journal.js";
import { recoverInterruptedOperation } from "../src/protocol/recovery.js";
import { publishStoreRevision, readStoreRevision } from "../src/protocol/store-revision.js";
import { loadConfig } from "../src/store/config.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("Inventory Store import transaction", () => {
  let t: TmpEnv;
  let rulesPath: string;

  beforeEach(async () => {
    let randomId = 0;
    t = makeTmpEnv({ randomId: () => `inventory-transaction-${++randomId}` });
    await ensureBaseDirs(t);
    rulesPath = t.path("home", ".codex", "AGENTS.md");
    await t.env.fs.mkdir(join(rulesPath, ".."), {
      recursive: true,
    });
    await t.env.fs.mkdir(t.path("home", ".agents", "skills", "inventory-demo"), {
      recursive: true,
    });
    await t.env.fs.writeFile(rulesPath, "# Reviewed rules\n");
    await t.env.fs.writeFile(
      t.path("home", ".agents", "skills", "inventory-demo", "SKILL.md"),
      "---\nname: inventory-demo\ndescription: transaction fixture\n---\n",
    );
  });

  afterEach(() => t.cleanup());

  async function plan(storeName: string, intoCollection?: string) {
    const storeRoot = t.path(storeName);
    await initStore(t.env, storeRoot);
    const inventory = await refreshInventory(t.env, { storeRoot, agentId: "codex" });
    const candidateIds = inventory.candidates
      .filter(({ state }) => state === "ready")
      .map(({ id }) => id);
    if (candidateIds.length < 2) throw new Error("missing multi-resource Inventory fixture");
    return {
      storeRoot,
      planned: await planInventoryStoreImport(t.env, {
        storeRoot,
        candidateIds,
        refresh: { agentId: "codex" },
        ...(intoCollection ? { intoCollection } : {}),
      }),
    };
  }

  it("closes the same-process, replacement-process, stale, atomic-failure, and recovery journey", async () => {
    const same = await plan("same-process");
    await expect(
      applyInventoryStoreImportPlan(t.env, same.planned.mutationPlan, {
        storeRoot: same.storeRoot,
      }),
    ).resolves.toMatchObject({ operation: { ok: true, receipt: { outcome: "committed" } } });

    const replacement = await plan("replacement-process");
    const replacementEnv: Env = { ...t.env, processId: () => t.env.processId() + 100 };
    await expect(
      applyInventoryStoreImportPlan(
        replacementEnv,
        JSON.parse(JSON.stringify(replacement.planned.mutationPlan)),
        { storeRoot: replacement.storeRoot },
      ),
    ).resolves.toMatchObject({ operation: { ok: true, receipt: { outcome: "committed" } } });

    const staleSource = await plan("stale-source");
    await t.env.fs.writeFile(rulesPath, "# Source drift\n");
    await expect(
      applyInventoryStoreImportPlan(t.env, staleSource.planned.mutationPlan, {
        storeRoot: staleSource.storeRoot,
      }),
    ).resolves.toMatchObject({
      operation: { ok: false, conflict: { code: "TARGET_PRECONDITION_CONFLICT" } },
    });
    expect(await readStoreRevision(t.env, staleSource.storeRoot)).toBe(0);
    await t.env.fs.writeFile(rulesPath, "# Reviewed rules\n");

    const staleStore = await plan("stale-store");
    await publishStoreRevision(t.env, staleStore.storeRoot, 1);
    await expect(
      applyInventoryStoreImportPlan(t.env, staleStore.planned.mutationPlan, {
        storeRoot: staleStore.storeRoot,
      }),
    ).resolves.toMatchObject({
      operation: { ok: false, conflict: { code: "STALE_REVISION" } },
    });
    expect((await loadConfig(t.env, staleStore.storeRoot)).artifacts).toEqual({});

    const failed = await plan("atomic-failure", "default");
    const metadataTarget = failed.planned.mutationPlan.actions.find(
      ({ kind }) => kind === "inventory-resource-metadata",
    )?.target;
    if (!metadataTarget) throw new Error("missing metadata action");
    const failureEnv: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, options) => {
          if (path === metadataTarget) {
            throw Object.assign(new Error("controlled transaction failure"), { code: "EIO" });
          }
          return t.env.fs.publishFileAtomically(path, data, options);
        },
      },
    };
    await expect(
      applyInventoryStoreImportPlan(failureEnv, failed.planned.mutationPlan, {
        storeRoot: failed.storeRoot,
      }),
    ).resolves.toMatchObject({ operation: { ok: false, conflict: { code: "PARTIAL_FAILURE" } } });
    expect((await loadConfig(t.env, failed.storeRoot)).artifacts).toEqual({});
    expect(await readStoreRevision(t.env, failed.storeRoot)).toBe(0);
    for (const target of failed.planned.mutationPlan.actions
      .filter(({ kind }) => kind !== "inventory-collection-membership")
      .map(({ target }) => target)) {
      await expect(t.env.fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    }

    const interrupted = await plan("interrupted");
    const journalPath = operationJournalPath(interrupted.storeRoot);
    const interruptedEnv: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, options) => {
          if (
            path === journalPath &&
            typeof data === "string" &&
            data.includes('"status": "completed"')
          ) {
            throw new Error("interrupt-before-completed-journal");
          }
          return t.env.fs.publishFileAtomically(path, data, options);
        },
      },
    };
    await expect(
      applyInventoryStoreImportPlan(interruptedEnv, interrupted.planned.mutationPlan, {
        storeRoot: interrupted.storeRoot,
      }),
    ).rejects.toThrow("interrupt-before-completed-journal");
    expect(await readStoreRevision(t.env, interrupted.storeRoot)).toBe(1);
    const journal = await readOperationJournal(t.env, interrupted.storeRoot);
    if (!journal) throw new Error("missing interrupted operation journal");
    const recovered = await recoverInterruptedOperation(replacementEnv, interrupted.storeRoot, {
      operationId: journal.operationId,
    });
    expect(recovered).toMatchObject({ ok: true, receipt: { outcome: "committed" } });
    expect((await loadConfig(t.env, interrupted.storeRoot)).artifacts).toEqual({});
    for (const target of interrupted.planned.mutationPlan.actions.map(({ target }) => target)) {
      await expect(t.env.fs.lstat(target)).resolves.toBeDefined();
    }
  }, 15_000);

  it("rejects tamper and injected target actions before product observation", async () => {
    const { storeRoot, planned } = await plan("sentinel");
    const tampered = structuredClone(planned.mutationPlan);
    tampered.digest = "sha256:tampered";
    const target = t.path("home", ".codex", "forbidden-target.md");
    const injected = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: planned.mutationPlan.schemaVersion,
      planId: planned.mutationPlan.planId,
      operation: planned.mutationPlan.operation,
      baseRevision: planned.mutationPlan.baseRevision,
      normalizedInputs: planned.mutationPlan.normalizedInputs,
      targetPreconditions: [
        ...planned.mutationPlan.targetPreconditions,
        { actionId: "injected-target", target, expected: { state: "absent" } },
      ],
      actions: [
        ...planned.mutationPlan.actions,
        {
          actionId: "injected-target",
          kind: "write",
          target,
          payload: { data: "forbidden" },
          postcondition: { state: "present", fingerprint: "sha256:forged" },
        },
      ],
      expires: planned.mutationPlan.expires,
    });
    const observations: string[] = [];
    const sentinelEnv: Env = {
      ...t.env,
      fs: new Proxy(t.env.fs, {
        get:
          (_target, property) =>
          (..._args: unknown[]) => {
            observations.push(`fs:${String(property)}`);
            throw new Error("product observation reached");
          },
      }) as Env["fs"],
      secretStore: {
        get: async () => {
          observations.push("provider:get");
          throw new Error("provider observation reached");
        },
        set: async () => {
          observations.push("provider:set");
          throw new Error("provider mutation reached");
        },
        delete: async () => {
          observations.push("provider:delete");
          throw new Error("provider mutation reached");
        },
      },
    };

    for (const mutationPlan of [tampered, injected]) {
      await expect(
        applyInventoryStoreImportPlan(sentinelEnv, mutationPlan, { storeRoot }),
      ).resolves.toMatchObject({ operation: { ok: false, conflict: { code: "INVALID_PLAN" } } });
    }
    expect(observations).toEqual([]);
  });
});
