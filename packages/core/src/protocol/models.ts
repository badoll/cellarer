import type {
  ActionPrecondition,
  CanonicalJsonObject,
  InventorySecretAdoptionOrphanEvidence,
  InventorySecretAdoptionProvider,
  MutationAuthorizationDomain,
  MutationAuthorizationEnvelope,
  MutationConflict,
  MutationOperation,
  MutationPlanInput,
  OperationJournalStatus,
  PlanExpiry,
  StoreRevision,
  TargetStateReceipt,
} from "./client-types.js";

export type {
  ActionPrecondition,
  CanonicalJsonObject,
  CanonicalJsonPrimitive,
  CanonicalJsonValue,
  ExpiredPlanConflict,
  InterruptedOperationConflict,
  InvalidPlanConflict,
  InvalidPlanDigestConflict,
  LockConflict,
  LockOwnerEvidence,
  ManualRecoveryRequiredConflict,
  MutationAuthorizationDomain,
  MutationAuthorizationEnvelope,
  MutationConflict,
  MutationOperation,
  MutationPlan,
  MutationPlanAction,
  MutationPlanInput,
  OperationJournalStatus,
  PartialFailureConflict,
  PlanExpiry,
  StaleRevisionConflict,
  StoreRevision,
  TargetPreconditionConflict,
  TargetStateReceipt,
} from "./client-types.js";

export const MUTATION_PLAN_SCHEMA_VERSION = 1 as const satisfies MutationPlanInput["schemaVersion"];
export const MUTATION_AUTHORIZATION_SCHEMA_VERSION =
  1 as const satisfies MutationAuthorizationEnvelope["schemaVersion"];
export const MUTATION_AUTHORIZATION_ALGORITHM =
  "HMAC-SHA-256" as const satisfies MutationAuthorizationEnvelope["algorithm"];
export const EXECUTABLE_MUTATION_PLAN_DOMAIN =
  "executable-plan-v1" as const satisfies MutationAuthorizationDomain;
export const DURABLE_MUTATION_PLAN_DOMAIN =
  "durable-plan-v1" as const satisfies MutationAuthorizationDomain;
export const OPERATION_JOURNAL_DOMAIN =
  "operation-journal-v1" as const satisfies MutationAuthorizationDomain;
export const OPERATION_JOURNAL_SCHEMA_VERSION = 1 as const;
export const OPERATION_RECEIPT_SCHEMA_VERSION = 1 as const;

export interface DurableMutationPlanAction {
  readonly actionId: string;
  readonly kind: string;
  readonly target: string;
  readonly payloadDigest: string;
  // Provider recovery needs the non-secret identity authorized by the signed action. Other
  // payloads remain digest-only so journals cannot become a second persistence surface.
  readonly payload?: CanonicalJsonObject;
  readonly postcondition?: TargetStateReceipt;
}

export interface DurableOperationExternalEffect {
  readonly effectId: string;
  readonly kind: "secret-reference-create";
  readonly provider: InventorySecretAdoptionProvider;
  readonly targetName: string;
  readonly cleanupCommand: string;
}

export type OperationExternalEffectReceipt =
  | { readonly effectId: string; readonly status: "pending" }
  | {
      readonly effectId: string;
      readonly status: "succeeded";
      readonly evidence: InventorySecretAdoptionOrphanEvidence;
    };

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
  readonly externalEffects?: readonly DurableOperationExternalEffect[];
  readonly expires: PlanExpiry;
  readonly digest: string;
  readonly durableDigest: string;
  readonly authorization: MutationAuthorizationEnvelope<typeof DURABLE_MUTATION_PLAN_DOMAIN>;
}

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
  readonly sequence: number;
  readonly previousJournalSeal: string | null;
  // Recovery consumes the exact immutable authorization rather than attempting to replan.
  readonly plan: DurableMutationPlan;
  readonly nextRevision: StoreRevision;
  readonly status: OperationJournalStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly actions: readonly OperationJournalAction[];
  readonly externalEffects?: readonly OperationExternalEffectReceipt[];
  readonly statePublications?: readonly OperationStatePublication[];
  readonly completedReceipt?: OperationReceipt;
  readonly authorization: MutationAuthorizationEnvelope<typeof OPERATION_JOURNAL_DOMAIN>;
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
