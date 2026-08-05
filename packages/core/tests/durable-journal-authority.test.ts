import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env, FsLike, SecretStore } from "../src/env.js";
import { canonicalJson, createAuthorizedMutationPlan } from "../src/protocol/canonical.js";
import { executeMutationPlan, targetState } from "../src/protocol/execute.js";
import { operationJournalPath } from "../src/protocol/journal.js";
import type {
  DurableMutationPlan,
  MutationPlan,
  OperationActionReceipt,
  OperationJournal,
} from "../src/protocol/models.js";
import { recoverInterruptedOperation } from "../src/protocol/recovery.js";
import { storeRevisionPath } from "../src/protocol/store-revision.js";
import { vaultPath } from "../src/secrets/vault.js";
import { sha256 } from "../src/store/checksum.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";
import {
  type DeterministicJournalTipState,
  deterministicMutationAuthority,
} from "./helpers/mutation-authority.js";

describe("durable journal mutation authority", () => {
  let t: TmpEnv;
  let storeRoot: string;
  let target: string;
  let journalTipState: DeterministicJournalTipState;

  beforeEach(async () => {
    t = makeTmpEnv({ randomId: () => "durable-authority" });
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    target = vaultPath(storeRoot);
    journalTipState = {};
    t.env.mutationAuthority = deterministicMutationAuthority({ journalTipState });
    await t.env.fs.mkdir(dirname(target), { recursive: true });
  });

  afterEach(() => t.cleanup());

  it("8.1/8.2 seals the durable plan and every journal publication in independent chained domains", async () => {
    const { publications } = await interruptAfterVaultReceipt();
    const latest = publications.at(-1);
    const previous = publications.at(-2);
    if (!latest || !previous) throw new Error("expected multiple journal publications");

    expect(latest.plan.authorization).toMatchObject({ domain: "durable-plan-v1" });
    expect(latest.authorization).toMatchObject({ domain: "operation-journal-v1" });
    expect(publications.map((journal) => journal.sequence)).toEqual([1, 2, 3]);
    expect(latest.sequence).toBe(previous.sequence + 1);
    expect(latest.previousJournalSeal).toBe(previous.authorization.seal);
    expect(latest.plan.authorization.seal).not.toBe(latest.authorization.seal);
  });

  it.each([
    {
      name: "altered durable plan",
      alter(journal: OperationJournal): OperationJournal {
        const changed = { ...journal.plan, digest: `sha256:${"a".repeat(64)}` };
        return { ...journal, plan: reDigestDurablePlan(changed) };
      },
    },
    {
      name: "missing durable-plan authorization",
      alter(journal: OperationJournal): OperationJournal {
        const { authorization: _authorization, ...unsignedPlan } = journal.plan;
        return {
          ...journal,
          plan: unsignedPlan as DurableMutationPlan,
        };
      },
    },
    {
      name: "missing journal authorization",
      alter(journal: OperationJournal): OperationJournal {
        const { authorization: _authorization, ...unsignedJournal } = journal;
        return unsignedJournal as OperationJournal;
      },
    },
    {
      name: "malformed exact-key authorization",
      alter(journal: OperationJournal): OperationJournal {
        return {
          ...journal,
          authorization: { ...journal.authorization, extra: true } as never,
        };
      },
    },
    {
      name: "altered receipt",
      alter(journal: OperationJournal): OperationJournal {
        const [action] = journal.actions;
        if (!action || action.status === "pending") throw new Error("expected durable receipt");
        return {
          ...journal,
          actions: [
            {
              ...action,
              receipt: { ...action.receipt, recordedAt: "2026-06-30T08:00:00.001Z" },
            },
          ],
        };
      },
    },
    {
      name: "mixed publication authorization",
      alter(
        journal: OperationJournal,
        publications: readonly OperationJournal[],
      ): OperationJournal {
        const prior = publications.at(-2);
        if (!prior) throw new Error("expected prior journal publication");
        return { ...journal, authorization: prior.authorization };
      },
    },
    {
      name: "unknown authority epoch",
      alter(journal: OperationJournal): OperationJournal {
        return {
          ...journal,
          authorization: {
            ...journal.authorization,
            authorityEpoch: journal.authorization.authorityEpoch + 1,
          },
        };
      },
    },
    {
      name: "truncated previous-seal chain",
      alter(journal: OperationJournal): OperationJournal {
        return { ...journal, previousJournalSeal: null };
      },
    },
  ])("8.1/8.3/8.4 rejects $name before claim, provider, target, or effect", async ({ alter }) => {
    const { publications } = await interruptAfterVaultReceipt();
    const latest = publications.at(-1);
    if (!latest) throw new Error("expected active journal");
    await writeRawJournal(alter(latest, publications));
    const observed = trackedRecoveryEnv(t.env, storeRoot, target);

    const result = await recoverInterruptedOperation(observed.env, storeRoot, {
      operationId: latest.operationId,
    });

    expect(result).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED" },
    });
    expect(observed.calls()).toEqual({
      claim: 0,
      productRead: 0,
      provider: 0,
      target: 0,
      effect: 0,
    });
    await expect(t.env.fs.lstat(target)).resolves.toBeDefined();
    expect(JSON.stringify(result)).not.toMatch(/test-authority|hmac-sha256|vault-after/);
  });

  it("8.1/8.4 rejects a journal copied to another Store before claim or target access", async () => {
    const { publications } = await interruptAfterVaultReceipt();
    const latest = publications.at(-1);
    if (!latest) throw new Error("expected active journal");
    const otherStoreRoot = t.path("home", "other-cellarer");
    await t.env.fs.mkdir(dirname(operationJournalPath(otherStoreRoot)), { recursive: true });
    await t.env.fs.publishFileAtomically(
      operationJournalPath(otherStoreRoot),
      `${JSON.stringify(latest, null, 2)}\n`,
      { mode: 0o600 },
    );
    const observed = trackedRecoveryEnv(t.env, otherStoreRoot, target);

    const result = await recoverInterruptedOperation(observed.env, otherStoreRoot, {
      operationId: latest.operationId,
    });

    expect(result).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED" },
    });
    expect(observed.calls()).toEqual({
      claim: 0,
      productRead: 0,
      provider: 0,
      target: 0,
      effect: 0,
    });
  });

  it("8.1/8.4 treats an older authorized journal publication as replayed and never compensates", async () => {
    const { publications } = await interruptAfterVaultReceipt();
    const replayed = publications[1];
    if (!replayed) throw new Error("expected an older authorized publication");
    await writeRawJournal(replayed);
    const observed = trackedRecoveryEnv(t.env, storeRoot, target);

    const result = await recoverInterruptedOperation(observed.env, storeRoot, {
      operationId: replayed.operationId,
    });

    expect(result).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED" },
    });
    expect(observed.calls()).toEqual({
      claim: 0,
      productRead: 0,
      provider: 0,
      target: 0,
      effect: 0,
    });
    await expect(t.env.fs.lstat(target)).resolves.toBeDefined();
  });

  it.each([
    {
      name: "missing protected tip",
      arrange(state: DeterministicJournalTipState) {
        state.tip = undefined;
      },
    },
    {
      name: "mismatched protected tip",
      arrange(state: DeterministicJournalTipState) {
        if (!state.tip) throw new Error("expected the latest protected tip");
        state.tip = { ...state.tip, seal: `hmac-sha256:${"f".repeat(64)}` };
      },
    },
    {
      name: "unavailable protected tip",
      arrange(state: DeterministicJournalTipState) {
        state.readUnavailable = true;
      },
    },
  ])("11.1 refuses an older all-receipts vault journal with $name", async ({ arrange }) => {
    const { publications } = await interruptAfterAllReceiptsPublication();
    const replayed = publications.at(-2);
    if (!replayed || replayed.actions.some((action) => action.status !== "succeeded")) {
      throw new Error("expected an older all-receipts publication");
    }
    arrange(journalTipState);
    await writeRawJournal(replayed);
    const observed = trackedRecoveryEnv(t.env, storeRoot, target);

    const result = await recoverInterruptedOperation(observed.env, storeRoot, {
      operationId: replayed.operationId,
    });

    expect(result).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED" },
    });
    expect(observed.calls()).toEqual({
      claim: 0,
      productRead: 0,
      provider: 0,
      target: 0,
      effect: 0,
    });
    await expect(t.env.fs.lstat(target)).resolves.toBeDefined();
  });

  it("11.1 makes headless restart recovery manual-only without product observation", async () => {
    const { publications } = await interruptAfterAllReceiptsPublication();
    const latest = publications.at(-1);
    if (!latest) throw new Error("expected an active journal");
    const restartedEnv: Env = {
      ...t.env,
      mutationAuthority: deterministicMutationAuthority({ journalTipState: {} }),
    };
    const observed = trackedRecoveryEnv(restartedEnv, storeRoot, target);

    const result = await recoverInterruptedOperation(observed.env, storeRoot, {
      operationId: latest.operationId,
    });

    expect(result).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED" },
    });
    expect(observed.calls()).toEqual({
      claim: 0,
      productRead: 0,
      provider: 0,
      target: 0,
      effect: 0,
    });
    await expect(t.env.fs.lstat(target)).resolves.toBeDefined();
  });

  async function interruptAfterVaultReceipt(): Promise<{
    plan: MutationPlan;
    publications: OperationJournal[];
  }> {
    const content = "vault-after";
    const digest = sha256(content);
    const actionId = sha256(
      JSON.stringify({
        mutationKind: "vault-secret-set",
        index: 0,
        kind: "publish-file",
        path: target,
        digest,
        mode: 0o600,
        currentUserOnly: true,
      }),
    );
    const plan = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: "durable-plan",
      operation: "secret-metadata",
      baseRevision: 0,
      normalizedInputs: { mutationKind: "vault-secret-set" },
      targetPreconditions: [{ actionId, target, expected: { state: "absent" } }],
      actions: [
        {
          actionId,
          kind: "publish-file",
          target,
          payload: { path: target, digest, mode: 0o600, currentUserOnly: true },
          postcondition: { state: "present", fingerprint: digest },
        },
      ],
      expires: { policy: "none" },
    });
    const publications: OperationJournal[] = [];
    const basePublish = t.env.fs.publishFileAtomically;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, options) => {
          await basePublish(path, data, options);
          if (path === operationJournalPath(storeRoot)) {
            publications.push(JSON.parse(data) as OperationJournal);
          }
        },
      },
    };
    await expect(
      executeMutationPlan(env, storeRoot, plan, async (_operationId, recordAction) => {
        await env.fs.writeFile(target, content, { mode: 0o600 });
        const receipt: OperationActionReceipt = {
          actionId,
          target,
          outcome: "applied",
          before: { state: "absent" },
          after: await targetState(env, target),
          recordedAt: env.now().toISOString(),
        };
        await recordAction(receipt);
        throw new Error("interrupt-after-vault-receipt");
      }),
    ).rejects.toThrow("interrupt-after-vault-receipt");
    return { plan, publications };
  }

  async function interruptAfterAllReceiptsPublication(): Promise<{
    plan: MutationPlan;
    publications: OperationJournal[];
  }> {
    const content = "vault-after-all-receipts";
    const digest = sha256(content);
    const actionId = sha256(
      JSON.stringify({
        mutationKind: "vault-secret-set",
        index: 0,
        kind: "publish-file",
        path: target,
        digest,
        mode: 0o600,
        currentUserOnly: true,
      }),
    );
    const plan = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: "all-receipts-plan",
      operation: "secret-metadata",
      baseRevision: 0,
      normalizedInputs: { mutationKind: "vault-secret-set" },
      targetPreconditions: [{ actionId, target, expected: { state: "absent" } }],
      actions: [
        {
          actionId,
          kind: "publish-file",
          target,
          payload: { path: target, digest, mode: 0o600, currentUserOnly: true },
          postcondition: { state: "present", fingerprint: digest },
        },
      ],
      expires: { policy: "none" },
    });
    const publications: OperationJournal[] = [];
    const basePublish = t.env.fs.publishFileAtomically;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, options) => {
          if (path === storeRevisionPath(storeRoot)) {
            throw new Error("interrupt-after-all-receipts-publication");
          }
          await basePublish(path, data, options);
          if (path === operationJournalPath(storeRoot)) {
            publications.push(JSON.parse(data) as OperationJournal);
          }
        },
      },
    };
    await expect(
      executeMutationPlan(env, storeRoot, plan, async (_operationId, recordAction) => {
        await env.fs.writeFile(target, content, { mode: 0o600 });
        await recordAction({
          actionId,
          target,
          outcome: "applied",
          before: { state: "absent" },
          after: await targetState(env, target),
          recordedAt: env.now().toISOString(),
        });
        return { actionReceipts: [] };
      }),
    ).rejects.toThrow("interrupt-after-all-receipts-publication");
    return { plan, publications };
  }

  async function writeRawJournal(journal: OperationJournal): Promise<void> {
    await t.env.fs.publishFileAtomically(
      operationJournalPath(storeRoot),
      `${JSON.stringify(journal, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
});

function reDigestDurablePlan(plan: DurableMutationPlan): DurableMutationPlan {
  const { durableDigest: _durableDigest, ...payload } = plan;
  return { ...payload, durableDigest: sha256(canonicalJson(payload)) };
}

function trackedRecoveryEnv(
  env: Env,
  storeRoot: string,
  targetPath: string,
): {
  env: Env;
  calls(): { claim: number; productRead: number; provider: number; target: number; effect: number };
} {
  let claim = 0;
  let productRead = 0;
  let provider = 0;
  let target = 0;
  let effect = 0;
  const base = env.fs;
  const fs = new Proxy(base, {
    get(inner, property, receiver) {
      const value = Reflect.get(inner, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const path = typeof args[0] === "string" ? args[0] : "";
        if (property === "writeFileExclusive") claim += 1;
        if (
          path !== operationJournalPath(storeRoot) &&
          ["lstat", "stat", "readFile", "readFileBytes", "readdir"].includes(String(property))
        ) {
          productRead += 1;
        }
        if (path === targetPath) {
          if (["lstat", "stat", "readFile", "readFileBytes"].includes(String(property))) {
            target += 1;
          }
          if (
            ["writeFile", "writeFileBytes", "publishFileAtomically", "rm", "rename"].includes(
              String(property),
            )
          ) {
            effect += 1;
          }
        }
        return (value as (...innerArgs: unknown[]) => unknown).apply(inner, args);
      };
    },
  }) as FsLike;
  const secretStore: SecretStore = {
    async get() {
      provider += 1;
      return { found: false };
    },
    async set() {
      provider += 1;
    },
    async delete() {
      provider += 1;
      return false;
    },
  };
  return {
    env: { ...env, fs, secretStore },
    calls: () => ({ claim, productRead, provider, target, effect }),
  };
}
