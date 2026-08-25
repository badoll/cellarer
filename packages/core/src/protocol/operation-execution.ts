import type { Env, MutationAuthorityLease } from "../env.js";
import {
  type AuthorizeOperationAction,
  executeMutationPlan,
  type MutationExecution,
  type RecordOperationAction,
  type RecordOperationExternalEffect,
} from "./execute.js";
import type { DurableOperationExternalEffect, MutationPlan, OperationResult } from "./models.js";

export interface MutationOperationExecutionOptions {
  readonly validatePreflightBeforeObservation?: () => Promise<OperationResult | null>;
  readonly validateBeforeObservationUnderLock?: () => Promise<OperationResult | null>;
  readonly validateUnderLock?: () => Promise<OperationResult | null>;
  readonly authorityLease?: MutationAuthorityLease;
  readonly externalEffects?: readonly DurableOperationExternalEffect[];
}

export type PreparedMutationOperationEffects = (
  operationId: string,
  recordAction: RecordOperationAction,
  authorizeAction: AuthorizeOperationAction,
  recordExternalEffect: RecordOperationExternalEffect,
) => Promise<MutationExecution>;

// This is the only composition seam domain adapters use. The transaction kernel still owns
// authorization, locking, journaling, execution timing, receipts, and recovery state.
export function executePreparedMutationOperation(
  env: Env,
  storeRoot: string,
  plan: MutationPlan,
  preparedEffects: PreparedMutationOperationEffects,
  options: MutationOperationExecutionOptions = {},
): Promise<OperationResult> {
  return executeMutationPlan(env, storeRoot, plan, preparedEffects, options);
}
