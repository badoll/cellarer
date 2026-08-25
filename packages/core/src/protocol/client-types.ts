// Transport-neutral DTOs shared by the local API server and browser client.
// This module must remain an import-free declaration leaf.

export type ExactType<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;

export type NormalizeType<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? Value extends (infer MutableItem)[]
      ? NormalizeType<MutableItem>[]
      : readonly NormalizeType<Item>[]
    : Value extends object
      ? { [Key in keyof Value]: NormalizeType<Value[Key]> }
      : Value;

export type ExactContract<Left, Right> = ExactType<NormalizeType<Left>, NormalizeType<Right>>;

export type MutableType<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? MutableType<Item>[]
    : Value extends object
      ? { -readonly [Key in keyof Value]: MutableType<Value[Key]> }
      : Value;

export type ExactMutableContract<Left, Right> = ExactType<
  NormalizeType<MutableType<Left>>,
  NormalizeType<MutableType<Right>>
>;

export type AssertExact<Exact extends true> = Exact;

export type Scope = "global" | "project";
export type Capability = "rules" | "mcp" | "skills";
export type Collection = string;
export type LinkMethod = "symlink" | "copy";
export type TargetClassification =
  | "absent"
  | "owned-current"
  | "owned-drifted"
  | "unowned-existing"
  | "invalid-owner";
export type AppliedMethod = "write" | "symlink" | "junction" | "copy";
export type DesiredPlacementMethod = "write" | "symlink" | "copy";

export interface DesiredTargetEvidence {
  method: DesiredPlacementMethod;
  contentFingerprint?: string;
  sourceFingerprint?: string;
  sourceIdentity?: string;
}

export interface StoreInputEvidence {
  artifactId: string;
  path: string;
  fingerprint: string;
}

export interface AppliedReceipt {
  method: AppliedMethod;
  fingerprint: string;
  contentFingerprint?: string;
  sourceFingerprint?: string;
  backup: string | null;
  generated: boolean;
  appliedAt: string;
}

export interface TargetOwnershipEvidence {
  key: string;
  classification: TargetClassification;
  target: string;
  currentFingerprint: string | null;
  expectedReceipt: AppliedReceipt | null;
}

export type TargetAcknowledgementKind =
  | "replace-unowned"
  | "override-drift"
  | "revert-drift"
  | "uninstall-drift";

export interface TargetAcknowledgement {
  kind: TargetAcknowledgementKind;
  token: string;
}

export type TargetConflictCode =
  | "UNOWNED_TARGET"
  | "OWNED_TARGET_DRIFTED"
  | "INVALID_TARGET_OWNER"
  | "SNAPSHOT_ENCRYPTION_REQUIRED"
  | "REVERT_TARGET_DRIFTED"
  | "REVERT_SNAPSHOT_UNAVAILABLE";

export interface TargetConflict {
  code: TargetConflictCode;
  target: string;
  message: string;
  ownership: TargetOwnershipEvidence;
  acknowledgement?: TargetAcknowledgement;
}

export interface TargetReplacementApproval {
  acknowledgement: TargetAcknowledgement;
  snapshotRequired: true;
}

export interface PlanAction {
  artifact: string;
  artifactIds?: string[];
  agent: string;
  scope: Scope;
  capability: Capability;
  target: string;
  source?: string;
  method: LinkMethod;
  op: "write" | "symlink" | "copy" | "merge" | "overwrite" | "skip";
  reason?: string;
  preview?: { before?: string; after?: string };
  secretRefs?: string[];
  accidentalPlaintext?: boolean;
  desiredEvidence?: DesiredTargetEvidence;
  storeInputs?: StoreInputEvidence[];
  ownership?: TargetOwnershipEvidence;
  replacement?: TargetReplacementApproval;
}

export interface SecretReferenceFinding {
  reference: string;
  provider: "environment" | "vault" | "keychain";
  status: "missing" | "unavailable";
}

export interface SecretGuardFinding {
  artifact: string;
  source: string;
  line: number;
  rule: string;
  patternVersion?: number;
}

export interface DistributePlan {
  actions: PlanAction[];
  warnings: string[];
  conflicts: TargetConflict[];
  secretFindings?: SecretGuardFinding[];
  secretReferenceFindings?: SecretReferenceFinding[];
  invalidLedger?: true;
}

export type StoreRevision = number;
export type MutationOperation =
  | "initialize"
  | "apply"
  | "revert"
  | "settings"
  | "secret-metadata"
  | "store-import"
  | "resource-lifecycle"
  | "sync-uninstall";
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
  readonly schemaVersion: 1;
  readonly planId: string;
  readonly operation: MutationOperation;
  readonly baseRevision: StoreRevision;
  readonly normalizedInputs: CanonicalJsonObject;
  readonly targetPreconditions: readonly ActionPrecondition[];
  readonly actions: readonly MutationPlanAction[];
  readonly expires: PlanExpiry;
}

export type MutationAuthorizationDomain =
  | "executable-plan-v1"
  | "durable-plan-v1"
  | "operation-journal-v1";

export interface MutationAuthorizationEnvelope<
  Domain extends MutationAuthorizationDomain = MutationAuthorizationDomain,
> {
  readonly schemaVersion: 1;
  readonly domain: Domain;
  readonly algorithm: "HMAC-SHA-256";
  readonly authorityId: string;
  readonly authorityEpoch: number;
  readonly seal: string;
}

export interface MutationPlan extends MutationPlanInput {
  readonly digest: string;
  readonly authorization: MutationAuthorizationEnvelope<"executable-plan-v1">;
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

export interface InvalidPlanConflict {
  readonly code: "INVALID_PLAN";
  readonly message: "mutation plan is invalid";
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
  | InvalidPlanConflict
  | StaleRevisionConflict
  | ExpiredPlanConflict
  | InvalidPlanDigestConflict
  | TargetPreconditionConflict
  | InterruptedOperationConflict
  | PartialFailureConflict
  | ManualRecoveryRequiredConflict;

export type CliErrorCode =
  | "INVALID_USAGE"
  | "INVALID_INPUT"
  | "INPUT_REQUIRED"
  | "INPUT_AMBIGUITY"
  | "POLICY_VIOLATION"
  | "DOMAIN_VALIDATION_FAILED"
  | "STALE_REVISION"
  | "LOCK_CONFLICT"
  | "TARGET_CONFLICT"
  | "EXECUTION_FAILED"
  | "PARTIAL_FAILURE"
  | "RECOVERY_REQUIRED"
  | "INTERNAL_ERROR";

export type ClientErrorCode = CliErrorCode;

export type ResourceState = "managed" | "discovered" | "synced" | "drifted" | "missing" | "blocked";
export type Destination = "user" | "project";

export type ResourceSourceDescriptor =
  | { type: "local-snapshot"; capturedFrom?: string }
  | {
      type: "git";
      repositoryUrl: string;
      ref: string;
      commit: string;
      subpath: string;
    }
  | {
      type: "url";
      url: string;
      integrity: string;
      validators?: { etag?: string; lastModified?: string };
    };

export type ResourceValidationCheck =
  | "content-fingerprint"
  | "manifest"
  | "adapter-compatibility"
  | "secret-scan";

export interface ResourceValidationEvidence {
  status: "validated" | "backfilled";
  checkedAt: string;
  checks: ResourceValidationCheck[];
}

export interface ResourceRevision {
  id: string;
  contentFingerprint: string;
  validation: ResourceValidationEvidence;
  source: ResourceSourceDescriptor;
}

export interface ResourceSyncTarget {
  agent: string;
  destination: Destination;
  scope: Scope;
  target: string;
  state: Exclude<ResourceState, "managed" | "discovered">;
  reason?: string;
}

export interface ResourceCatalogItem {
  id: string;
  kind: Capability;
  name: string;
  state: ResourceState;
  collections: Collection[];
  sourcePath?: string;
  currentRevision?: ResourceRevision;
  provenance?: ResourceSourceDescriptor;
  discovered?: {
    agent: string;
    destination: Destination;
    source: string;
    candidateId: string;
    defaultSelected: boolean;
    sources: readonly InventorySourceProvenance[];
    relatedAdapters: readonly InventoryRelatedAdapter[];
    findings: readonly InventoryFinding[];
  };
  syncTargets: ResourceSyncTarget[];
  secretRefs: string[];
  lastActivityAt?: string;
}

export interface ResourceCatalogCounts {
  managed: number;
  discovered: number;
  synced: number;
  drifted: number;
  missing: number;
  blocked: number;
}

export interface ResourceCatalogResult {
  generatedAt: string;
  resources: ResourceCatalogItem[];
  counts: ResourceCatalogCounts;
  warnings: string[];
}

export type InventoryCompleteness = "complete" | "partial" | "failed";
export type InventoryCandidateState = "ready" | "needs-attention" | "in-store";
export type InventoryFindingCode =
  | "ADAPTER_DETECTION_FAILED"
  | "ADAPTER_PATHS_FAILED"
  | "SOURCE_OUTSIDE_BOUNDARY"
  | "SOURCE_UNREADABLE"
  | "UNSAFE_LINK"
  | "UNSUPPORTED_SNAPSHOT"
  | "SNAPSHOT_STALE"
  | "INVALID_STRUCTURE"
  | "PARSE_FAILED"
  | "PROBABLE_SECRET"
  | "CONFLICT"
  | "STORE_SNAPSHOT_STALE"
  | "STORE_SNAPSHOT_UNSAFE"
  | "STORE_PROJECTION_FAILED";
export type InventoryFindingRemediation =
  | "review-adapter"
  | "check-source-access"
  | "remove-unsafe-link"
  | "retry-refresh"
  | "fix-structure"
  | "remove-secret-values"
  | "resolve-conflict"
  | "repair-store";

export interface InventoryFinding {
  readonly code: InventoryFindingCode;
  readonly severity: "warning" | "blocked";
  readonly scope: "refresh" | "source" | "candidate";
  readonly remediation: InventoryFindingRemediation;
  readonly sourceId?: string;
}

export interface InventoryRelatedAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly detected: boolean;
}

export interface InventorySourceProvenance {
  readonly id: string;
  readonly kind: Capability;
  readonly scope: Scope;
  readonly location: string;
  readonly adapters: readonly InventoryRelatedAdapter[];
}

export interface InventoryManagedMatch {
  readonly resourceId: string;
  readonly revisionId: string;
}

export interface InventoryCandidate {
  readonly id: string;
  readonly kind: Capability;
  readonly name: string;
  readonly contentFingerprint: string;
  readonly state: InventoryCandidateState;
  readonly defaultSelected: boolean;
  readonly sources: readonly InventorySourceProvenance[];
  readonly relatedAdapters: readonly InventoryRelatedAdapter[];
  readonly findings: readonly InventoryFinding[];
  readonly managedMatch?: InventoryManagedMatch;
  readonly conflictGroupId?: string;
}

export interface InventoryCounts {
  readonly total: number;
  readonly ready: number;
  readonly needsAttention: number;
  readonly inStore: number;
  readonly observedSources: number;
  readonly failedSources: number;
}

export interface InventoryRefreshResult {
  readonly generatedAt: string;
  readonly candidates: readonly InventoryCandidate[];
  readonly findings: readonly InventoryFinding[];
  readonly counts: InventoryCounts;
  readonly completeness: InventoryCompleteness;
}

export type PostCommitInventoryRefresh =
  | {
      readonly agentId: string;
      readonly status: "complete";
      readonly inventory: InventoryRefreshResult & { readonly completeness: "complete" };
    }
  | {
      readonly agentId: string;
      readonly status: "partial";
      readonly inventory: InventoryRefreshResult & { readonly completeness: "partial" };
      readonly retryCommand: `cellarer inventory refresh --agent ${string}`;
    }
  | {
      readonly agentId: string;
      readonly status: "failed";
      readonly inventory: InventoryRefreshResult & { readonly completeness: "failed" };
      readonly retryCommand: `cellarer inventory refresh --agent ${string}`;
    };

export interface ControlPlaneValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ControlPlaneResourceValidation {
  readonly status: "valid" | "warning" | "invalid";
  readonly issues: readonly ControlPlaneValidationIssue[];
}

export interface ControlPlaneResourceDesiredUsage {
  readonly collection: string;
}

export interface ControlPlaneResourceDto {
  readonly id: string;
  readonly kind: Capability;
  readonly name: string;
  readonly source: string;
  readonly state: ResourceState;
  readonly currentRevision?: ResourceRevision;
  readonly provenance?: ResourceSourceDescriptor;
  readonly discovered?: ResourceCatalogItem["discovered"];
  readonly membership: { readonly collections: readonly string[] };
  readonly selection: {
    readonly desired: boolean;
    readonly collections: readonly string[];
    readonly inventoryDefault?: boolean;
  };
  readonly validation: ControlPlaneResourceValidation;
  readonly secretReferenceNames: readonly string[];
  readonly usage: {
    readonly desired: readonly ControlPlaneResourceDesiredUsage[];
    readonly applied: readonly ResourceSyncTarget[];
  };
  readonly lastActivityAt?: string;
}

export interface ControlPlaneResourceListDto {
  readonly generatedAt: string;
  readonly resources: readonly ControlPlaneResourceDto[];
  readonly counts: ResourceCatalogCounts;
  readonly warnings: readonly string[];
}

export interface ControlPlaneAgentTarget {
  readonly capability: Capability;
  readonly scope: Scope;
  readonly path: string;
}

export interface ControlPlaneAgentDto {
  readonly id: string;
  readonly displayName: string;
  readonly adapterKind: "built-in" | "custom";
  readonly supported: true;
  readonly detected: boolean;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly detectionEvidence: { readonly root?: string };
  readonly capabilities: readonly Capability[];
  readonly capabilityScopes: Readonly<Record<Capability, readonly Scope[]>>;
  readonly targets: readonly ControlPlaneAgentTarget[];
  readonly validationIssues: readonly ControlPlaneValidationIssue[];
}

export interface ControlPlaneAgentListDto {
  readonly storeRoot: string;
  readonly scope: Scope;
  readonly dir?: string;
  readonly agents: readonly ControlPlaneAgentDto[];
  readonly warnings: readonly string[];
}

export type DriftStatus = "ok" | "drifted" | "missing" | "broken-link";

export interface StatusItem {
  artifact: string;
  agent: string;
  scope: Scope;
  capability: Capability;
  target: string;
  status: DriftStatus;
}

export type ActivityAction = "apply" | "inventory-import" | "scan-import" | "revert";
export type ActivityActor = "you" | "system";

export interface ActivityEvent {
  version: 1;
  id: string;
  time: string;
  actor: ActivityActor;
  action: ActivityAction;
  scope?: Scope;
  projectDir?: string;
  agents: string[];
  capabilities: Capability[];
  affectedCount: number;
  warningsCount: number;
  summary: string;
  resources?: { ledgerEntryKeys: string[]; artifactIds: string[] };
  secretRefs: string[];
}

export type AgentReadinessState =
  | "disabled"
  | "not-found"
  | "detected"
  | "ready"
  | "warning"
  | "unsupported";

export interface DashboardArtifactCounts {
  rules: number;
  mcp: number;
  skills: number;
  total: number;
}

export interface DashboardAgentCounts {
  registered: number;
  detected: number;
  ready: number;
  warning: number;
  missing: number;
}

export type DashboardDriftCounts = Record<DriftStatus, number>;

export interface DashboardCapabilityReadiness {
  capability: Capability;
  status: "ready" | "warning" | "unsupported";
  paths: string[];
  warnings: string[];
}

export interface DashboardAgentReadiness {
  id: string;
  displayName: string;
  enabled: boolean;
  scope: Scope;
  root?: string;
  detected: boolean;
  status: AgentReadinessState;
  supportedCapabilities: Capability[];
  capabilities: DashboardCapabilityReadiness[];
  warnings: string[];
}

export interface DashboardCoverageGroup {
  collection: Collection;
  scope: Scope;
  percentage: number | null;
  appliedCount: number;
  desiredCount: number;
  driftedCount: number;
  missingCount: number;
  brokenLinkCount: number;
  blockedCount: number;
  targetsCount: number;
  artifactsCount: number;
  lastAppliedAt?: string;
  emptyReason?: string;
}

export interface DashboardSecretRefStat {
  name: string;
  ledgerEntryCount: number;
}

export interface DashboardSummaryResult {
  generatedAt: string;
  localSafety: {
    localOnly: true;
    host: "127.0.0.1";
    database: false;
    secrets: "masked";
  };
  scope: Scope;
  dir?: string;
  collections: string[];
  capabilities: Capability[];
  artifactCounts: DashboardArtifactCounts;
  agentCounts: DashboardAgentCounts;
  driftCounts: DashboardDriftCounts;
  secretRefs: DashboardSecretRefStat[];
  isEmptyStore: boolean;
  agents: DashboardAgentReadiness[];
  distributionCoverage: DashboardCoverageGroup[];
  driftItems: StatusItem[];
  latestActivity: ActivityEvent[];
  warnings: string[];
}

export interface SettingsCollection {
  name: string;
  description?: string;
}

export interface SettingsSummary {
  storeRoot: string;
  cellarerHomeActive: boolean;
  defaults: {
    method: LinkMethod;
    collections: string[];
    secretMode: "env" | "vault" | "keychain";
    os?: {
      win32?: { method?: LinkMethod };
      darwin?: { method?: LinkMethod };
      linux?: { method?: LinkMethod };
    };
  };
  collections: SettingsCollection[];
  builtinAdapterIds: string[];
  customAdapterIds: string[];
  secretRefs: { name: string; ledgerEntryCount: number }[];
}
