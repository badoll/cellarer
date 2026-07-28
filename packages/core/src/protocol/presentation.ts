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
  return {
    planId: plan.planId,
    planDigest: plan.digest,
    operation: plan.operation,
    baseRevision: plan.baseRevision,
    ...(result
      ? {
          result: result.ok
            ? result
            : {
                ok: false as const,
                conflict: result.conflict,
              },
        }
      : {}),
  };
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
