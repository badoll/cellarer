import type { Env, MutationAuthorityLease } from "../env.js";
import { assertSafeAtomicPublicationPath } from "../fs/safety.js";
import { containsObservableKnownValue, observableKnownValues } from "../secrets/observable.js";
import { sha256 } from "../store/checksum.js";
import { fingerprintTarget } from "../target-ownership.js";
import {
  acquireCurrentMutationAuthorityLease,
  assertStrictMutationPlanRuntime,
  createDurableMutationPlan,
  verifyMutationPlanAuthorization,
  verifyMutationPlanDigest,
} from "./canonical.js";
import type { OperationJournalInput } from "./journal.js";
import {
  publishOperationJournal,
  publishOperationReceipt,
  readOperationJournal,
  removeOperationJournal,
} from "./journal.js";
import type {
  LockOwnerEvidence,
  MutationPlan,
  OperationActionReceipt,
  OperationJournal,
  OperationJournalAction,
  OperationReceipt,
  OperationResult,
  OperationStatePublication,
  TargetStateReceipt,
} from "./models.js";
import { acquireStoreMutationLock, readStoreRecoveryLockOwner } from "./mutation-lock.js";
import { PublicationPostconditionError, verifyFilePublication } from "./publication.js";
import { publishStoreRevision, readStoreRevision } from "./store-revision.js";

export interface MutationExecution {
  readonly actionReceipts: readonly OperationActionReceipt[];
  readonly failedActionIds?: readonly string[];
  readonly statePublications?: readonly StatePublicationInput[];
  readonly afterCommit?: () => Promise<void>;
}

export interface StatePublicationInput extends Omit<OperationStatePublication, "digest"> {
  readonly data: string;
}

export type RecordOperationAction = (receipt: OperationActionReceipt) => Promise<void>;

export type AuthorizeOperationAction = (
  actionId: string,
) => Promise<
  | { readonly ok: true; readonly before: TargetStateReceipt }
  | { readonly ok: false; readonly receipt: OperationActionReceipt }
>;

export async function executeMutationPlan(
  env: Env,
  storeRoot: string,
  plan: MutationPlan,
  execute: (
    operationId: string,
    recordAction: RecordOperationAction,
    authorizeAction: AuthorizeOperationAction,
  ) => Promise<MutationExecution>,
  options: {
    readonly validatePreflightBeforeObservation?: () => Promise<OperationResult | null>;
    readonly validateBeforeObservationUnderLock?: () => Promise<OperationResult | null>;
    readonly validateUnderLock?: () => Promise<OperationResult | null>;
    readonly authorityLease?: MutationAuthorityLease;
  } = {},
): Promise<OperationResult> {
  try {
    assertStrictMutationPlanRuntime(plan);
  } catch {
    return invalidPlanResult();
  }
  if (!verifyMutationPlanAuthorization(env, storeRoot, plan)) return invalidPlanResult();
  const suppliedAuthorityLease = options.authorityLease;
  const authorityLease =
    suppliedAuthorityLease ?? (await acquireCurrentMutationAuthorityLease(env).catch(() => null));
  if (!authorityLease) return invalidPlanResult();
  if (!(await authorityLease.isCurrent().catch(() => false))) {
    if (!suppliedAuthorityLease) await authorityLease.release().catch(() => undefined);
    return invalidPlanResult();
  }
  const knownValues = observableKnownValues(env);
  if (containsObservableKnownValue(JSON.stringify(plan), knownValues)) {
    if (!suppliedAuthorityLease) await authorityLease.release();
    throw new TypeError("active secret value is not allowed in signed mutation metadata");
  }
  const preflight = validatePlanIntegrity(plan);
  if (preflight) {
    if (!suppliedAuthorityLease) await authorityLease.release();
    return preflight;
  }
  try {
    const provenancePreflight = await options.validatePreflightBeforeObservation?.();
    if (provenancePreflight) {
      if (!suppliedAuthorityLease) await authorityLease.release();
      return provenancePreflight;
    }
  } catch (error) {
    if (!suppliedAuthorityLease) await authorityLease.release().catch(() => undefined);
    throw error;
  }
  const operationId = `operation-${env.randomId()}`;
  if (containsObservableKnownValue(operationId, knownValues)) {
    if (!suppliedAuthorityLease) await authorityLease.release();
    throw new TypeError("active secret value is not allowed in an operation identity");
  }
  const owner: LockOwnerEvidence = {
    operationId,
    processId: env.processId(),
    hostname: env.hostname(),
    acquiredAt: env.now().toISOString(),
  };
  const acquired = await acquireStoreMutationLock(env, storeRoot, owner);
  if (!acquired.ok) {
    if (!suppliedAuthorityLease) await authorityLease.release();
    return { ok: false, conflict: acquired.conflict };
  }
  let releaseAttempted = false;
  let journal: OperationJournal | undefined;
  try {
    if (!(await authorityLease.isCurrent().catch(() => false))) return invalidPlanResult();

    const earliestValidation = await options.validateBeforeObservationUnderLock?.();
    if (earliestValidation) return earliestValidation;

    const recoveryAfterAcquire = await readStoreRecoveryLockOwner(env, storeRoot);
    if (recoveryAfterAcquire) return recoveryLockConflict(recoveryAfterAcquire);

    const revisionValidation = await validatePlanRevisionUnderLock(env, storeRoot, plan);
    if (revisionValidation) return revisionValidation;

    const interrupted = await readOperationJournal(env, storeRoot);
    if (interrupted) {
      return {
        ok: false,
        conflict: {
          code: "INTERRUPTED_OPERATION",
          message: "an incomplete operation requires recovery",
          operationId: interrupted.operationId,
          journalStatus: interrupted.status,
        },
        journal: interrupted,
      };
    }

    const startedAt = env.now().toISOString();

    const validation = await validatePlanUnderLock(env, storeRoot, plan);
    if (validation) return validation;
    const customValidation = await options.validateUnderLock?.();
    if (customValidation) return customValidation;

    const currentRevision = await readStoreRevision(env, storeRoot);
    const resultingRevision = currentRevision + 1;
    const initialJournal: OperationJournalInput = {
      schemaVersion: 1,
      operationId,
      plan: createDurableMutationPlan(env, storeRoot, plan),
      nextRevision: resultingRevision,
      status: "prepared",
      startedAt,
      updatedAt: startedAt,
      actions: plan.actions.map((action) => ({
        actionId: action.actionId,
        target: action.target,
        status: "pending",
      })),
    };
    journal = await publishOperationJournal(env, storeRoot, initialJournal);
    journal = withJournalStatus(journal, "executing", env.now().toISOString());
    journal = await publishOperationJournal(env, storeRoot, journal);

    const recordAction: RecordOperationAction = async (receipt) => {
      if (!journal) throw new Error("operation journal is not initialized");
      const index = journal.actions.findIndex((action) => action.actionId === receipt.actionId);
      const planned = plan.actions.find((action) => action.actionId === receipt.actionId);
      if (index < 0 || !planned || planned.target !== receipt.target) {
        throw new TypeError(`action receipt ${receipt.actionId} is not authorized by the plan`);
      }
      const current = journal.actions[index];
      if (!current) throw new Error(`missing journal action ${receipt.actionId}`);
      if (current.status !== "pending") {
        if (JSON.stringify(current.receipt) !== JSON.stringify(receipt)) {
          throw new Error(`action receipt ${receipt.actionId} was already recorded differently`);
        }
        return;
      }
      if (receipt.outcome === "compensated") {
        const actual = await targetState(env, receipt.target);
        if (!sameTargetState(receipt.before, actual) || !sameTargetState(receipt.after, actual)) {
          throw new Error(`compensated action ${receipt.actionId} was not restored`);
        }
      }
      const nextAction: OperationJournalAction = {
        actionId: receipt.actionId,
        target: receipt.target,
        status: receipt.outcome === "failed" ? "failed" : "succeeded",
        receipt,
      };
      const actions = [...journal.actions];
      actions[index] = nextAction;
      const nextJournal: OperationJournal = {
        ...journal,
        status: "executing",
        updatedAt: env.now().toISOString(),
        actions,
      };
      journal = await publishOperationJournal(env, storeRoot, nextJournal);
    };

    const authorizeAction: AuthorizeOperationAction = async (actionId) => {
      if (!journal) throw new Error("operation journal is not initialized");
      const action = plan.actions.find((candidate) => candidate.actionId === actionId);
      const precondition = plan.targetPreconditions.find(
        (candidate) => candidate.actionId === actionId,
      );
      const journalAction = journal.actions.find((candidate) => candidate.actionId === actionId);
      if (!action || !precondition || !journalAction || journalAction.status !== "pending") {
        throw new TypeError(`action ${actionId} is not pending in the signed operation journal`);
      }
      const actual = await targetState(env, action.target);
      if (sameTargetState(precondition.expected, actual)) {
        return { ok: true, before: precondition.expected };
      }
      const receipt: OperationActionReceipt = {
        actionId,
        target: action.target,
        outcome: "failed",
        before: precondition.expected,
        after: actual,
        recordedAt: env.now().toISOString(),
        error: {
          code: "TARGET_PRECONDITION_CONFLICT",
          message: "target changed after the operation journal started executing",
        },
      };
      await recordAction(receipt);
      return { ok: false, receipt };
    };

    const execution = await execute(operationId, recordAction, authorizeAction);
    for (const receipt of execution.actionReceipts) await recordAction(receipt);

    const actionReceipts = journal.actions.flatMap((action) =>
      action.status === "pending" ? [] : [action.receipt],
    );
    const failedActionIds = [
      ...new Set([
        ...(execution.failedActionIds ?? []),
        ...journal.actions
          .filter((action) => action.status === "failed")
          .map((action) => action.actionId),
      ]),
    ];
    if (
      failedActionIds.length === 0 &&
      journal.actions.some(
        (action) => action.status === "succeeded" && action.receipt.outcome === "compensated",
      )
    ) {
      throw new TypeError("compensated action receipts require a failed operation action");
    }
    if (failedActionIds.length > 0) {
      const conflict = {
        code: "PARTIAL_FAILURE" as const,
        message: "one or more actions failed",
        operationId,
        failedActionIds,
      };
      const noTargetChanged = journal.actions.every(
        (action) =>
          action.status !== "pending" &&
          sameTargetState(action.receipt.before, action.receipt.after),
      );
      const crossedUnverifiedPublicationBoundary = journal.actions.some(
        (action) =>
          action.status === "failed" &&
          ["PUBLICATION_POSTCONDITION_FAILED", "ACTION_POSTCONDITION_FAILED"].includes(
            action.receipt.error?.code ?? "",
          ),
      );
      if (noTargetChanged && !crossedUnverifiedPublicationBoundary) {
        const completedAt = env.now().toISOString();
        const receipt: OperationReceipt = {
          schemaVersion: 1,
          operationId,
          planId: plan.planId,
          planDigest: plan.digest,
          operation: plan.operation,
          baseRevision: plan.baseRevision,
          resultingRevision: currentRevision,
          outcome: "compensated",
          actionReceipts,
          startedAt,
          completedAt,
        };
        journal = {
          ...withJournalStatus(journal, "completed", completedAt),
          completedReceipt: receipt,
        };
        journal = await publishOperationJournal(env, storeRoot, journal);
        await publishOperationReceipt(env, storeRoot, receipt);
        releaseAttempted = true;
        await acquired.lock.release();
        await removeOperationJournal(env, storeRoot);
        return { ok: false, conflict };
      }
      journal = withJournalStatus(journal, "recovery-required", env.now().toISOString());
      journal = await publishOperationJournal(env, storeRoot, journal);
      return {
        ok: false,
        conflict,
        journal,
      };
    }
    if (journal.actions.some((action) => action.status === "pending")) {
      throw new Error("mutation execution returned before every action receipt was persisted");
    }

    const statePublicationInputs = execution.statePublications ?? [];
    for (const publication of statePublicationInputs) {
      await assertSafeAtomicPublicationPath(
        env,
        publication.path,
        storeRoot,
        "operation state publication",
      );
    }
    const statePublications: OperationStatePublication[] = statePublicationInputs.map(
      ({ path, data, mode }) => ({
        path,
        digest: sha256(data),
        ...(mode === undefined ? {} : { mode }),
      }),
    );
    journal = {
      ...withJournalStatus(journal, "publishing-state", env.now().toISOString()),
      ...(statePublications.length > 0 ? { statePublications } : {}),
    };
    journal = await publishOperationJournal(env, storeRoot, journal);
    for (const [index, publication] of statePublicationInputs.entries()) {
      await env.fs.publishFileAtomically(publication.path, publication.data, {
        mode: publication.mode,
      });
      const evidence = statePublications[index];
      if (!evidence) throw new Error(`missing state publication evidence for ${publication.path}`);
      try {
        await verifyFilePublication(env, evidence.path, evidence.digest, evidence.mode);
        await assertSafeAtomicPublicationPath(
          env,
          evidence.path,
          storeRoot,
          "operation state publication postcondition",
        );
      } catch {
        journal = withJournalStatus(journal, "recovery-required", env.now().toISOString());
        journal = await publishOperationJournal(env, storeRoot, journal);
        return {
          ok: false,
          conflict: {
            code: "MANUAL_RECOVERY_REQUIRED",
            message: "manual recovery is required",
            operationId,
            targets: [evidence.path],
            guidance:
              "state publication does not match its signed digest or mode; revision was not advanced",
          },
          journal,
        };
      }
    }
    await publishStoreRevision(env, storeRoot, resultingRevision);
    await execution.afterCommit?.();
    const receipt: OperationReceipt = {
      schemaVersion: 1,
      operationId,
      planId: plan.planId,
      planDigest: plan.digest,
      operation: plan.operation,
      baseRevision: plan.baseRevision,
      resultingRevision,
      outcome: "committed",
      actionReceipts,
      startedAt,
      completedAt: env.now().toISOString(),
    };
    journal = {
      ...withJournalStatus(journal, "completed", receipt.completedAt),
      completedReceipt: receipt,
    };
    journal = await publishOperationJournal(env, storeRoot, journal);
    await publishOperationReceipt(env, storeRoot, receipt);
    releaseAttempted = true;
    await acquired.lock.release();
    await removeOperationJournal(env, storeRoot);
    return { ok: true, receipt };
  } catch (error) {
    if (error instanceof PublicationPostconditionError) {
      let recoveryJournal = journal;
      if (journal && journal.status !== "completed") {
        const recoveryRequired = withJournalStatus(
          journal,
          "recovery-required",
          env.now().toISOString(),
        );
        recoveryJournal = await publishOperationJournal(env, storeRoot, recoveryRequired).catch(
          () => journal,
        );
      }
      return {
        ok: false,
        conflict: {
          code: "MANUAL_RECOVERY_REQUIRED",
          message: "manual recovery is required",
          operationId,
          targets: [error.path],
          guidance:
            "protocol metadata publication did not match its signed digest or mode; no later protocol boundary was trusted",
        },
        ...(recoveryJournal ? { journal: recoveryJournal } : {}),
      };
    }
    throw error;
  } finally {
    if (!releaseAttempted) await acquired.lock.release();
    if (!suppliedAuthorityLease) await authorityLease.release();
  }
}

function recoveryLockConflict(owner: LockOwnerEvidence): OperationResult {
  return {
    ok: false,
    conflict: {
      code: "LOCK_CONFLICT",
      message: "store recovery claim is held",
      owner,
    },
  };
}

function withJournalStatus(
  journal: OperationJournal,
  status: OperationJournal["status"],
  updatedAt: string,
): OperationJournal {
  return { ...journal, status, updatedAt };
}

async function validatePlanUnderLock(
  env: Env,
  storeRoot: string,
  plan: MutationPlan,
): Promise<OperationResult | null> {
  const integrity = validatePlanIntegrity(plan);
  if (integrity) return integrity;
  assertMutationPlanActionAlignment(plan);

  if (
    plan.expires.policy === "expires-at" &&
    env.now().getTime() >= Date.parse(plan.expires.expiresAt)
  ) {
    return {
      ok: false,
      conflict: {
        code: "EXPIRED_PLAN",
        message: "plan expired",
        planId: "untrusted",
        expiredAt: "untrusted",
      },
    };
  }

  const actualRevision = await readStoreRevision(env, storeRoot);
  if (actualRevision !== plan.baseRevision) {
    return {
      ok: false,
      conflict: {
        code: "STALE_REVISION",
        message: "store revision changed; replan required",
        planId: "untrusted",
        expectedRevision: plan.baseRevision,
        actualRevision,
        replanRequired: true,
      },
    };
  }

  for (const precondition of plan.targetPreconditions) {
    const actual = await targetState(env, precondition.target);
    if (!sameTargetState(precondition.expected, actual)) {
      return {
        ok: false,
        conflict: {
          code: "TARGET_PRECONDITION_CONFLICT",
          message: "target changed after planning",
          planId: "untrusted",
          actionId: "untrusted",
          target: "untrusted",
          expected: precondition.expected,
          actual,
        },
      };
    }
  }
  return null;
}

async function validatePlanRevisionUnderLock(
  env: Env,
  storeRoot: string,
  plan: MutationPlan,
): Promise<OperationResult | null> {
  const actualRevision = await readStoreRevision(env, storeRoot);
  if (actualRevision === plan.baseRevision) return null;
  return {
    ok: false,
    conflict: {
      code: "STALE_REVISION",
      message: "store revision changed; replan required",
      planId: "untrusted",
      expectedRevision: plan.baseRevision,
      actualRevision,
      replanRequired: true,
    },
  };
}

function validatePlanIntegrity(plan: MutationPlan): OperationResult | null {
  if (!verifyMutationPlanDigest(plan)) return invalidPlanDigestResult();
  assertMutationPlanActionAlignment(plan);
  return null;
}

function invalidPlanDigestResult(): OperationResult {
  return {
    ok: false,
    conflict: {
      code: "INVALID_PLAN_DIGEST",
      message: "plan digest does not match its contents",
      planId: "untrusted",
      expectedDigest: "untrusted",
      actualDigest: "invalid",
    },
  };
}

export function invalidPlanResult(): OperationResult {
  return {
    ok: false,
    conflict: {
      code: "INVALID_PLAN",
      message: "mutation plan is invalid",
    },
  };
}

export function assertMutationPlanActionAlignment(plan: MutationPlan): void {
  if (!Array.isArray(plan.actions) || !Array.isArray(plan.targetPreconditions)) {
    throw new TypeError("mutation plan has invalid action authorization structure");
  }
  if (
    !plan.actions.every(
      (action) =>
        typeof action === "object" &&
        action !== null &&
        typeof action.actionId === "string" &&
        typeof action.kind === "string" &&
        typeof action.target === "string" &&
        typeof action.payload === "object" &&
        action.payload !== null,
    ) ||
    !plan.targetPreconditions.every(
      (precondition) =>
        typeof precondition === "object" &&
        precondition !== null &&
        typeof precondition.actionId === "string" &&
        typeof precondition.target === "string" &&
        typeof precondition.expected === "object" &&
        precondition.expected !== null,
    )
  ) {
    throw new TypeError("mutation plan has invalid action authorization structure");
  }
  const actionIds = new Set(plan.actions.map((action) => action.actionId));
  const preconditionsByAction = new Map(
    plan.targetPreconditions.map((precondition) => [precondition.actionId, precondition]),
  );
  if (
    actionIds.size !== plan.actions.length ||
    preconditionsByAction.size !== plan.targetPreconditions.length ||
    plan.actions.length !== plan.targetPreconditions.length ||
    plan.actions.some(
      (action) => preconditionsByAction.get(action.actionId)?.target !== action.target,
    )
  ) {
    throw new TypeError("mutation plan actions and target preconditions are not one-to-one");
  }
}

export async function targetState(env: Env, target: string): Promise<TargetStateReceipt> {
  const fingerprint = await fingerprintTarget(env, target);
  return fingerprint === null ? { state: "absent" } : { state: "present", fingerprint };
}

function sameTargetState(left: TargetStateReceipt, right: TargetStateReceipt): boolean {
  return (
    left.state === right.state &&
    (left.state === "absent" ||
      (right.state === "present" && left.fingerprint === right.fingerprint))
  );
}
