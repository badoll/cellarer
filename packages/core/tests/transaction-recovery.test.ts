import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  canonicalJson,
  createAuthorizedMutationPlan,
  createDurableMutationPlan,
  verifyDurableMutationPlanDigest,
} from "../src/protocol/canonical.js";
import {
  executeMutationPlan,
  type RecordOperationAction,
  targetState,
} from "../src/protocol/execute.js";
import {
  operationJournalPath,
  operationReceiptPath,
  publishOperationJournal,
  publishOperationReceipt,
  readOperationJournal,
} from "../src/protocol/journal.js";
import type {
  DurableMutationPlan,
  MutationPlan,
  OperationActionReceipt,
  OperationJournal,
  OperationReceipt,
} from "../src/protocol/models.js";
import {
  acquireStoreMutationLock,
  readStoreMutationLockOwner,
  readStoreRecoveryLockOwner,
  recoveryLockPath,
} from "../src/protocol/mutation-lock.js";
import {
  diagnoseInterruptedOperation,
  diagnoseMutationRecovery,
  recoverInterruptedOperation,
} from "../src/protocol/recovery.js";
import {
  publishStoreRevision,
  readStoreRevision,
  storeRevisionPath,
} from "../src/protocol/store-revision.js";
import { createSecretValue, withObservableKnownValues } from "../src/secrets/observable.js";
import { vaultPath } from "../src/secrets/vault.js";
import { sha256 } from "../src/store/checksum.js";
import { fingerprintTarget } from "../src/target-ownership.js";
import { createEncryptedTargetSnapshot } from "../src/target-snapshot.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("transaction journal interruption recovery", () => {
  let t: TmpEnv;
  let storeRoot: string;
  let targetA: string;

  beforeEach(async () => {
    t = makeTmpEnv({ randomId: () => "fixed" });
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    targetA = vaultPath(storeRoot);
    await t.env.fs.mkdir(dirname(targetA), { recursive: true });
    await t.env.fs.mkdir(t.path("home", ".agent"), { recursive: true });
  });

  afterEach(() => t.cleanup());

  const recoveryActionContent = (index: number) => `after-${index + 1}`;
  const recoveryActionId = (target: string, index = 0) =>
    sha256(
      JSON.stringify({
        mutationKind: "vault-secret-set",
        index,
        kind: "publish-file",
        path: target,
        digest: sha256(recoveryActionContent(index)),
        mode: 0o600,
        currentUserOnly: true,
      }),
    );

  function plan(targets = [targetA]): MutationPlan {
    return createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: "plan-fixed",
      operation: "secret-metadata",
      baseRevision: 0,
      normalizedInputs: { mutationKind: "vault-secret-set" },
      actions: targets.map((target, index) => ({
        actionId: recoveryActionId(target, index),
        kind: "publish-file",
        target,
        payload: {
          path: target,
          digest: sha256(recoveryActionContent(index)),
          mode: 0o600,
          currentUserOnly: true,
        },
        postcondition: {
          state: "present" as const,
          fingerprint: sha256(recoveryActionContent(index)),
        },
      })),
      targetPreconditions: targets.map((target, index) => ({
        actionId: recoveryActionId(target, index),
        target,
        expected: { state: "absent" },
      })),
      expires: { policy: "none" },
    });
  }

  async function writeAction(
    env: Env,
    mutationPlan: MutationPlan,
    index: number,
    recordAction: RecordOperationAction,
  ): Promise<OperationActionReceipt> {
    const action = mutationPlan.actions[index];
    const precondition = mutationPlan.targetPreconditions[index];
    if (!action || !precondition) throw new Error("missing test action");
    await env.fs.writeFile(action.target, recoveryActionContent(index));
    const receipt: OperationActionReceipt = {
      actionId: action.actionId,
      target: action.target,
      outcome: "applied",
      before: precondition.expected,
      after: await targetState(env, action.target),
      recordedAt: env.now().toISOString(),
    };
    await recordAction(receipt);
    return receipt;
  }

  async function seedPendingJournalWithLock(
    hostname: string,
    owner: { processId?: number; acquiredAt?: string } = {},
  ): Promise<void> {
    const mutationPlan = plan();
    const timestamp = t.env.now().toISOString();
    await publishOperationJournal(t.env, storeRoot, {
      schemaVersion: 1,
      operationId: "operation-fixed",
      plan: createDurableMutationPlan(t.env, storeRoot, mutationPlan),
      nextRevision: 1,
      status: "executing",
      startedAt: timestamp,
      updatedAt: timestamp,
      actions: [{ actionId: recoveryActionId(targetA), target: targetA, status: "pending" }],
    });
    const acquired = await acquireStoreMutationLock(t.env, storeRoot, {
      operationId: "operation-fixed",
      processId: owner.processId ?? 4242,
      hostname,
      acquiredAt: owner.acquiredAt ?? timestamp,
    });
    if (!acquired.ok) throw new Error("expected test mutation lock acquisition");
  }

  it("binds requested recovery diagnosis and wrong-id recovery to the requested operation", async () => {
    await expect(
      diagnoseInterruptedOperation(t.env, storeRoot, "operation-missing"),
    ).resolves.toEqual({
      found: false,
      operationId: "operation-missing",
      status: "not-found",
      message: "requested operation is not the active recoverable operation",
    });

    await seedPendingJournalWithLock(t.env.hostname());
    await expect(
      diagnoseInterruptedOperation(t.env, storeRoot, "operation-other"),
    ).resolves.toEqual({
      found: false,
      operationId: "operation-other",
      status: "not-found",
      message: "requested operation is not the active recoverable operation",
    });
    await expect(
      diagnoseInterruptedOperation(t.env, storeRoot, "operation-fixed"),
    ).resolves.toMatchObject({
      found: true,
      operationId: "operation-fixed",
      diagnosis: { journal: { operationId: "operation-fixed" } },
    });

    const wrong = await recoverInterruptedOperation(t.env, storeRoot, {
      operationId: "operation-other",
    });
    expect(wrong).toEqual({
      ok: false,
      conflict: {
        code: "MANUAL_RECOVERY_REQUIRED",
        message: "manual recovery is required",
        operationId: "operation-other",
        targets: [],
        guidance: "requested operation is not the active recoverable operation",
      },
    });
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      operationId: "operation-fixed",
      status: "executing",
    });
    await expect(readStoreMutationLockOwner(t.env, storeRoot)).resolves.toMatchObject({
      operationId: "operation-fixed",
    });
    await expect(readStoreRecoveryLockOwner(t.env, storeRoot)).resolves.toBeNull();
  });

  it("rejects wrong POSIX modes for signed journal, revision, and receipt publications", async () => {
    const mutationPlan = plan();
    const timestamp = t.env.now().toISOString();
    const journal: OperationJournal = {
      schemaVersion: 1,
      operationId: "operation-fixed",
      plan: createDurableMutationPlan(t.env, storeRoot, mutationPlan),
      nextRevision: 1,
      status: "prepared",
      startedAt: timestamp,
      updatedAt: timestamp,
      actions: [{ actionId: recoveryActionId(targetA), target: targetA, status: "pending" }],
    };
    const receipt: OperationReceipt = {
      schemaVersion: 1,
      operationId: "operation-fixed",
      planId: mutationPlan.planId,
      planDigest: mutationPlan.digest,
      operation: mutationPlan.operation,
      baseRevision: 0,
      resultingRevision: 0,
      outcome: "compensated",
      actionReceipts: [],
      startedAt: timestamp,
      completedAt: timestamp,
    };
    const originalPublish = t.env.fs.publishFileAtomically;
    const signedPaths = new Set([
      operationJournalPath(storeRoot),
      storeRevisionPath(storeRoot),
      operationReceiptPath(storeRoot, receipt.operationId),
    ]);
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          await originalPublish(path, data, opts);
          if (signedPaths.has(path)) await t.env.fs.chmod(path, 0o644);
        },
      },
    };

    await expect(publishOperationJournal(env, storeRoot, journal)).rejects.toMatchObject({
      code: "PUBLICATION_POSTCONDITION_FAILED",
    });
    await expect(publishStoreRevision(env, storeRoot, 1)).rejects.toMatchObject({
      code: "PUBLICATION_POSTCONDITION_FAILED",
    });
    await expect(publishOperationReceipt(env, storeRoot, receipt)).rejects.toMatchObject({
      code: "PUBLICATION_POSTCONDITION_FAILED",
    });
  });

  it("persists write-ahead intent before the first target action", async () => {
    const mutationPlan = plan();

    await expect(
      executeMutationPlan(t.env, storeRoot, mutationPlan, async (_operationId, _recordAction) => {
        const journal = await readOperationJournal(t.env, storeRoot);
        expect(journal).toMatchObject({
          operationId: "operation-fixed",
          status: "executing",
          actions: [{ actionId: recoveryActionId(targetA), status: "pending" }],
        });
        throw new Error("interrupt-before-first-action");
      }),
    ).rejects.toThrow("interrupt-before-first-action");

    expect(await diagnoseMutationRecovery(t.env, storeRoot)).toMatchObject({
      status: "manual-recovery-required",
      journal: { status: "executing" },
    });
    await expect(t.env.fs.lstat(targetA)).rejects.toThrow();
  });

  it("preserves fixed journal keys through short-value redaction and keeps recovery verifiable", async () => {
    const mutationPlan = plan();
    const timestamp = t.env.now().toISOString();
    const env = withObservableKnownValues(t.env, [createSecretValue("planId")]);
    const durablePlan = createDurableMutationPlan(env, storeRoot, mutationPlan);
    await publishOperationJournal(env, storeRoot, {
      schemaVersion: 1,
      operationId: "operation-fixed",
      plan: durablePlan,
      nextRevision: 1,
      status: "executing",
      startedAt: timestamp,
      updatedAt: timestamp,
      actions: [{ actionId: recoveryActionId(targetA), target: targetA, status: "pending" }],
    });
    const acquired = await acquireStoreMutationLock(env, storeRoot, {
      operationId: "operation-fixed",
      processId: 4242,
      hostname: env.hostname(),
      acquiredAt: timestamp,
    });
    if (!acquired.ok) throw new Error("expected test mutation lock acquisition");

    const persisted = await readOperationJournal(env, storeRoot);
    expect(persisted?.plan.planId).toBe("plan-fixed");
    expect(persisted && verifyDurableMutationPlanDigest(persisted.plan)).toBe(true);
    await expect(
      recoverInterruptedOperation({ ...env, probeProcessLiveness: async () => "dead" }, storeRoot, {
        operationId: "operation-fixed",
      }),
    ).resolves.toMatchObject({ ok: true, receipt: { outcome: "compensated" } });
  });

  it("rejects a journal instead of publishing a nested known-value payload key", async () => {
    const payloadKeyCanary = "journal-payload-secret-key";
    const mutationPlan = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: "nested-payload-key",
      operation: "secret-metadata",
      baseRevision: 0,
      normalizedInputs: { mutationKind: "keychain-secret-set" },
      actions: [
        {
          actionId: "action-1",
          kind: "keychain-secret-set",
          target: targetA,
          payload: {
            provider: "keychain",
            service: "cellarer",
            name: "TEST_KEY",
            metadata: { [payloadKeyCanary]: "user-value" },
          },
        },
      ],
      targetPreconditions: [
        { actionId: "action-1", target: targetA, expected: { state: "absent" } },
      ],
      expires: { policy: "none" },
    });
    const env = withObservableKnownValues(t.env, [createSecretValue(payloadKeyCanary)]);
    const timestamp = env.now().toISOString();

    await expect(
      publishOperationJournal(env, storeRoot, {
        schemaVersion: 1,
        operationId: "operation-nested-payload-key",
        plan: createDurableMutationPlan(t.env, storeRoot, mutationPlan),
        nextRevision: 1,
        status: "prepared",
        startedAt: timestamp,
        updatedAt: timestamp,
        actions: [{ actionId: "action-1", target: targetA, status: "pending" }],
      }),
    ).rejects.toThrow(/journal.*invalid|digest.*invalid/i);
    await expect(t.env.fs.lstat(operationJournalPath(storeRoot))).rejects.toThrow();
  });

  it("never persists raw plan payloads or state publication content in a crash journal", async () => {
    const plaintextSecret = "journal-canary-secret-value";
    const originalTargetContent = "journal-canary-original-target-content";
    const statePath = join(storeRoot, "state.json");
    const mutationPlan = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: "plan-sensitive",
      operation: "apply",
      baseRevision: 0,
      normalizedInputs: {
        preview: { before: originalTargetContent, after: plaintextSecret },
      },
      actions: [
        {
          actionId: "action-1",
          kind: "write",
          target: targetA,
          payload: { content: plaintextSecret, previewBefore: originalTargetContent },
        },
      ],
      targetPreconditions: [
        { actionId: "action-1", target: targetA, expected: { state: "absent" } },
      ],
      expires: { policy: "none" },
    });
    const originalPublish = t.env.fs.publishFileAtomically;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          if (path === statePath) throw new Error("interrupt-sensitive-state-publication");
          await originalPublish(path, data, opts);
        },
      },
    };

    await expect(
      executeMutationPlan(env, storeRoot, mutationPlan, async (_operationId, recordAction) => ({
        actionReceipts: [await writeAction(env, mutationPlan, 0, recordAction)],
        statePublications: [
          {
            path: statePath,
            data: `${JSON.stringify({ content: plaintextSecret, before: originalTargetContent })}\n`,
            mode: 0o600,
          },
        ],
      })),
    ).rejects.toThrow("interrupt-sensitive-state-publication");

    const durableJournal = await t.env.fs.readFile(operationJournalPath(storeRoot));
    expect(durableJournal).not.toContain(plaintextSecret);
    expect(durableJournal).not.toContain(originalTargetContent);
  });

  it("does not invent an action receipt when interrupted after the target write", async () => {
    const mutationPlan = plan();
    const journalPath = operationJournalPath(storeRoot);
    const original = t.env.fs.publishFileAtomically;
    let interrupted = false;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          if (!interrupted && path === journalPath && data.includes('"status": "succeeded"')) {
            interrupted = true;
            throw new Error("interrupt-before-action-receipt");
          }
          await original(path, data, opts);
        },
      },
    };

    await expect(
      executeMutationPlan(env, storeRoot, mutationPlan, async (_operationId, recordAction) => {
        await writeAction(env, mutationPlan, 0, recordAction);
        return { actionReceipts: [] };
      }),
    ).rejects.toThrow("interrupt-before-action-receipt");

    expect(await readOperationJournal(t.env, storeRoot)).toMatchObject({
      status: "executing",
      actions: [{ actionId: recoveryActionId(targetA), status: "pending" }],
    });
    const recovered = await recoverInterruptedOperation(t.env, storeRoot, {
      operationId: "operation-fixed",
    });
    expect(recovered).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED", targets: [] },
    });
    await expect(t.env.fs.readFile(targetA)).resolves.toBe("after-1");
  });

  it("finalizes from persisted after-evidence when revision publication is interrupted", async () => {
    const mutationPlan = plan();
    const revisionPath = storeRevisionPath(storeRoot);
    const original = t.env.fs.publishFileAtomically;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          if (path === revisionPath) throw new Error("interrupt-before-revision");
          await original(path, data, opts);
        },
      },
    };

    await expect(
      executeMutationPlan(env, storeRoot, mutationPlan, async (_operationId, recordAction) => ({
        actionReceipts: [await writeAction(env, mutationPlan, 0, recordAction)],
      })),
    ).rejects.toThrow("interrupt-before-revision");
    expect(await readOperationJournal(t.env, storeRoot)).toMatchObject({
      status: "publishing-state",
      actions: [{ status: "succeeded" }],
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);

    const recovered = await recoverInterruptedOperation(t.env, storeRoot, {
      operationId: "operation-fixed",
    });
    expect(recovered).toMatchObject({
      ok: true,
      receipt: { outcome: "committed", resultingRevision: 1 },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
    await expect(t.env.fs.lstat(operationJournalPath(storeRoot))).rejects.toThrow();
    await expect(
      t.env.fs.readFile(operationReceiptPath(storeRoot, "operation-fixed")),
    ).resolves.toContain('"outcome": "committed"');
  });

  it("does not finalize recovery when revision publication silently does nothing", async () => {
    const mutationPlan = plan();
    const revisionPath = storeRevisionPath(storeRoot);
    const originalPublish = t.env.fs.publishFileAtomically;
    const crashingEnv: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          if (path === revisionPath) throw new Error("interrupt-before-revision");
          await originalPublish(path, data, opts);
        },
      },
    };
    await expect(
      executeMutationPlan(
        crashingEnv,
        storeRoot,
        mutationPlan,
        async (_operationId, recordAction) => ({
          actionReceipts: [await writeAction(crashingEnv, mutationPlan, 0, recordAction)],
        }),
      ),
    ).rejects.toThrow("interrupt-before-revision");
    const recoveryEnv: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          if (path === revisionPath) return;
          await originalPublish(path, data, opts);
        },
      },
    };

    const result = await recoverInterruptedOperation(recoveryEnv, storeRoot, {
      operationId: "operation-fixed",
    });

    expect(result).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED", targets: [revisionPath] },
      journal: { status: "recovery-required" },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "recovery-required",
    });
  });

  it("requires recovery when a digest-only state publication was interrupted", async () => {
    const mutationPlan = plan();
    const statePath = join(storeRoot, "state.json");
    const stateData = '{"version":2,"owners":[]}\n';
    const original = t.env.fs.publishFileAtomically;
    let interrupted = false;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          if (!interrupted && path === statePath) {
            interrupted = true;
            throw new Error("interrupt-state-publication");
          }
          await original(path, data, opts);
        },
      },
    };

    await expect(
      executeMutationPlan(env, storeRoot, mutationPlan, async (_operationId, recordAction) => ({
        actionReceipts: [await writeAction(env, mutationPlan, 0, recordAction)],
        statePublications: [{ path: statePath, data: stateData, mode: 0o600 }],
      })),
    ).rejects.toThrow("interrupt-state-publication");
    expect(await readOperationJournal(t.env, storeRoot)).toMatchObject({
      status: "publishing-state",
      statePublications: [{ path: statePath, digest: expect.stringMatching(/^sha256:/) }],
    });
    await expect(t.env.fs.lstat(statePath)).rejects.toThrow();

    expect(
      await recoverInterruptedOperation(t.env, storeRoot, { operationId: "operation-fixed" }),
    ).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED", targets: [] },
    });
    await expect(t.env.fs.lstat(statePath)).rejects.toThrow();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
  });

  it("does not finalize a state publication whose signed mode is wrong", async () => {
    const mutationPlan = plan();
    const statePath = join(storeRoot, "state.json");
    const stateData = '{"version":2,"owners":[]}\n';
    await t.env.fs.publishFileAtomically(statePath, stateData, { mode: 0o644 });
    const after = await writeAction(t.env, mutationPlan, 0, async () => {});
    const timestamp = t.env.now().toISOString();
    await publishOperationJournal(t.env, storeRoot, {
      schemaVersion: 1,
      operationId: "operation-fixed",
      plan: createDurableMutationPlan(t.env, storeRoot, mutationPlan),
      nextRevision: 1,
      status: "publishing-state",
      startedAt: timestamp,
      updatedAt: timestamp,
      actions: [
        {
          actionId: recoveryActionId(targetA),
          target: targetA,
          status: "succeeded",
          receipt: after,
        },
      ],
      statePublications: [{ path: statePath, digest: sha256(stateData), mode: 0o600 }],
    });

    const result = await recoverInterruptedOperation(t.env, storeRoot, {
      operationId: "operation-fixed",
    });

    expect(result).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED", targets: [] },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
  });

  it("finalizes idempotently when interrupted after revision publication", async () => {
    const mutationPlan = plan();
    const journalPath = operationJournalPath(storeRoot);
    const original = t.env.fs.publishFileAtomically;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          if (path === journalPath && data.includes('"status": "completed"')) {
            throw new Error("interrupt-before-finalize");
          }
          await original(path, data, opts);
        },
      },
    };

    await expect(
      executeMutationPlan(env, storeRoot, mutationPlan, async (_operationId, recordAction) => ({
        actionReceipts: [await writeAction(env, mutationPlan, 0, recordAction)],
      })),
    ).rejects.toThrow("interrupt-before-finalize");
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);

    const recovered = await recoverInterruptedOperation(t.env, storeRoot, {
      operationId: "operation-fixed",
    });
    expect(recovered).toMatchObject({ ok: true, receipt: { outcome: "committed" } });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
  });

  it("keeps the exact completed receipt when receipt publication is interrupted", async () => {
    const mutationPlan = plan();
    const receiptPath = operationReceiptPath(storeRoot, "operation-fixed");
    const original = t.env.fs.publishFileAtomically;
    let interrupted = false;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          if (!interrupted && path === receiptPath) {
            interrupted = true;
            throw new Error("interrupt-receipt-publication");
          }
          await original(path, data, opts);
        },
      },
    };

    await expect(
      executeMutationPlan(env, storeRoot, mutationPlan, async (_operationId, recordAction) => ({
        actionReceipts: [await writeAction(env, mutationPlan, 0, recordAction)],
      })),
    ).rejects.toThrow("interrupt-receipt-publication");
    expect(await readOperationJournal(t.env, storeRoot)).toMatchObject({
      status: "completed",
      completedReceipt: {
        operationId: "operation-fixed",
        outcome: "committed",
        resultingRevision: 1,
      },
    });

    expect(
      await recoverInterruptedOperation(t.env, storeRoot, { operationId: "operation-fixed" }),
    ).toMatchObject({ ok: true, receipt: { outcome: "committed", resultingRevision: 1 } });
    await expect(t.env.fs.readFile(receiptPath)).resolves.toContain('"outcome": "committed"');
  });

  it("retains a completed recovery journal when receipt read-back is corrupt", async () => {
    const mutationPlan = plan();
    const receiptPath = operationReceiptPath(storeRoot, "operation-fixed");
    const originalPublish = t.env.fs.publishFileAtomically;
    let interrupted = false;
    const crashingEnv: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          if (!interrupted && path === receiptPath) {
            interrupted = true;
            throw new Error("interrupt-receipt-publication");
          }
          await originalPublish(path, data, opts);
        },
      },
    };
    await expect(
      executeMutationPlan(
        crashingEnv,
        storeRoot,
        mutationPlan,
        async (_operationId, recordAction) => ({
          actionReceipts: [await writeAction(crashingEnv, mutationPlan, 0, recordAction)],
        }),
      ),
    ).rejects.toThrow("interrupt-receipt-publication");
    const recoveryEnv: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          await originalPublish(path, data, opts);
          if (path === receiptPath) await t.env.fs.writeFile(path, "corrupt receipt\n");
        },
      },
    };

    const result = await recoverInterruptedOperation(recoveryEnv, storeRoot, {
      operationId: "operation-fixed",
    });

    expect(result).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED", targets: [receiptPath] },
      journal: { status: "completed" },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(t.env.fs.readFile(receiptPath)).resolves.toBe("corrupt receipt\n");
  });

  it("compensates only receipts with provable restorable before-state", async () => {
    const mutationPlan = plan();

    await expect(
      executeMutationPlan(t.env, storeRoot, mutationPlan, async (_operationId, recordAction) => {
        await writeAction(t.env, mutationPlan, 0, recordAction);
        throw new Error("interrupt-before-second-action");
      }),
    ).rejects.toThrow("interrupt-before-second-action");

    const recovered = await recoverInterruptedOperation(t.env, storeRoot, {
      operationId: "operation-fixed",
    });
    expect(recovered).toMatchObject({
      ok: true,
      receipt: { outcome: "compensated", resultingRevision: 0 },
    });
    await expect(t.env.fs.lstat(targetA)).rejects.toThrow();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
  });

  it("retains a completed journal through lock-release failure for explicit recovery", async () => {
    const mutationPlan = plan();
    const lockPath = join(storeRoot, "mutation.lock");
    const originalRm = t.env.fs.rm;
    let failedRelease = false;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        rm: async (path, opts) => {
          if (!failedRelease && path === lockPath) {
            failedRelease = true;
            throw new Error("interrupt-before-lock-release");
          }
          await originalRm(path, opts);
        },
      },
    };

    await expect(
      executeMutationPlan(env, storeRoot, mutationPlan, async (_operationId, recordAction) => ({
        actionReceipts: [await writeAction(env, mutationPlan, 0, recordAction)],
      })),
    ).rejects.toThrow("interrupt-before-lock-release");

    expect(await diagnoseMutationRecovery(t.env, storeRoot)).toMatchObject({
      status: "completed-pending-cleanup",
      journal: { status: "completed" },
      lockOwner: { operationId: "operation-fixed" },
    });
    const deadOwnerEnv: Env = {
      ...t.env,
      probeProcessLiveness: async () => "dead",
    };
    expect(
      await recoverInterruptedOperation(deadOwnerEnv, storeRoot, {
        operationId: "operation-fixed",
      }),
    ).toMatchObject({ ok: true, receipt: { outcome: "committed" } });
    await expect(t.env.fs.lstat(lockPath)).rejects.toThrow();
    await expect(t.env.fs.lstat(operationJournalPath(storeRoot))).rejects.toThrow();
  });

  it("allows only one concurrent recovery to hold the store mutation boundary", async () => {
    const mutationPlan = plan();
    await expect(
      executeMutationPlan(t.env, storeRoot, mutationPlan, async (_operationId, recordAction) => {
        await writeAction(t.env, mutationPlan, 0, recordAction);
        throw new Error("interrupt-before-second-action");
      }),
    ).rejects.toThrow("interrupt-before-second-action");

    let releaseObservation!: () => void;
    const observationGate = new Promise<void>((resolve) => {
      releaseObservation = resolve;
    });
    let observationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      observationStarted = resolve;
    });
    const baseFs = t.env.fs;
    let paused = false;
    const recoveryEnv: Env = {
      ...t.env,
      fs: {
        ...baseFs,
        lstat: async (path) => {
          if (path === targetA && !paused) {
            paused = true;
            observationStarted();
            await observationGate;
          }
          return baseFs.lstat(path);
        },
      },
    };

    const first = recoverInterruptedOperation(recoveryEnv, storeRoot, {
      operationId: "operation-fixed",
    });
    await started;
    const second = await recoverInterruptedOperation(t.env, storeRoot, {
      operationId: "operation-fixed",
    });
    releaseObservation();
    expect(second).toMatchObject({
      ok: false,
      conflict: {
        code: "MANUAL_RECOVERY_REQUIRED",
      },
    });
    await expect(first).resolves.toMatchObject({
      ok: true,
      receipt: { outcome: "compensated" },
    });
  });

  it("blocks recovery while the journal owner is still live", async () => {
    const mutationPlan = plan();
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    const execution = executeMutationPlan(
      t.env,
      storeRoot,
      mutationPlan,
      async (_operationId, recordAction) => {
        executionStarted();
        await executionGate;
        return {
          actionReceipts: [await writeAction(t.env, mutationPlan, 0, recordAction)],
        };
      },
    );
    await started;

    const recovered = await recoverInterruptedOperation(t.env, storeRoot, {
      operationId: "operation-fixed",
    });
    const duringRecoveryAttempt = {
      journal: await readOperationJournal(t.env, storeRoot),
      target: await targetState(t.env, targetA),
      revision: await readStoreRevision(t.env, storeRoot),
      mutationOwner: await readStoreMutationLockOwner(t.env, storeRoot),
      recoveryOwner: await readStoreRecoveryLockOwner(t.env, storeRoot),
    };
    releaseExecution();
    const executionResult = await execution;

    expect(recovered).toMatchObject({
      ok: false,
      conflict: {
        code: "LOCK_CONFLICT",
        owner: { operationId: "operation-fixed" },
      },
    });
    expect(duringRecoveryAttempt).toMatchObject({
      journal: {
        operationId: "operation-fixed",
        status: "executing",
        actions: [{ status: "pending" }],
      },
      target: { state: "absent" },
      revision: 0,
      mutationOwner: { operationId: "operation-fixed" },
      recoveryOwner: null,
    });
    expect(executionResult).toMatchObject({
      ok: true,
      receipt: { outcome: "committed", resultingRevision: 1 },
    });
    await expect(targetState(t.env, targetA)).resolves.toMatchObject({ state: "present" });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
    await expect(readStoreMutationLockOwner(t.env, storeRoot)).resolves.toBeNull();
    await expect(readStoreRecoveryLockOwner(t.env, storeRoot)).resolves.toBeNull();
  });

  it("fails closed when a matching lock owner hostname is not confirmed local", async () => {
    await seedPendingJournalWithLock("remote-host");
    const recoveryEnv = {
      ...t.env,
      probeProcessLiveness: async () => "dead" as const,
    } as Env;

    await expect(
      recoverInterruptedOperation(recoveryEnv, storeRoot, {
        operationId: "operation-fixed",
      }),
    ).resolves.toMatchObject({
      ok: false,
      conflict: {
        code: "LOCK_CONFLICT",
        owner: { operationId: "operation-fixed", hostname: "remote-host" },
      },
    });
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "executing",
    });
    await expect(readStoreMutationLockOwner(t.env, storeRoot)).resolves.toMatchObject({
      operationId: "operation-fixed",
    });
  });

  it("fails closed when matching local owner liveness is unknown", async () => {
    await seedPendingJournalWithLock(t.env.hostname());
    const recoveryEnv = {
      ...t.env,
      probeProcessLiveness: async () => "unknown" as const,
    } as Env;

    await expect(
      recoverInterruptedOperation(recoveryEnv, storeRoot, {
        operationId: "operation-fixed",
      }),
    ).resolves.toMatchObject({
      ok: false,
      conflict: {
        code: "LOCK_CONFLICT",
        owner: { operationId: "operation-fixed", hostname: t.env.hostname() },
      },
    });
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "executing",
    });
    await expect(readStoreMutationLockOwner(t.env, storeRoot)).resolves.toMatchObject({
      operationId: "operation-fixed",
    });
  });

  it("treats an active reused PID as live regardless of lock age", async () => {
    await seedPendingJournalWithLock(t.env.hostname(), {
      acquiredAt: "2020-01-01T00:00:00.000Z",
    });
    const recoveryEnv: Env = {
      ...t.env,
      probeProcessLiveness: async () => "alive",
    };

    await expect(
      recoverInterruptedOperation(recoveryEnv, storeRoot, {
        operationId: "operation-fixed",
      }),
    ).resolves.toMatchObject({
      ok: false,
      conflict: {
        code: "LOCK_CONFLICT",
        owner: {
          operationId: "operation-fixed",
          acquiredAt: "2020-01-01T00:00:00.000Z",
        },
      },
    });
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "executing",
    });
  });

  it("retains the recovery claim when recovery crashes after acquiring it", async () => {
    const mutationPlan = plan();
    await expect(
      executeMutationPlan(t.env, storeRoot, mutationPlan, async (_operationId, recordAction) => {
        await writeAction(t.env, mutationPlan, 0, recordAction);
        throw new Error("interrupt-after-action");
      }),
    ).rejects.toThrow("interrupt-after-action");

    const baseFs = t.env.fs;
    let injected = false;
    const crashingEnv: Env = {
      ...t.env,
      fs: {
        ...baseFs,
        lstat: async (path) => {
          if (path === targetA && !injected) {
            injected = true;
            throw new Error("recovery-probe-crash");
          }
          return baseFs.lstat(path);
        },
      },
    };

    await expect(
      recoverInterruptedOperation(crashingEnv, storeRoot, {
        operationId: "operation-fixed",
      }),
    ).rejects.toThrow("recovery-probe-crash");
    await expect(readStoreMutationLockOwner(t.env, storeRoot)).resolves.toMatchObject({
      operationId: "recovery-fixed",
    });
    await expect(
      recoverInterruptedOperation(t.env, storeRoot, { operationId: "operation-fixed" }),
    ).resolves.toMatchObject({
      ok: false,
      conflict: {
        code: "MANUAL_RECOVERY_REQUIRED",
      },
    });
  });

  it("never clears a crashed recovery lock by age", async () => {
    await seedPendingJournalWithLock(t.env.hostname());
    const baseFs = t.env.fs;
    let injected = false;
    const crashingEnv: Env = {
      ...t.env,
      probeProcessLiveness: async () => "dead",
      fs: {
        ...baseFs,
        lstat: async (path) => {
          if (path === targetA && !injected) {
            injected = true;
            throw new Error("recovery-probe-crash");
          }
          return baseFs.lstat(path);
        },
      },
    };
    await expect(
      recoverInterruptedOperation(crashingEnv, storeRoot, {
        operationId: "operation-fixed",
      }),
    ).rejects.toThrow("recovery-probe-crash");
    const recoveryOwner = await readStoreRecoveryLockOwner(t.env, storeRoot);
    if (!recoveryOwner) throw new Error("expected retained recovery claim");
    await t.env.fs.publishFileAtomically(
      recoveryLockPath(storeRoot),
      `${JSON.stringify({
        ...recoveryOwner,
        acquiredAt: "2020-01-01T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      recoverInterruptedOperation(
        { ...t.env, probeProcessLiveness: async () => "dead" },
        storeRoot,
        { operationId: "operation-fixed" },
      ),
    ).resolves.toMatchObject({
      ok: false,
      conflict: {
        code: "MANUAL_RECOVERY_REQUIRED",
      },
    });
    await expect(readStoreMutationLockOwner(t.env, storeRoot)).resolves.toMatchObject({
      operationId: "operation-fixed",
    });
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "executing",
    });
  });

  it("rejects a journal action that is not authorized by the signed plan", async () => {
    const externalTarget = t.path("outside", "do-not-delete.txt");
    await t.env.fs.mkdir(join(t.root, "outside"), { recursive: true });
    await t.env.fs.writeFile(externalTarget, "external");
    const mutationPlan = plan();
    const after = await targetState(t.env, externalTarget);
    const tampered: OperationJournal = {
      schemaVersion: 1,
      operationId: "operation-fixed",
      plan: createDurableMutationPlan(t.env, storeRoot, mutationPlan),
      nextRevision: 1,
      status: "executing",
      startedAt: t.env.now().toISOString(),
      updatedAt: t.env.now().toISOString(),
      actions: [
        {
          actionId: "action-1",
          target: externalTarget,
          status: "succeeded",
          receipt: {
            actionId: "action-1",
            target: externalTarget,
            outcome: "applied",
            before: { state: "absent" },
            after,
            recordedAt: t.env.now().toISOString(),
          },
        },
      ],
    };
    await t.env.fs.publishFileAtomically(
      operationJournalPath(storeRoot),
      `${JSON.stringify(tampered, null, 2)}\n`,
      { mode: 0o600 },
    );

    let readRejected = false;
    try {
      await readOperationJournal(t.env, storeRoot);
    } catch {
      readRejected = true;
    }
    const diagnosis = await diagnoseMutationRecovery(t.env, storeRoot);
    const recovery = await recoverInterruptedOperation(t.env, storeRoot, {
      operationId: "operation-fixed",
    });

    expect(readRejected).toBe(true);
    expect(diagnosis).toMatchObject({ status: "manual-recovery-required", journal: null });
    expect(recovery).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED" },
    });
    await expect(t.env.fs.readFile(externalTarget)).resolves.toBe("external");
  });

  it.each([
    {
      name: "future embedded plan schema",
      alter: (durablePlan: DurableMutationPlan) => ({ ...durablePlan, schemaVersion: 2 }),
      diagnostic: /invalid operation journal/i,
    },
    {
      name: "unknown embedded expiry policy",
      alter: (durablePlan: DurableMutationPlan) => ({
        ...durablePlan,
        expires: { policy: "after-approval" },
      }),
      diagnostic: /invalid operation journal/i,
    },
    {
      name: "an invalid embedded expires-at calendar date",
      alter: (durablePlan: DurableMutationPlan) => ({
        ...durablePlan,
        expires: { policy: "expires-at", expiresAt: "2027-02-29T00:00:00.000Z" },
      }),
      diagnostic: /invalid operation journal/i,
    },
  ])("fails closed for a v1 journal with $name", async (testCase) => {
    const durablePlan = createDurableMutationPlan(t.env, storeRoot, plan());
    const altered = testCase.alter(durablePlan) as unknown as DurableMutationPlan;
    const { authorization, durableDigest: _durableDigest, ...durableInput } = altered;
    const unsupportedPlan = {
      ...durableInput,
      durableDigest: sha256(canonicalJson(durableInput)),
      authorization,
    } as DurableMutationPlan;
    expect(verifyDurableMutationPlanDigest(unsupportedPlan)).toBe(true);
    const timestamp = t.env.now().toISOString();
    const journal = {
      schemaVersion: 1,
      operationId: "operation-fixed",
      plan: unsupportedPlan,
      nextRevision: 1,
      status: "executing",
      startedAt: timestamp,
      updatedAt: timestamp,
      actions: [{ actionId: "action-1", target: targetA, status: "pending" }],
    } as OperationJournal;
    const serialized = `${JSON.stringify(journal, null, 2)}\n`;
    await t.env.fs.publishFileAtomically(operationJournalPath(storeRoot), serialized, {
      mode: 0o600,
    });

    await expect(readOperationJournal(t.env, storeRoot)).rejects.toThrow(testCase.diagnostic);
    await expect(diagnoseMutationRecovery(t.env, storeRoot)).resolves.toMatchObject({
      status: "manual-recovery-required",
      journal: null,
    });
    await expect(
      recoverInterruptedOperation(t.env, storeRoot, { operationId: "operation-fixed" }),
    ).resolves.toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED" },
    });

    await expect(t.env.fs.readFile(operationJournalPath(storeRoot))).resolves.toBe(serialized);
    await expect(t.env.fs.lstat(targetA)).rejects.toThrow();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
  });

  it("rejects a completed receipt that is not identical to the journal evidence", async () => {
    const mutationPlan = plan();
    const actionReceipt: OperationActionReceipt = {
      actionId: recoveryActionId(targetA),
      target: targetA,
      outcome: "applied",
      before: { state: "absent" },
      after: mutationPlan.actions[0]?.postcondition ?? { state: "absent" },
      recordedAt: t.env.now().toISOString(),
    };
    const fakeReceipt: OperationReceipt = {
      schemaVersion: 1,
      operationId: "operation-fixed",
      planId: "attacker-plan",
      planDigest: mutationPlan.digest,
      operation: "apply",
      baseRevision: 0,
      resultingRevision: 1,
      outcome: "committed",
      actionReceipts: [],
      startedAt: t.env.now().toISOString(),
      completedAt: t.env.now().toISOString(),
    };
    const tampered: OperationJournal = {
      schemaVersion: 1,
      operationId: "operation-fixed",
      plan: createDurableMutationPlan(t.env, storeRoot, mutationPlan),
      nextRevision: 1,
      status: "completed",
      startedAt: t.env.now().toISOString(),
      updatedAt: t.env.now().toISOString(),
      actions: [
        {
          actionId: recoveryActionId(targetA),
          target: targetA,
          status: "succeeded",
          receipt: actionReceipt,
        },
      ],
      completedReceipt: fakeReceipt,
    };
    await t.env.fs.publishFileAtomically(
      operationJournalPath(storeRoot),
      `${JSON.stringify(tampered, null, 2)}\n`,
      { mode: 0o600 },
    );
    await publishStoreRevision(t.env, storeRoot, 1);

    let readRejected = false;
    try {
      await readOperationJournal(t.env, storeRoot);
    } catch {
      readRejected = true;
    }
    const recovery = await recoverInterruptedOperation(t.env, storeRoot, {
      operationId: "operation-fixed",
    });
    expect(readRejected).toBe(true);
    expect(recovery).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED" },
    });
    await expect(t.env.fs.lstat(operationJournalPath(storeRoot))).resolves.toBeDefined();
  });

  it("rejects a durable receipt file that differs from its completed journal", async () => {
    const mutationPlan = plan();
    const timestamp = t.env.now().toISOString();
    const actionReceipt: OperationActionReceipt = {
      actionId: recoveryActionId(targetA),
      target: targetA,
      outcome: "applied",
      before: { state: "absent" },
      after: mutationPlan.actions[0]?.postcondition ?? { state: "absent" },
      recordedAt: timestamp,
    };
    const completedReceipt: OperationReceipt = {
      schemaVersion: 1,
      operationId: "operation-fixed",
      planId: mutationPlan.planId,
      planDigest: mutationPlan.digest,
      operation: mutationPlan.operation,
      baseRevision: 0,
      resultingRevision: 1,
      outcome: "committed",
      actionReceipts: [actionReceipt],
      startedAt: timestamp,
      completedAt: timestamp,
    };
    await publishOperationJournal(t.env, storeRoot, {
      schemaVersion: 1,
      operationId: "operation-fixed",
      plan: createDurableMutationPlan(t.env, storeRoot, mutationPlan),
      nextRevision: 1,
      status: "completed",
      startedAt: timestamp,
      updatedAt: timestamp,
      actions: [
        {
          actionId: recoveryActionId(targetA),
          target: targetA,
          status: "succeeded",
          receipt: actionReceipt,
        },
      ],
      completedReceipt,
    });
    await publishOperationReceipt(t.env, storeRoot, {
      ...completedReceipt,
      planId: "attacker-plan",
    });
    await publishStoreRevision(t.env, storeRoot, 1);

    await expect(diagnoseMutationRecovery(t.env, storeRoot)).rejects.toThrow(/receipt.*journal/i);
    await expect(
      recoverInterruptedOperation(t.env, storeRoot, { operationId: "operation-fixed" }),
    ).rejects.toThrow(/receipt.*journal/i);
    await expect(t.env.fs.lstat(operationJournalPath(storeRoot))).resolves.toBeDefined();
  });

  it("refuses journaled state publication through a store-internal ancestor symlink", async () => {
    await t.env.fs.mkdir(storeRoot, { recursive: true });
    const outside = t.path("outside-state");
    await t.env.fs.mkdir(outside, { recursive: true });
    await t.env.fs.symlink(outside, join(storeRoot, "link"), "dir");
    const statePath = join(storeRoot, "link", "outside.json");
    const mutationPlan = plan([]);
    await publishOperationJournal(t.env, storeRoot, {
      schemaVersion: 1,
      operationId: "operation-fixed",
      plan: createDurableMutationPlan(t.env, storeRoot, mutationPlan),
      nextRevision: 1,
      status: "publishing-state",
      startedAt: t.env.now().toISOString(),
      updatedAt: t.env.now().toISOString(),
      actions: [],
      statePublications: [{ path: statePath, digest: "sha256:outside", mode: 0o600 }],
    });

    const recovered = await recoverInterruptedOperation(t.env, storeRoot, {
      operationId: "operation-fixed",
    });
    expect(recovered).toMatchObject({
      ok: false,
      conflict: {
        code: "MANUAL_RECOVERY_REQUIRED",
        targets: [],
        guidance: expect.stringMatching(/cannot be authorized/i),
      },
    });
    await expect(t.env.fs.lstat(join(outside, "outside.json"))).rejects.toThrow();
  });

  it("stops compensation if an absent-before target drifts after observation", async () => {
    const mutationPlan = plan();
    await expect(
      executeMutationPlan(t.env, storeRoot, mutationPlan, async (_operationId, recordAction) => {
        await writeAction(t.env, mutationPlan, 0, recordAction);
        throw new Error("interrupt-after-action");
      }),
    ).rejects.toThrow("interrupt-after-action");

    const baseFs = t.env.fs;
    let targetProbes = 0;
    const recoveryEnv: Env = {
      ...t.env,
      fs: {
        ...baseFs,
        lstat: async (path) => {
          if (path === targetA) {
            targetProbes += 1;
            if (targetProbes === 2) await baseFs.writeFile(targetA, "third-state");
          }
          return baseFs.lstat(path);
        },
      },
    };

    const recovered = await recoverInterruptedOperation(recoveryEnv, storeRoot, {
      operationId: "operation-fixed",
    });
    expect(recovered).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED", targets: [targetA] },
    });
    await expect(t.env.fs.readFile(targetA)).resolves.toBe("third-state");
  });

  it("keeps the exact after fingerprint gate before restoring a present before-state", async () => {
    const passphrase = "recovery-test-passphrase";
    await t.env.fs.mkdir(storeRoot, { recursive: true });
    await t.env.fs.writeFile(targetA, "before-state");
    const beforeFingerprint = await fingerprintTarget(t.env, targetA);
    if (!beforeFingerprint) throw new Error("expected before fingerprint");
    const snapshot = await createEncryptedTargetSnapshot(
      t.env,
      storeRoot,
      targetA,
      passphrase,
      beforeFingerprint,
    );
    await t.env.fs.writeFile(targetA, "after-state");
    const after = await targetState(t.env, targetA);
    const mutationPlan = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: "plan-fixed",
      operation: "apply",
      baseRevision: 0,
      normalizedInputs: {},
      actions: [{ actionId: "action-1", kind: "write", target: targetA, payload: {} }],
      targetPreconditions: [
        {
          actionId: "action-1",
          target: targetA,
          expected: { state: "present", fingerprint: beforeFingerprint },
        },
      ],
      expires: { policy: "none" },
    });
    await publishOperationJournal(t.env, storeRoot, {
      schemaVersion: 1,
      operationId: "operation-fixed",
      plan: createDurableMutationPlan(t.env, storeRoot, mutationPlan),
      nextRevision: 1,
      status: "executing",
      startedAt: t.env.now().toISOString(),
      updatedAt: t.env.now().toISOString(),
      actions: [
        {
          actionId: "action-1",
          target: targetA,
          status: "succeeded",
          receipt: {
            actionId: "action-1",
            target: targetA,
            outcome: "applied",
            before: {
              state: "present",
              fingerprint: beforeFingerprint,
              recoverySnapshot: snapshot.path,
              recoverySnapshotDigest: sha256(await t.env.fs.readFile(snapshot.path)),
              recoverySnapshotMode: (await t.env.fs.lstat(snapshot.path)).mode & 0o777,
            },
            after,
            recordedAt: t.env.now().toISOString(),
          },
        },
      ],
    });

    const baseFs = t.env.fs;
    let targetProbes = 0;
    const recoveryEnv: Env = {
      ...t.env,
      fs: {
        ...baseFs,
        lstat: async (path) => {
          if (path === targetA) {
            targetProbes += 1;
            if (targetProbes === 2) await baseFs.writeFile(targetA, "third-state");
          }
          return baseFs.lstat(path);
        },
      },
    };
    const recovered = await recoverInterruptedOperation(recoveryEnv, storeRoot, {
      operationId: "operation-fixed",
      snapshotPassphrase: passphrase,
    });
    expect(recovered).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED", targets: [] },
    });
    await expect(t.env.fs.readFile(targetA)).resolves.toBe("after-state");
  });

  it("does not restore a substituted same-passphrase snapshot during compensation", async () => {
    const passphrase = "recovery-test-passphrase";
    await t.env.fs.mkdir(storeRoot, { recursive: true });
    await t.env.fs.writeFile(targetA, "authorized-before");
    const beforeFingerprint = await fingerprintTarget(t.env, targetA);
    if (!beforeFingerprint) throw new Error("expected before fingerprint");
    const snapshot = await createEncryptedTargetSnapshot(
      t.env,
      storeRoot,
      targetA,
      passphrase,
      beforeFingerprint,
    );
    const snapshotDigest = sha256(await t.env.fs.readFile(snapshot.path));
    const snapshotMode = (await t.env.fs.lstat(snapshot.path)).mode & 0o777;
    const alternate = t.path("home", ".agent", "alternate.txt");
    await t.env.fs.writeFile(alternate, "different-valid-before");
    const alternateFingerprint = await fingerprintTarget(t.env, alternate);
    if (!alternateFingerprint) throw new Error("expected alternate fingerprint");
    const alternateSnapshot = await createEncryptedTargetSnapshot(
      t.env,
      storeRoot,
      alternate,
      passphrase,
      alternateFingerprint,
    );
    await t.env.fs.writeFile(targetA, "after-state");
    const after = await targetState(t.env, targetA);
    const mutationPlan = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: "plan-fixed",
      operation: "apply",
      baseRevision: 0,
      normalizedInputs: {},
      actions: [{ actionId: "action-1", kind: "write", target: targetA, payload: {} }],
      targetPreconditions: [
        {
          actionId: "action-1",
          target: targetA,
          expected: { state: "present", fingerprint: beforeFingerprint },
        },
      ],
      expires: { policy: "none" },
    });
    const timestamp = t.env.now().toISOString();
    await publishOperationJournal(t.env, storeRoot, {
      schemaVersion: 1,
      operationId: "operation-fixed",
      plan: createDurableMutationPlan(t.env, storeRoot, mutationPlan),
      nextRevision: 1,
      status: "executing",
      startedAt: timestamp,
      updatedAt: timestamp,
      actions: [
        {
          actionId: "action-1",
          target: targetA,
          status: "succeeded",
          receipt: {
            actionId: "action-1",
            target: targetA,
            outcome: "applied",
            before: {
              state: "present",
              fingerprint: beforeFingerprint,
              recoverySnapshot: snapshot.path,
              recoverySnapshotDigest: snapshotDigest,
              recoverySnapshotMode: snapshotMode,
            },
            after,
            recordedAt: timestamp,
          },
        },
      ],
    });
    await t.env.fs.publishFileAtomically(
      snapshot.path,
      await t.env.fs.readFile(alternateSnapshot.path),
      { mode: snapshotMode },
    );

    const result = await recoverInterruptedOperation(t.env, storeRoot, {
      operationId: "operation-fixed",
      snapshotPassphrase: passphrase,
    });

    expect(result).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED", targets: [] },
    });
    await expect(t.env.fs.readFile(targetA)).resolves.toBe("after-state");
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
  });

  it("compensates from signed bytes read before a snapshot path swap and retains the replacement", async () => {
    const passphrase = "recovery-test-passphrase";
    await t.env.fs.mkdir(storeRoot, { recursive: true });
    await t.env.fs.writeFile(targetA, "authorized-before");
    const beforeFingerprint = await fingerprintTarget(t.env, targetA);
    if (!beforeFingerprint) throw new Error("expected before fingerprint");
    const snapshot = await createEncryptedTargetSnapshot(
      t.env,
      storeRoot,
      targetA,
      passphrase,
      beforeFingerprint,
    );
    const snapshotBytes = await t.env.fs.readFile(snapshot.path);
    const snapshotDigest = sha256(snapshotBytes);
    const snapshotMode = (await t.env.fs.lstat(snapshot.path)).mode & 0o777;
    const alternate = t.path("home", ".agent", "alternate-read-swap.txt");
    await t.env.fs.writeFile(alternate, "different-valid-before");
    const alternateFingerprint = await fingerprintTarget(t.env, alternate);
    if (!alternateFingerprint) throw new Error("expected alternate fingerprint");
    const alternateSnapshot = await createEncryptedTargetSnapshot(
      t.env,
      storeRoot,
      alternate,
      passphrase,
      alternateFingerprint,
    );
    const alternateBytes = await t.env.fs.readFile(alternateSnapshot.path);
    await t.env.fs.writeFile(targetA, "after-state");
    const after = await targetState(t.env, targetA);
    const mutationPlan = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: "plan-fixed",
      operation: "apply",
      baseRevision: 0,
      normalizedInputs: {},
      actions: [{ actionId: "action-1", kind: "write", target: targetA, payload: {} }],
      targetPreconditions: [
        {
          actionId: "action-1",
          target: targetA,
          expected: { state: "present", fingerprint: beforeFingerprint },
        },
      ],
      expires: { policy: "none" },
    });
    const timestamp = t.env.now().toISOString();
    await publishOperationJournal(t.env, storeRoot, {
      schemaVersion: 1,
      operationId: "operation-fixed",
      plan: createDurableMutationPlan(t.env, storeRoot, mutationPlan),
      nextRevision: 1,
      status: "executing",
      startedAt: timestamp,
      updatedAt: timestamp,
      actions: [
        {
          actionId: "action-1",
          target: targetA,
          status: "succeeded",
          receipt: {
            actionId: "action-1",
            target: targetA,
            outcome: "applied",
            before: {
              state: "present",
              fingerprint: beforeFingerprint,
              recoverySnapshot: snapshot.path,
              recoverySnapshotDigest: snapshotDigest,
              recoverySnapshotMode: snapshotMode,
            },
            after,
            recordedAt: timestamp,
          },
        },
      ],
    });
    const readFile = t.env.fs.readFile;
    const rm = t.env.fs.rm;
    let swapped = false;
    let snapshotRmCalls = 0;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        readFile: async (path) => {
          const bytes = await readFile(path);
          if (!swapped && path === snapshot.path) {
            swapped = true;
            await t.env.fs.publishFileAtomically(snapshot.path, alternateBytes, {
              mode: snapshotMode,
            });
          }
          return bytes;
        },
        rm: async (path, opts) => {
          if (path === snapshot.path) snapshotRmCalls += 1;
          await rm(path, opts);
        },
      },
    };

    const result = await recoverInterruptedOperation(env, storeRoot, {
      operationId: "operation-fixed",
      snapshotPassphrase: passphrase,
    });

    expect(result).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED", targets: [] },
    });
    await expect(t.env.fs.readFile(targetA)).resolves.toBe("after-state");
    await expect(t.env.fs.readFile(snapshot.path)).resolves.toBe(snapshotBytes);
    expect(snapshotRmCalls).toBe(0);
  });

  it("refuses compensation through a symlinked snapshot ancestor", async () => {
    const passphrase = "recovery-test-passphrase";
    await t.env.fs.mkdir(storeRoot, { recursive: true });
    await t.env.fs.writeFile(targetA, "authorized-before");
    const beforeFingerprint = await fingerprintTarget(t.env, targetA);
    if (!beforeFingerprint) throw new Error("expected before fingerprint");
    const snapshot = await createEncryptedTargetSnapshot(
      t.env,
      storeRoot,
      targetA,
      passphrase,
      beforeFingerprint,
    );
    const outsideRoot = t.path("outside-snapshots");
    const outsideSnapshot = join(outsideRoot, "outside.age");
    await t.env.fs.mkdir(outsideRoot, { recursive: true });
    await t.env.fs.publishFileAtomically(outsideSnapshot, await t.env.fs.readFile(snapshot.path), {
      mode: 0o600,
    });
    const snapshotsRoot = join(storeRoot, "snapshots");
    await t.env.fs.rm(snapshot.path, { force: true });
    await t.env.fs.symlink(outsideRoot, join(snapshotsRoot, "escape"), "dir");
    const escapedSnapshot = join(snapshotsRoot, "escape", "outside.age");
    await t.env.fs.writeFile(targetA, "after-state");
    const after = await targetState(t.env, targetA);
    const mutationPlan = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: "plan-fixed",
      operation: "apply",
      baseRevision: 0,
      normalizedInputs: {},
      actions: [{ actionId: "action-1", kind: "write", target: targetA, payload: {} }],
      targetPreconditions: [
        {
          actionId: "action-1",
          target: targetA,
          expected: { state: "present", fingerprint: beforeFingerprint },
        },
      ],
      expires: { policy: "none" },
    });
    const timestamp = t.env.now().toISOString();
    await publishOperationJournal(t.env, storeRoot, {
      schemaVersion: 1,
      operationId: "operation-fixed",
      plan: createDurableMutationPlan(t.env, storeRoot, mutationPlan),
      nextRevision: 1,
      status: "executing",
      startedAt: timestamp,
      updatedAt: timestamp,
      actions: [
        {
          actionId: "action-1",
          target: targetA,
          status: "succeeded",
          receipt: {
            actionId: "action-1",
            target: targetA,
            outcome: "applied",
            before: {
              state: "present",
              fingerprint: beforeFingerprint,
              recoverySnapshot: escapedSnapshot,
              recoverySnapshotDigest: sha256(await t.env.fs.readFile(outsideSnapshot)),
              recoverySnapshotMode: 0o600,
            },
            after,
            recordedAt: timestamp,
          },
        },
      ],
    });

    const result = await recoverInterruptedOperation(t.env, storeRoot, {
      operationId: "operation-fixed",
      snapshotPassphrase: passphrase,
    });

    expect(result).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED", targets: [] },
    });
    await expect(t.env.fs.readFile(targetA)).resolves.toBe("after-state");
    await expect(t.env.fs.readFile(outsideSnapshot)).resolves.toContain("BEGIN AGE ENCRYPTED FILE");
  });
});
