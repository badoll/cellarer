import type { Env, MutationAuthorityLease } from "../env.js";
import { assertSafeAtomicPublicationPath } from "../fs/safety.js";
import { isInventorySecretAdoptionExternalEffect } from "../secrets/adoption-provider.js";
import { containsObservableKnownValue, observableKnownValues } from "../secrets/observable.js";
import { sha256 } from "../store/checksum.js";
import { fingerprintTarget } from "../target-ownership.js";
import {
  acquireCurrentMutationAuthorityLease,
  assertStrictMutationPlanRuntime,
  createDurableMutationPlanWithExternalEffects,
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
  DurableOperationExternalEffect,
  LockOwnerEvidence,
  MutationPlan,
  OperationActionReceipt,
  OperationExternalEffectReceipt,
  OperationJournal,
  OperationJournalAction,
  OperationReceipt,
  OperationResult,
  OperationStatePublication,
  TargetStateReceipt,
} from "./models.js";
import { acquireStoreMutationLock, readStoreRecoveryLockOwner } from "./mutation-lock.js";
import {
  assertMutationPlanActionAlignment,
  resolveMutationOperationAdapter,
} from "./operation-adapter.js";
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

export type RecordOperationExternalEffect = (effectId: string) => Promise<void>;

export async function executeMutationPlan(
  env: Env,
  storeRoot: string,
  plan: MutationPlan,
  execute: (
    operationId: string,
    recordAction: RecordOperationAction,
    authorizeAction: AuthorizeOperationAction,
    recordExternalEffect: RecordOperationExternalEffect,
  ) => Promise<MutationExecution>,
  options: {
    readonly validatePreflightBeforeObservation?: () => Promise<OperationResult | null>;
    readonly validateBeforeObservationUnderLock?: () => Promise<OperationResult | null>;
    readonly validateUnderLock?: () => Promise<OperationResult | null>;
    readonly authorityLease?: MutationAuthorityLease;
    readonly externalEffects?: readonly DurableOperationExternalEffect[];
  } = {},
): Promise<OperationResult> {
  try {
    assertStrictMutationPlanRuntime(plan);
  } catch {
    return invalidPlanResult();
  }
  if (!verifyMutationPlanAuthorization(env, storeRoot, plan)) return invalidPlanResult();
  const adapter = resolveMutationOperationAdapter(plan);
  if (!adapter) return invalidPlanResult();
  const executePreparedEffects = adapter.prepareEffects(plan, () => execute);
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
  if (!validExternalEffects(plan, options.externalEffects)) {
    if (!suppliedAuthorityLease) await authorityLease.release();
    return invalidPlanResult();
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
      plan: createDurableMutationPlanWithExternalEffects(env, storeRoot, plan, {
        externalEffects: options.externalEffects,
      }),
      nextRevision: resultingRevision,
      status: "prepared",
      startedAt,
      updatedAt: startedAt,
      actions: plan.actions.map((action) => ({
        actionId: action.actionId,
        target: action.target,
        status: "pending",
      })),
      ...(options.externalEffects && options.externalEffects.length > 0
        ? {
            externalEffects: options.externalEffects.map(({ effectId }) => ({
              effectId,
              status: "pending" as const,
            })),
          }
        : {}),
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

    const recordExternalEffect: RecordOperationExternalEffect = async (effectId) => {
      if (!journal) throw new Error("operation journal is not initialized");
      const declaration = journal.plan.externalEffects?.find(
        (candidate) => candidate.effectId === effectId,
      );
      const index = journal.externalEffects?.findIndex(
        (candidate) => candidate.effectId === effectId,
      );
      const current =
        index === undefined || index < 0 ? undefined : journal.externalEffects?.[index];
      if (!declaration || index === undefined || index < 0 || !current) {
        throw new TypeError(`external effect ${effectId} is not authorized by the durable plan`);
      }
      if (current.status === "succeeded") return;
      const evidence = {
        status: "provider-created-store-unpublished" as const,
        provider: declaration.provider,
        targetName: declaration.targetName,
        cleanupCommand: declaration.cleanupCommand,
      };
      const externalEffects: OperationExternalEffectReceipt[] = [
        ...(journal.externalEffects ?? []),
      ];
      externalEffects[index] = { effectId, status: "succeeded", evidence };
      journal = await publishOperationJournal(env, storeRoot, {
        ...journal,
        updatedAt: env.now().toISOString(),
        externalEffects,
      });
    };

    const execution = await executePreparedEffects(
      operationId,
      recordAction,
      authorizeAction,
      recordExternalEffect,
    );
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
      const noTargetChanged =
        !journal.externalEffects?.some(({ status }) => status === "succeeded") &&
        journal.actions.every(
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
    if (journal.externalEffects?.some(({ status }) => status !== "succeeded")) {
      throw new Error("mutation execution returned before every external effect was persisted");
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
    return adapter.projectReceipt(plan, { ok: true, receipt });
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
    if (
      journal &&
      journal.status !== "completed" &&
      journal.externalEffects?.some(({ status }) => status === "succeeded")
    ) {
      const recoveryJournal = await publishOperationJournal(env, storeRoot, {
        ...journal,
        status: "recovery-required",
        updatedAt: env.now().toISOString(),
      }).catch(() => journal);
      return {
        ok: false,
        conflict: {
          code: "MANUAL_RECOVERY_REQUIRED",
          message: "manual recovery is required",
          operationId,
          targets: plan.actions.map(({ target }) => target),
          guidance:
            "an authorized external effect completed before the Store mutation could commit",
        },
        journal: recoveryJournal,
      };
    }
    throw error;
  } finally {
    if (!releaseAttempted) await acquired.lock.release();
    if (!suppliedAuthorityLease) await authorityLease.release();
  }
}

function validExternalEffects(
  plan: MutationPlan,
  effects: readonly DurableOperationExternalEffect[] | undefined,
): boolean {
  if (effects === undefined || effects.length === 0) return true;
  if (
    plan.operation !== "store-import" ||
    plan.normalizedInputs.mutationKind !== "inventory-secret-adoption" ||
    effects.length !== 1 ||
    new Set(effects.map(({ effectId }) => effectId)).size !== effects.length
  ) {
    return false;
  }
  const effect = effects[0];
  return Boolean(
    effect &&
      isInventorySecretAdoptionExternalEffect(effect) &&
      JSON.stringify(effect.provider) === JSON.stringify(plan.normalizedInputs.provider) &&
      effect.targetName === plan.normalizedInputs.targetName,
  );
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
