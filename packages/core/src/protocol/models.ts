export const MUTATION_PLAN_SCHEMA_VERSION = 1 as const;
export const OPERATION_JOURNAL_SCHEMA_VERSION = 1 as const;
export const OPERATION_RECEIPT_SCHEMA_VERSION = 1 as const;

export type StoreRevision = number;
export type MutationOperation =
  | "initialize"
  | "apply"
  | "revert"
  | "settings"
  | "secret-metadata"
  | "store-import";

export type CanonicalJsonPrimitive = null | boolean | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | CanonicalJsonObject;
export interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}

export type TargetStateReceipt =
  | { readonly state: "absent" }
  | {
      readonly state: "present";
      readonly fingerprint: string;
      readonly recoverySnapshot?: string;
      readonly recoverySnapshotDigest?: string;
      readonly recoverySnapshotMode?: number;
    };

export interface ActionPrecondition {
  readonly actionId: string;
  readonly target: string;
  readonly expected: TargetStateReceipt;
}

export interface MutationPlanAction {
  readonly actionId: string;
  readonly kind: string;
  readonly target: string;
  readonly payload: CanonicalJsonObject;
  readonly postcondition?: TargetStateReceipt;
}

export type PlanExpiry =
  | { readonly policy: "none" }
  | { readonly policy: "expires-at"; readonly expiresAt: string };

export interface MutationPlanInput {
  readonly schemaVersion: typeof MUTATION_PLAN_SCHEMA_VERSION;
  readonly planId: string;
  readonly operation: MutationOperation;
  readonly baseRevision: StoreRevision;
  readonly normalizedInputs: CanonicalJsonObject;
  readonly targetPreconditions: readonly ActionPrecondition[];
  readonly actions: readonly MutationPlanAction[];
  readonly expires: PlanExpiry;
}

export interface MutationPlan extends MutationPlanInput {
  readonly digest: string;
}

export interface DurableMutationPlanAction {
  readonly actionId: string;
  readonly kind: string;
  readonly target: string;
  readonly payloadDigest: string;
  readonly postcondition?: TargetStateReceipt;
}

// Durable journals retain only the exact plan receipt and digests needed to validate recovery
// evidence. Raw normalized inputs and action payloads remain in the caller-supplied in-memory plan.
export interface DurableMutationPlan {
  readonly schemaVersion: typeof MUTATION_PLAN_SCHEMA_VERSION;
  readonly planId: string;
  readonly operation: MutationOperation;
  readonly baseRevision: StoreRevision;
  readonly normalizedInputsDigest: string;
  readonly targetPreconditions: readonly ActionPrecondition[];
  readonly actions: readonly DurableMutationPlanAction[];
  readonly expires: PlanExpiry;
  readonly digest: string;
  readonly durableDigest: string;
}

export interface LockOwnerEvidence {
  readonly operationId: string;
  readonly processId: number;
  readonly hostname: string;
  readonly acquiredAt: string;
}

export interface LockConflict {
  readonly code: "LOCK_CONFLICT";
  readonly message: string;
  readonly owner: LockOwnerEvidence;
}

export interface StaleRevisionConflict {
  readonly code: "STALE_REVISION";
  readonly message: string;
  readonly planId: string;
  readonly expectedRevision: StoreRevision;
  readonly actualRevision: StoreRevision;
  readonly replanRequired: true;
}

export interface ExpiredPlanConflict {
  readonly code: "EXPIRED_PLAN";
  readonly message: string;
  readonly planId: string;
  readonly expiredAt: string;
}

export interface InvalidPlanDigestConflict {
  readonly code: "INVALID_PLAN_DIGEST";
  readonly message: string;
  readonly planId: string;
  readonly expectedDigest: string;
  readonly actualDigest: string;
}

export interface TargetPreconditionConflict {
  readonly code: "TARGET_PRECONDITION_CONFLICT";
  readonly message: string;
  readonly planId: string;
  readonly actionId: string;
  readonly target: string;
  readonly expected: TargetStateReceipt;
  readonly actual: TargetStateReceipt;
}

export type OperationJournalStatus =
  | "prepared"
  | "executing"
  | "publishing-state"
  | "completed"
  | "recovery-required";

export interface InterruptedOperationConflict {
  readonly code: "INTERRUPTED_OPERATION";
  readonly message: string;
  readonly operationId: string;
  readonly journalStatus: OperationJournalStatus;
}

export interface PartialFailureConflict {
  readonly code: "PARTIAL_FAILURE";
  readonly message: string;
  readonly operationId: string;
  readonly failedActionIds: readonly string[];
}

export interface ManualRecoveryRequiredConflict {
  readonly code: "MANUAL_RECOVERY_REQUIRED";
  readonly message: string;
  readonly operationId: string;
  readonly targets: readonly string[];
  readonly guidance: string;
}

export type MutationConflict =
  | LockConflict
  | StaleRevisionConflict
  | ExpiredPlanConflict
  | InvalidPlanDigestConflict
  | TargetPreconditionConflict
  | InterruptedOperationConflict
  | PartialFailureConflict
  | ManualRecoveryRequiredConflict;

export interface OperationActionFailure {
  readonly code: string;
  readonly message: string;
}

export interface OperationActionReceipt {
  readonly actionId: string;
  readonly target: string;
  readonly outcome: "applied" | "unchanged" | "compensated" | "failed";
  readonly before: TargetStateReceipt;
  readonly after: TargetStateReceipt;
  readonly recordedAt: string;
  readonly error?: OperationActionFailure;
}

export type OperationJournalAction =
  | {
      readonly actionId: string;
      readonly target: string;
      readonly status: "pending";
    }
  | {
      readonly actionId: string;
      readonly target: string;
      readonly status: "succeeded" | "failed";
      readonly receipt: OperationActionReceipt;
    };

export interface OperationStatePublication {
  readonly path: string;
  readonly digest: string;
  readonly mode?: number;
}

export interface OperationJournal {
  readonly schemaVersion: typeof OPERATION_JOURNAL_SCHEMA_VERSION;
  readonly operationId: string;
  // Recovery consumes the exact immutable authorization rather than attempting to replan.
  readonly plan: DurableMutationPlan;
  readonly nextRevision: StoreRevision;
  readonly status: OperationJournalStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly actions: readonly OperationJournalAction[];
  readonly statePublications?: readonly OperationStatePublication[];
  readonly completedReceipt?: OperationReceipt;
}

export interface OperationReceipt {
  readonly schemaVersion: typeof OPERATION_RECEIPT_SCHEMA_VERSION;
  readonly operationId: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly operation: MutationOperation;
  readonly baseRevision: StoreRevision;
  readonly resultingRevision: StoreRevision;
  readonly outcome: "committed" | "compensated" | "manual-recovery-required";
  readonly actionReceipts: readonly OperationActionReceipt[];
  readonly startedAt: string;
  readonly completedAt: string;
}

export type OperationResult =
  | { readonly ok: true; readonly receipt: OperationReceipt }
  | {
      readonly ok: false;
      readonly conflict: MutationConflict;
      readonly journal?: OperationJournal;
    };
