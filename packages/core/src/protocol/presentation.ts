import type {
  InterruptedOperationConflict,
  ManualRecoveryRequiredConflict,
  MutationOperation,
  MutationPlan,
  OperationResult,
  StoreRevision,
} from "./models.js";
import type { MutationRecoveryDiagnosis, MutationRecoveryStatus } from "./recovery.js";

export type PresentedOperationResult =
  | Extract<OperationResult, { ok: true }>
  | { readonly ok: false; readonly conflict: Extract<OperationResult, { ok: false }>["conflict"] };

export interface MutationPresentation {
  readonly planId: string;
  readonly planDigest: string;
  readonly operation: MutationOperation;
  readonly baseRevision: StoreRevision;
  readonly result?: PresentedOperationResult;
}

export type MutationRecoveryError = InterruptedOperationConflict | ManualRecoveryRequiredConflict;

export interface MutationRecoveryPresentation {
  readonly status: MutationRecoveryStatus;
  readonly operationId?: string;
  readonly planId?: string;
  readonly baseRevision?: StoreRevision;
  readonly error?: MutationRecoveryError;
}

// This is the only operation shape intended for CLI/Web serialization. In particular, an error
// result never carries its journal because state publications contain private recovery payloads.
export function mutationPresentation(
  plan: MutationPlan,
  result?: OperationResult,
): MutationPresentation {
  const earlyConflict = result && !result.ok && isEarlyConflict(result.conflict.code);
  return {
    planId: earlyConflict ? "untrusted" : plan.planId,
    planDigest: earlyConflict ? "untrusted" : plan.digest,
    operation: plan.operation,
    baseRevision: plan.baseRevision,
    ...(result
      ? {
          result: result.ok
            ? result
            : {
                ok: false as const,
                conflict: earlyConflict ? redactEarlyConflict(result.conflict) : result.conflict,
              },
        }
      : {}),
  };
}

function isEarlyConflict(code: string): boolean {
  return [
    "LOCK_CONFLICT",
    "INTERRUPTED_OPERATION",
    "INVALID_PLAN",
    "INVALID_PLAN_DIGEST",
    "EXPIRED_PLAN",
    "STALE_REVISION",
    "TARGET_PRECONDITION_CONFLICT",
  ].includes(code);
}

function redactEarlyConflict(
  conflict: Extract<OperationResult, { ok: false }>["conflict"],
): Extract<OperationResult, { ok: false }>["conflict"] {
  if (conflict.code === "EXPIRED_PLAN") {
    return { ...conflict, planId: "untrusted", expiredAt: "untrusted" };
  }
  if (conflict.code === "STALE_REVISION") return { ...conflict, planId: "untrusted" };
  if (conflict.code === "TARGET_PRECONDITION_CONFLICT") {
    return {
      ...conflict,
      planId: "untrusted",
      actionId: "untrusted",
      target: "untrusted",
    };
  }
  if (conflict.code === "INVALID_PLAN_DIGEST") {
    return {
      ...conflict,
      planId: "untrusted",
      expectedDigest: "untrusted",
      actualDigest: "invalid",
    };
  }
  return conflict;
}

export function mutationRecoveryPresentation(
  diagnosis: MutationRecoveryDiagnosis,
): MutationRecoveryPresentation {
  if (diagnosis.status === "clean") return { status: "clean" };

  const journal = diagnosis.journal;
  const operationId =
    journal?.operationId ??
    diagnosis.recoveryLockOwner?.operationId ??
    diagnosis.lockOwner?.operationId ??
    "unknown";
  const planFields = journal
    ? {
        planId: journal.plan.planId,
        baseRevision: journal.plan.baseRevision,
      }
    : {};

  if (diagnosis.status === "manual-recovery-required") {
    return {
      status: diagnosis.status,
      operationId,
      ...planFields,
      error: {
        code: "MANUAL_RECOVERY_REQUIRED",
        message: "manual recovery is required",
        operationId,
        targets: journal?.plan.actions.map((action) => action.target) ?? [],
        guidance: diagnosis.message,
      },
    };
  }

  return {
    status: diagnosis.status,
    operationId,
    ...planFields,
    error: {
      code: "INTERRUPTED_OPERATION",
      message: diagnosis.message,
      operationId,
      journalStatus: journal?.status ?? "recovery-required",
    },
  };
}
