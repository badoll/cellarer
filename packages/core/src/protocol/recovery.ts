import type { Env } from "../env.js";
import { assertSafeAtomicPublicationPath } from "../fs/safety.js";
import {
  decryptTargetSnapshot,
  readAuthorizedEncryptedTargetSnapshot,
  restoreTargetSnapshot,
} from "../target-snapshot.js";
import { canonicalJson } from "./canonical.js";
import { targetState } from "./execute.js";
import {
  DEFAULT_OPERATION_RECEIPT_RETENTION,
  publishOperationJournal,
  publishOperationReceipt,
  readOperationJournal,
  readOperationReceipt,
  removeOperationJournal,
} from "./journal.js";
import type {
  LockConflict,
  LockOwnerEvidence,
  ManualRecoveryRequiredConflict,
  OperationActionReceipt,
  OperationJournal,
  OperationReceipt,
  OperationResult,
  TargetStateReceipt,
} from "./models.js";
import {
  acquireStoreMutationLock,
  acquireStoreRecoveryLock,
  readStoreMutationLockOwner,
  readStoreRecoveryLockOwner,
  releaseStoreMutationLock,
  type StoreMutationLock,
} from "./mutation-lock.js";
import { PublicationPostconditionError, verifyFilePublication } from "./publication.js";
import { StoreMutationConflictError } from "./store-mutation.js";
import { publishStoreRevision, readStoreRevision } from "./store-revision.js";

export type MutationRecoveryStatus =
  | "clean"
  | "incomplete"
  | "completed-pending-cleanup"
  | "manual-recovery-required";

export interface MutationRecoveryDiagnosis {
  readonly status: MutationRecoveryStatus;
  readonly journal: OperationJournal | null;
  readonly lockOwner: LockOwnerEvidence | null;
  readonly recoveryLockOwner: LockOwnerEvidence | null;
  readonly receipt: OperationReceipt | null;
  readonly message: string;
}

export interface RecoverInterruptedOperationOptions {
  readonly operationId: string;
  readonly snapshotPassphrase?: string;
}

export interface OperationRecoveryRetentionOptions {
  readonly retainReceipts?: number;
  readonly pruneUnreferencedSnapshots?: boolean;
}

export interface OperationRecoveryRetentionResult {
  readonly removedReceiptIds: readonly string[];
  readonly removedSnapshotPaths: readonly string[];
  readonly receiptPruning: { readonly status: "unsupported"; readonly reason: string };
  readonly snapshotPruning:
    | { readonly status: "not-requested" }
    | { readonly status: "unsupported"; readonly reason: string };
}

interface RecoveryClaim {
  readonly lock: StoreMutationLock;
  readonly originalMutationOwner: LockOwnerEvidence | null;
}

type RecoveryClaimResult =
  | { readonly ok: true; readonly claim: RecoveryClaim }
  | { readonly ok: false; readonly conflict: LockConflict };

export async function diagnoseMutationRecovery(
  env: Env,
  storeRoot: string,
): Promise<MutationRecoveryDiagnosis> {
  const [journal, lockOwner, recoveryLockOwner] = await Promise.all([
    readOperationJournal(env, storeRoot),
    readStoreMutationLockOwner(env, storeRoot),
    readStoreRecoveryLockOwner(env, storeRoot),
  ]);
  if (!journal && !lockOwner && !recoveryLockOwner) {
    return {
      status: "clean",
      journal: null,
      lockOwner: null,
      recoveryLockOwner: null,
      receipt: null,
      message: "no incomplete mutation operation",
    };
  }
  if (!journal) {
    return {
      status: "manual-recovery-required",
      journal: null,
      lockOwner,
      recoveryLockOwner,
      receipt: null,
      message: "mutation or recovery lock has no matching durable journal",
    };
  }
  const receipt = await readOperationReceipt(env, storeRoot, journal.operationId);
  if (
    receipt &&
    (journal.status !== "completed" ||
      !journal.completedReceipt ||
      canonicalJson(receipt) !== canonicalJson(journal.completedReceipt))
  ) {
    throw new Error("durable operation receipt does not match its operation journal");
  }
  if (recoveryLockOwner) {
    return {
      status: "manual-recovery-required",
      journal,
      lockOwner,
      recoveryLockOwner,
      receipt,
      message:
        "store recovery claim is held; recovery claims are never cleared by age and require operator inspection after a recovery crash",
    };
  }
  if (lockOwner && lockOwner.operationId !== journal.operationId) {
    return {
      status: "manual-recovery-required",
      journal,
      lockOwner,
      recoveryLockOwner: null,
      receipt,
      message: "mutation lock and journal identify different operations",
    };
  }
  if (journal.status === "completed") {
    return {
      status: "completed-pending-cleanup",
      journal,
      lockOwner,
      recoveryLockOwner: null,
      receipt,
      message: "completed operation needs durable cleanup",
    };
  }
  return {
    status: journal.status === "recovery-required" ? "manual-recovery-required" : "incomplete",
    journal,
    lockOwner,
    recoveryLockOwner: null,
    receipt,
    message: "incomplete mutation operation requires evidence-based recovery",
  };
}

export async function recoverInterruptedOperation(
  env: Env,
  storeRoot: string,
  opts: RecoverInterruptedOperationOptions,
): Promise<OperationResult> {
  const diagnosis = await diagnoseMutationRecovery(env, storeRoot);
  const journal = diagnosis.journal;
  if (!journal) {
    return manualRecovery(opts.operationId, [], diagnosis.message);
  }
  if (journal.operationId !== opts.operationId) {
    return manualRecovery(
      journal.operationId,
      journal.plan.actions.map((action) => action.target),
      `requested operation ${opts.operationId} does not match journal ${journal.operationId}`,
      journal,
    );
  }
  const acquired = await acquireRecoveryClaim(env, storeRoot, journal, diagnosis);
  if (!acquired.ok) return { ok: false, conflict: acquired.conflict, journal };
  const claim = acquired.claim;

  // Once the claim is durable, re-read the authorization and durable result. A recovery that
  // throws unexpectedly intentionally leaves this claim behind so a later process cannot guess
  // whether mutation stopped before or after the failing effect.
  const claimedJournal = await readOperationJournal(env, storeRoot);
  if (!claimedJournal || claimedJournal.operationId !== journal.operationId) {
    throw new Error("operation journal changed while acquiring the recovery claim");
  }
  const claimedReceipt = await readOperationReceipt(env, storeRoot, claimedJournal.operationId);
  let result: OperationResult;
  try {
    result = await recoverClaimedOperation(
      env,
      storeRoot,
      opts,
      claimedJournal,
      claimedReceipt,
      claim.originalMutationOwner,
    );
  } catch (error) {
    if (!(error instanceof PublicationPostconditionError)) throw error;
    const recoveryJournal: OperationJournal =
      claimedJournal.status === "completed"
        ? claimedJournal
        : {
            ...claimedJournal,
            status: "recovery-required",
            updatedAt: env.now().toISOString(),
          };
    if (recoveryJournal.status !== "completed") {
      await publishOperationJournal(env, storeRoot, recoveryJournal).catch(() => {});
    }
    result = manualRecovery(
      claimedJournal.operationId,
      [error.path],
      "recovery protocol metadata publication did not match its signed digest or mode",
      recoveryJournal,
    );
  }
  await claim.lock.release();
  return result;
}

async function acquireRecoveryClaim(
  env: Env,
  storeRoot: string,
  journal: OperationJournal,
  diagnosis: MutationRecoveryDiagnosis,
): Promise<RecoveryClaimResult> {
  if (diagnosis.recoveryLockOwner) {
    return {
      ok: false,
      conflict: recoveryClaimConflict(diagnosis.recoveryLockOwner),
    };
  }
  if (diagnosis.lockOwner && diagnosis.lockOwner.operationId !== journal.operationId) {
    return {
      ok: false,
      conflict: mutationLockConflict(diagnosis.lockOwner),
    };
  }
  if (diagnosis.lockOwner && !(await isConfirmedDeadLocalOwner(env, diagnosis.lockOwner))) {
    return {
      ok: false,
      conflict: mutationLockConflict(diagnosis.lockOwner),
    };
  }

  const owner: LockOwnerEvidence = {
    operationId: `recovery-${env.randomId()}`,
    processId: env.processId(),
    hostname: env.hostname(),
    acquiredAt: env.now().toISOString(),
  };
  const acquired = diagnosis.lockOwner
    ? await acquireStoreRecoveryLock(env, storeRoot, owner)
    : await acquireStoreMutationLock(env, storeRoot, owner);
  if (!acquired.ok) return acquired;
  if (diagnosis.lockOwner) {
    const currentMutationOwner = await readStoreMutationLockOwner(env, storeRoot);
    if (!sameLockOwner(currentMutationOwner, diagnosis.lockOwner)) {
      await acquired.lock.release();
      return {
        ok: false,
        conflict: mutationLockConflict(currentMutationOwner ?? diagnosis.lockOwner),
      };
    }
  }
  return {
    ok: true,
    claim: {
      lock: acquired.lock,
      originalMutationOwner: diagnosis.lockOwner,
    },
  };
}

async function isConfirmedDeadLocalOwner(env: Env, owner: LockOwnerEvidence): Promise<boolean> {
  if (owner.hostname !== env.hostname()) return false;
  try {
    return (await env.probeProcessLiveness(owner.processId)) === "dead";
  } catch {
    return false;
  }
}

function sameLockOwner(left: LockOwnerEvidence | null, right: LockOwnerEvidence): boolean {
  return (
    left !== null &&
    left.operationId === right.operationId &&
    left.processId === right.processId &&
    left.hostname === right.hostname &&
    left.acquiredAt === right.acquiredAt
  );
}

function mutationLockConflict(owner: LockOwnerEvidence): LockConflict {
  return {
    code: "LOCK_CONFLICT",
    message: "store mutation lock is held",
    owner,
  };
}

function recoveryClaimConflict(owner: LockOwnerEvidence): LockConflict {
  return {
    code: "LOCK_CONFLICT",
    message: "store recovery claim is held",
    owner,
  };
}

async function recoverClaimedOperation(
  env: Env,
  storeRoot: string,
  opts: RecoverInterruptedOperationOptions,
  journal: OperationJournal,
  durableReceipt: OperationReceipt | null,
  originalMutationOwner: LockOwnerEvidence | null,
): Promise<OperationResult> {
  const currentRevision = await readStoreRevision(env, storeRoot);
  if (journal.status === "completed") {
    const receipt = durableReceipt ?? journal.completedReceipt;
    if (!receipt) {
      return manualRecovery(
        journal.operationId,
        journal.plan.actions.map((action) => action.target),
        "completed journal is missing its exact operation receipt",
        journal,
      );
    }
    if (currentRevision !== receipt.resultingRevision) {
      return manualRecovery(
        journal.operationId,
        journal.plan.actions.map((action) => action.target),
        "completed journal does not match the current store revision",
        journal,
      );
    }
    await publishOperationReceipt(env, storeRoot, receipt);
    await cleanupRecoveredOperation(env, storeRoot, journal, originalMutationOwner);
    return { ok: true, receipt };
  }

  const observations = await Promise.all(
    journal.actions.map(async (action) => ({
      action,
      current: await targetState(env, action.target),
    })),
  );
  const everyAfterStateIsProven =
    journal.status === "publishing-state" &&
    journal.actions.length === journal.plan.actions.length &&
    journal.actions.every((action) => action.status === "succeeded") &&
    observations.every(
      ({ action, current }) =>
        action.status !== "pending" && sameTargetState(current, action.receipt.after),
    );

  if (
    everyAfterStateIsProven &&
    (currentRevision === journal.plan.baseRevision || currentRevision === journal.nextRevision)
  ) {
    for (const publication of journal.statePublications ?? []) {
      try {
        await assertSafeAtomicPublicationPath(
          env,
          publication.path,
          storeRoot,
          "recovery state publication",
        );
      } catch (error) {
        return persistManualRecovery(
          env,
          storeRoot,
          journal,
          [publication.path],
          error instanceof Error ? error.message : String(error),
        );
      }
      try {
        await verifyFilePublication(env, publication.path, publication.digest, publication.mode);
        await assertSafeAtomicPublicationPath(
          env,
          publication.path,
          storeRoot,
          "recovery state publication postcondition",
        );
      } catch {
        return persistManualRecovery(
          env,
          storeRoot,
          journal,
          [publication.path],
          "state publication is missing or does not match its durable digest; recovery will not reconstruct raw state by guessing",
        );
      }
    }
    if (currentRevision === journal.plan.baseRevision) {
      await publishStoreRevision(env, storeRoot, journal.nextRevision);
    }
    const receipt = buildReceipt(journal, "committed", journal.nextRevision, env.now());
    const completed = completedJournal(journal, receipt);
    await publishOperationJournal(env, storeRoot, completed);
    await publishOperationReceipt(env, storeRoot, receipt);
    await cleanupRecoveredOperation(env, storeRoot, completed, originalMutationOwner);
    return { ok: true, receipt };
  }

  if (currentRevision !== journal.plan.baseRevision) {
    return persistManualRecovery(
      env,
      storeRoot,
      journal,
      observations.map(({ action }) => action.target),
      "store revision no longer matches either safe recovery boundary",
    );
  }

  const manualTargets: string[] = [];
  for (const { action, current } of observations) {
    const before = beforeStateFor(journal, action.actionId);
    if (action.status === "pending") {
      if (!sameTargetState(current, before)) manualTargets.push(action.target);
      continue;
    }
    if (sameTargetState(current, before)) continue;
    if (!sameTargetState(current, action.receipt.after) || !isRestorable(before, opts)) {
      manualTargets.push(action.target);
    }
  }
  if (manualTargets.length > 0) {
    return persistManualRecovery(
      env,
      storeRoot,
      journal,
      manualTargets,
      "current target state matches neither a safe finalize path nor a provable compensation path",
    );
  }

  const compensatedReceipts: OperationActionReceipt[] = [];
  for (const { action } of [...observations].reverse()) {
    if (action.status === "pending") continue;
    const before = beforeStateFor(journal, action.actionId);
    const current = await targetState(env, action.target);
    if (!sameTargetState(current, before)) {
      if (!sameTargetState(current, action.receipt.after)) {
        return persistManualRecovery(
          env,
          storeRoot,
          journal,
          [action.target],
          "target changed after recovery observation; compensation was not attempted",
        );
      }
      try {
        await restoreBeforeState(env, storeRoot, action.target, before, action.receipt.after, opts);
      } catch (error) {
        return persistManualRecovery(
          env,
          storeRoot,
          journal,
          [action.target],
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const restored = await targetState(env, action.target);
    if (!sameTargetState(restored, before)) {
      return persistManualRecovery(
        env,
        storeRoot,
        journal,
        [action.target],
        "compensation did not restore the recorded before-state",
      );
    }
    compensatedReceipts.unshift({
      ...action.receipt,
      outcome: "compensated",
      after: before,
      recordedAt: env.now().toISOString(),
    });
  }

  const compensatedById = new Map(
    compensatedReceipts.map((action) => [action.actionId, action] as const),
  );
  const compensatedJournal: OperationJournal = {
    ...journal,
    actions: journal.actions.map((action) => {
      if (action.status === "pending") return action;
      const receipt = compensatedById.get(action.actionId);
      return receipt ? { ...action, status: "succeeded" as const, receipt } : action;
    }),
  };
  const completedAt = env.now();
  const receipt: OperationReceipt = {
    ...buildReceipt(
      compensatedJournal,
      "compensated",
      compensatedJournal.plan.baseRevision,
      completedAt,
    ),
    actionReceipts: compensatedReceipts,
  };
  const completed = completedJournal(compensatedJournal, receipt);
  await publishOperationJournal(env, storeRoot, completed);
  await publishOperationReceipt(env, storeRoot, receipt);
  await cleanupRecoveredOperation(env, storeRoot, completed, originalMutationOwner);
  return { ok: true, receipt };
}

export async function pruneOperationRecoveryArtifacts(
  env: Env,
  storeRoot: string,
  opts: OperationRecoveryRetentionOptions = {},
): Promise<OperationRecoveryRetentionResult> {
  const retainReceipts = opts.retainReceipts ?? DEFAULT_OPERATION_RECEIPT_RETENTION;
  if (!Number.isSafeInteger(retainReceipts) || retainReceipts < 0) {
    throw new TypeError(
      `receipt retention must be a non-negative safe integer, got ${retainReceipts}`,
    );
  }
  const recoveryOwner = await readStoreRecoveryLockOwner(env, storeRoot);
  if (recoveryOwner) throw new StoreMutationConflictError(recoveryClaimConflict(recoveryOwner));

  const owner: LockOwnerEvidence = {
    operationId: `retention-${env.randomId()}`,
    processId: env.processId(),
    hostname: env.hostname(),
    acquiredAt: env.now().toISOString(),
  };
  const acquired = await acquireStoreMutationLock(env, storeRoot, owner);
  if (!acquired.ok) throw new StoreMutationConflictError(acquired.conflict);
  try {
    const recoveryAfterAcquire = await readStoreRecoveryLockOwner(env, storeRoot);
    if (recoveryAfterAcquire) {
      throw new StoreMutationConflictError(recoveryClaimConflict(recoveryAfterAcquire));
    }
    const journal = await readOperationJournal(env, storeRoot);
    if (journal) {
      throw new StoreMutationConflictError({
        code: "INTERRUPTED_OPERATION",
        message: "an incomplete operation requires recovery before retention",
        operationId: journal.operationId,
        journalStatus: journal.status,
      });
    }

    // Node's current fs/Env surface cannot bind directory identity to a no-follow unlink. Keep
    // every receipt and encrypted snapshot rather than presenting check-then-delete as atomic.
    const unsupportedReason =
      "automatic deletion is disabled because directory-identity no-follow deletion is unavailable";
    return {
      removedReceiptIds: [],
      removedSnapshotPaths: [],
      receiptPruning: { status: "unsupported", reason: unsupportedReason },
      snapshotPruning: opts.pruneUnreferencedSnapshots
        ? {
            status: "unsupported",
            reason: unsupportedReason,
          }
        : { status: "not-requested" },
    };
  } finally {
    await acquired.lock.release();
  }
}

async function restoreBeforeState(
  env: Env,
  storeRoot: string,
  target: string,
  before: TargetStateReceipt,
  after: TargetStateReceipt,
  opts: RecoverInterruptedOperationOptions,
): Promise<void> {
  const current = await targetState(env, target);
  if (!sameTargetState(current, after)) {
    throw new RecoveryTargetChangedError(target);
  }
  if (before.state === "absent") {
    await env.fs.rm(target, { recursive: true, force: true });
    return;
  }
  if (
    !before.recoverySnapshot ||
    !before.recoverySnapshotDigest ||
    before.recoverySnapshotMode === undefined ||
    !opts.snapshotPassphrase
  ) {
    throw new Error(`target ${target} has no authorized recovery snapshot`);
  }
  const snapshot = await decryptTargetSnapshot(
    await readAuthorizedEncryptedTargetSnapshot(env, storeRoot, {
      path: before.recoverySnapshot,
      digest: before.recoverySnapshotDigest,
      mode: before.recoverySnapshotMode,
    }),
    opts.snapshotPassphrase,
  );
  await restoreTargetSnapshot(
    env,
    target,
    snapshot,
    after.state === "absent" ? null : after.fingerprint,
  );
}

class RecoveryTargetChangedError extends Error {
  constructor(target: string) {
    super(`target ${target} changed at the final compensation boundary`);
    this.name = "RecoveryTargetChangedError";
  }
}

function isRestorable(
  before: TargetStateReceipt,
  opts: RecoverInterruptedOperationOptions,
): boolean {
  return (
    before.state === "absent" ||
    Boolean(
      before.recoverySnapshot &&
        before.recoverySnapshotDigest &&
        before.recoverySnapshotMode !== undefined &&
        opts.snapshotPassphrase,
    )
  );
}

function beforeStateFor(journal: OperationJournal, actionId: string): TargetStateReceipt {
  const before = journal.plan.targetPreconditions.find(
    (precondition) => precondition.actionId === actionId,
  )?.expected;
  if (!before) throw new Error(`journal action ${actionId} has no target precondition`);
  const action = journal.actions.find((candidate) => candidate.actionId === actionId);
  if (action && action.status !== "pending" && action.receipt.before.state === "present") {
    return action.receipt.before;
  }
  return before;
}

async function persistManualRecovery(
  env: Env,
  storeRoot: string,
  journal: OperationJournal,
  targets: readonly string[],
  guidance: string,
): Promise<OperationResult> {
  const recoveryRequired: OperationJournal = {
    ...journal,
    status: "recovery-required",
    updatedAt: env.now().toISOString(),
  };
  await publishOperationJournal(env, storeRoot, recoveryRequired);
  return manualRecovery(journal.operationId, targets, guidance, recoveryRequired);
}

function manualRecovery(
  operationId: string,
  targets: readonly string[],
  guidance: string,
  journal?: OperationJournal,
): OperationResult {
  const conflict: ManualRecoveryRequiredConflict = {
    code: "MANUAL_RECOVERY_REQUIRED",
    message: "manual recovery is required",
    operationId,
    targets: [...new Set(targets)],
    guidance,
  };
  return { ok: false, conflict, ...(journal ? { journal } : {}) };
}

function buildReceipt(
  journal: OperationJournal,
  outcome: OperationReceipt["outcome"],
  resultingRevision: number,
  completedAt: Date,
): OperationReceipt {
  return {
    schemaVersion: 1,
    operationId: journal.operationId,
    planId: journal.plan.planId,
    planDigest: journal.plan.digest,
    operation: journal.plan.operation,
    baseRevision: journal.plan.baseRevision,
    resultingRevision,
    outcome,
    actionReceipts: journal.actions.flatMap((action) =>
      action.status === "pending" ? [] : [action.receipt],
    ),
    startedAt: journal.startedAt,
    completedAt: completedAt.toISOString(),
  };
}

function completedJournal(journal: OperationJournal, receipt: OperationReceipt): OperationJournal {
  return {
    ...journal,
    status: "completed",
    updatedAt: receipt.completedAt,
    completedReceipt: receipt,
  };
}

async function cleanupRecoveredOperation(
  env: Env,
  storeRoot: string,
  journal: OperationJournal,
  lockOwner: LockOwnerEvidence | null,
): Promise<void> {
  if (lockOwner) await releaseStoreMutationLock(env, storeRoot, lockOwner);
  const current = await readOperationJournal(env, storeRoot);
  if (current && current.operationId !== journal.operationId) {
    throw new Error("operation journal changed before recovery cleanup");
  }
  await removeOperationJournal(env, storeRoot);
}

function sameTargetState(left: TargetStateReceipt, right: TargetStateReceipt): boolean {
  return (
    left.state === right.state &&
    (left.state === "absent" ||
      (right.state === "present" && left.fingerprint === right.fingerprint))
  );
}
