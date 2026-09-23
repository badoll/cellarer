import type { ClientErrorCode, MutationConflict } from "./client-types.js";

export type {
  ActivityAction,
  ActivityActor,
  ActivityEvent,
  Capability,
  ClientErrorCode,
  ClientSyncProfile,
  ClientSyncProfileDesiredState,
  ConfigurationOutcome,
  ControlPlaneAgentDto,
  ControlPlaneAgentListDto,
  ControlPlaneResourceDto,
  ControlPlaneResourceListDto,
  DashboardAgentReadiness,
  DashboardCoverageGroup,
  DashboardSummaryResult,
  Destination,
  DistributePlan,
  DriftStatus,
  InventoryCandidate,
  InventoryCandidateState,
  InventoryCompleteness,
  InventoryCounts,
  InventoryCoverage,
  InventoryEffectiveResource,
  InventoryFinding,
  InventoryFindingCode,
  InventoryFindingRemediation,
  InventoryManagedMatch,
  InventoryRefreshResult,
  InventoryRelatedAdapter,
  InventorySecretAdoptionOffer,
  InventorySecretAdoptionOrphanEvidence,
  InventorySecretAdoptionProvider,
  InventorySecretFieldSelector,
  InventorySecretProviderPrecondition,
  InventorySourceProvenance,
  MutationPlan,
  PostCommitInventoryRefresh,
  ResourceCatalogItem,
  ResourceCatalogResult,
  ResourceState,
  Scope,
  SettingsSummary,
  StatusItem,
  VerificationCoverage,
  VerificationCoverageItem,
  VerificationCoverageOutcome,
  VerificationRuntimeEvidence,
} from "./client-types.js";

export const CLIENT_API_VERSION = "1.0" as const;
export const CLIENT_API_CONTRACT_ID = "cellarer-local-client-api-v1" as const;
export const CLIENT_API_MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export type ClientApiVersion = typeof CLIENT_API_VERSION;

export interface ClientWarning {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ClientError {
  readonly code: ClientErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

interface ClientResultEnvelopeBase {
  readonly apiVersion: ClientApiVersion;
  readonly requestId: string;
  readonly warnings: readonly ClientWarning[];
}

export interface ClientSuccessResultEnvelope<TData = unknown> extends ClientResultEnvelopeBase {
  readonly status: "success";
  readonly data: TData;
  readonly error?: never;
}

export interface ClientErrorResultEnvelope<TData = never> extends ClientResultEnvelopeBase {
  readonly status: "error";
  readonly data?: TData;
  readonly error: ClientError;
}

export type ClientResultEnvelope<TData = unknown, TErrorData = never> =
  | ClientSuccessResultEnvelope<TData>
  | ClientErrorResultEnvelope<TErrorData>;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function resolveClientRequestId(
  supplied: string | undefined,
  createId: () => string,
): string {
  if (supplied !== undefined && REQUEST_ID_PATTERN.test(supplied)) return supplied;
  const generated = `req-${createId()}`;
  if (!REQUEST_ID_PATTERN.test(generated))
    throw new TypeError("invalid generated request identifier");
  return generated;
}

export function clientSuccess<TData>(
  requestId: string,
  data: TData,
  warnings: readonly ClientWarning[] = [],
): ClientSuccessResultEnvelope<TData> {
  return { apiVersion: CLIENT_API_VERSION, requestId, status: "success", warnings, data };
}

export function clientFailure<TData = never>(
  requestId: string,
  error: ClientError,
  warnings: readonly ClientWarning[] = [],
  data?: TData,
): ClientErrorResultEnvelope<TData> {
  return {
    apiVersion: CLIENT_API_VERSION,
    requestId,
    status: "error",
    warnings,
    error,
    ...(data === undefined ? {} : { data }),
  };
}

export function clientErrorFromMutationConflict(conflict: MutationConflict): ClientError {
  switch (conflict.code) {
    case "LOCK_CONFLICT":
      return {
        code: "LOCK_CONFLICT",
        message: conflict.message,
        details: { coreCode: conflict.code, owner: conflict.owner },
      };
    case "STALE_REVISION":
      return {
        code: "STALE_REVISION",
        message: conflict.message,
        details: {
          coreCode: conflict.code,
          planId: conflict.planId,
          expectedRevision: conflict.expectedRevision,
          actualRevision: conflict.actualRevision,
          replanRequired: conflict.replanRequired,
        },
      };
    case "TARGET_PRECONDITION_CONFLICT":
      return {
        code: "TARGET_CONFLICT",
        message: conflict.message,
        details: {
          coreCode: conflict.code,
          planId: conflict.planId,
          actionId: conflict.actionId,
          target: conflict.target,
          expected: conflict.expected,
          actual: conflict.actual,
          replanRequired: true,
        },
      };
    case "PARTIAL_FAILURE":
      return {
        code: "PARTIAL_FAILURE",
        message: conflict.message,
        details: {
          coreCode: conflict.code,
          operationId: conflict.operationId,
          failedActionIds: conflict.failedActionIds,
        },
      };
    case "INTERRUPTED_OPERATION":
      return {
        code: "RECOVERY_REQUIRED",
        message: conflict.message,
        details: {
          coreCode: conflict.code,
          operationId: conflict.operationId,
          journalStatus: conflict.journalStatus,
        },
      };
    case "MANUAL_RECOVERY_REQUIRED":
      return {
        code: "RECOVERY_REQUIRED",
        message: conflict.message,
        details: {
          coreCode: conflict.code,
          operationId: conflict.operationId,
          targets: conflict.targets,
          guidance: conflict.guidance,
        },
      };
    case "EXPIRED_PLAN":
      return {
        code: "DOMAIN_VALIDATION_FAILED",
        message: conflict.message,
        details: {
          coreCode: conflict.code,
          planId: conflict.planId,
          expiredAt: conflict.expiredAt,
        },
      };
    case "INVALID_PLAN_DIGEST":
      return {
        code: "DOMAIN_VALIDATION_FAILED",
        message: conflict.message,
        details: {
          coreCode: conflict.code,
          planId: conflict.planId,
          expectedDigest: conflict.expectedDigest,
          actualDigest: conflict.actualDigest,
        },
      };
    case "INVALID_PLAN":
      return {
        code: "DOMAIN_VALIDATION_FAILED",
        message: conflict.message,
        details: { coreCode: conflict.code },
      };
  }
}
