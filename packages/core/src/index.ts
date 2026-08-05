// @cellarer/core 对外 API barrel。

// engine
export {
  type ActivityAction,
  type ActivityActor,
  type ActivityEvent,
  type ActivityFilter,
  activityPath,
  listActivity,
  summarizeActivity,
} from "./activity.js";
// adapters
export type { Registry } from "./adapters/registry.js";
export { loadRegistry } from "./adapters/registry.js";
export type {
  AdapterMcp,
  AgentAdapter,
  AgentPaths,
  DetectResult,
  RuleFragment,
  RulesCodec,
  SkillsCodec,
} from "./adapters/types.js";
export {
  type AgentReadinessState,
  type DashboardAgentCounts,
  type DashboardAgentReadiness,
  type DashboardArtifactCounts,
  type DashboardCapabilityReadiness,
  type DashboardCoverageGroup,
  type DashboardDriftCounts,
  type DashboardSecretRefStat,
  type DashboardSummaryOptions,
  type DashboardSummaryResult,
  dashboardSummary,
  statusIdentityKey,
} from "./dashboard.js";
export {
  type AgentDoctorReport,
  type AgentInspection,
  type AgentInspectionReport,
  type DiagnosticCheck,
  type DiagnosticStatus,
  type DoctorReport,
  doctor,
  type InspectAgentsOptions,
  inspectAgents,
} from "./diagnostics.js";
export {
  type DiffIdentity,
  type DiffTargetOptions,
  type DiffTargetResult,
  diffTarget,
} from "./diff.js";
export {
  type AddOptions,
  type AddResult,
  add,
  type GitClient,
  type GitHubSource,
  type GitStageResult,
  type SkillCandidate,
  type SkillFrontmatter,
  type SkillProvenance,
} from "./engine/add.js";
export { apply, applyMutationPlan, planApplyMutation } from "./engine/apply.js";
export { inCollections, plan } from "./engine/plan.js";
export {
  applyRevertMutationPlan,
  planRevert,
  planRevertMutation,
  revert,
} from "./engine/revert.js";
export {
  applyScan,
  type ConflictStrategy,
  type ScanItem,
  type ScanOptions,
  type ScanPlan,
  type ScanResult,
  type ScanSelection,
  scanPlan,
} from "./engine/scan.js";
export { status } from "./engine/status.js";
export type {
  ApplyCallResult,
  ApplyFailure,
  ApplyMutationContext,
  ApplyMutationResult,
  ApplyResult,
  DistributeOptions,
  DriftStatus,
  MutationPlanOptions,
  PlannedApplyMutation,
  PlannedRevertMutation,
  RevertCallResult,
  RevertFailure,
  RevertMutationContext,
  RevertMutationResult,
  RevertOptions,
  RevertPlan,
  RevertPlanTarget,
  RevertProposedAction,
  RevertResult,
  RevertSnapshotAvailability,
  RevertSnapshotStatus,
  StatusItem,
  StatusOptions,
} from "./engine/types.js";
export {
  type AppliedDiskVerification,
  type DesiredAppliedComparisons,
  type DesiredAppliedItem,
  type DesiredAppliedStatus,
  type DesiredAppliedVerification,
  type EvidenceComparison,
  type VerificationOptions,
  type VerificationReport,
  verify,
} from "./engine/verification.js";
export type {
  Env,
  FileStat,
  FsLike,
  HeadlessLifetimeLease,
  HeadlessLifetimeOwner,
  MutationAuthority,
  MutationAuthorityLease,
  MutationAuthorityRequest,
  Platform,
  ProcessLiveness,
  ProtectedJournalTip,
  SymlinkType,
} from "./env.js";
// markers
export { GENERATED_HEADER, isGenerated, renderRules, sourceMarker } from "./markers.js";
// mcp
export type { McpCodec } from "./mcp/codec.js";
export { applyMerge, jsonMcpCodec, mcpCodecFor, tomlMcpCodec } from "./mcp/codec.js";
export type { MergeStrategy } from "./mcp/merge.js";
export type { McpDialect, McpServer, McpServerSet } from "./mcp/model.js";
export type {
  AppliedMethod,
  AppliedReceipt,
  Artifact,
  ArtifactKind,
  Capability,
  Collection,
  DesiredPlacementMethod,
  DesiredTargetEvidence,
  DistributePlan,
  Ledger,
  LedgerEntry,
  LinkMethod,
  PlanAction,
  Scope,
  SecretGuardFinding,
  SecretReferenceFinding,
  TargetAcknowledgement,
  TargetAcknowledgementKind,
  TargetClassification,
  TargetConflict,
  TargetConflictCode,
  TargetOwner,
  TargetOwnershipEvidence,
  TargetReplacementApproval,
} from "./model/index.js";
export {
  assertMutationAuthorityRotationAllowed,
  withMutationAuthorityRotationExclusion,
} from "./protocol/authority-lifecycle.js";
export {
  canonicalJson,
  canonicalMutationPlan,
  createDurableMutationPlan,
  createMutationPlan,
  verifyDurableMutationPlanDigest,
} from "./protocol/canonical.js";
export {
  CLI_PROTOCOL_VERSION,
  type CliCommandRequest,
  type CliError,
  type CliErrorCode,
  type CliErrorResultEnvelope,
  type CliEvent,
  type CliEventEnvelope,
  type CliProtocolRecord,
  type CliProtocolVersion,
  type CliResultEnvelope,
  type CliSuccessResultEnvelope,
  type CliWarning,
} from "./protocol/cli.js";
export { targetState } from "./protocol/execute.js";
export {
  DEFAULT_OPERATION_RECEIPT_RETENTION,
  listOperationReceipts,
  operationJournalPath,
  operationReceiptPath,
  operationReceiptsPath,
  readOperationJournal,
  readOperationReceipt,
} from "./protocol/journal.js";
export {
  type ActionPrecondition,
  type CanonicalJsonObject,
  type CanonicalJsonPrimitive,
  type CanonicalJsonValue,
  type DurableMutationPlan,
  type DurableMutationPlanAction,
  type ExpiredPlanConflict,
  type InterruptedOperationConflict,
  type InvalidPlanDigestConflict,
  type LockConflict,
  type LockOwnerEvidence,
  type ManualRecoveryRequiredConflict,
  MUTATION_PLAN_SCHEMA_VERSION,
  type MutationAuthorizationEnvelope,
  type MutationConflict,
  type MutationOperation,
  type MutationPlan,
  type MutationPlanAction,
  type MutationPlanInput,
  OPERATION_JOURNAL_SCHEMA_VERSION,
  OPERATION_RECEIPT_SCHEMA_VERSION,
  type OperationActionFailure,
  type OperationActionReceipt,
  type OperationJournal,
  type OperationJournalAction,
  type OperationJournalStatus,
  type OperationReceipt,
  type OperationResult,
  type OperationStatePublication,
  type PartialFailureConflict,
  type PlanExpiry,
  type StaleRevisionConflict,
  type StoreRevision,
  type TargetPreconditionConflict,
  type TargetStateReceipt,
} from "./protocol/models.js";
export {
  mutationLockPath,
  readStoreMutationLockOwner,
  readStoreRecoveryLockOwner,
  recoveryLockPath,
  type StoreMutationLock,
  type StoreMutationLockResult,
} from "./protocol/mutation-lock.js";
export {
  type MutationPresentation,
  type MutationRecoveryError,
  type MutationRecoveryPresentation,
  mutationPresentation,
  mutationRecoveryPresentation,
  type PresentedOperationResult,
} from "./protocol/presentation.js";
export {
  diagnoseMutationRecovery,
  type MutationRecoveryDiagnosis,
  type MutationRecoveryStatus,
  type OperationRecoveryRetentionOptions,
  type OperationRecoveryRetentionResult,
  pruneOperationRecoveryArtifacts,
  type RecoverInterruptedOperationOptions,
  recoverInterruptedOperation,
} from "./protocol/recovery.js";
export {
  StoreMutationConflictError,
  type StorePublicationMutationResult,
} from "./protocol/store-mutation.js";
export {
  observeAtStableStoreRevision,
  readStoreRevision,
  StoreRevisionChangedDuringPlanningError,
  storeRevisionPath,
} from "./protocol/store-revision.js";
export { createRealEnv } from "./real-env.js";
export type {
  Destination,
  ResourceCatalogCounts,
  ResourceCatalogItem,
  ResourceCatalogOptions,
  ResourceCatalogResult,
  ResourceState,
  ResourceSyncTarget,
} from "./resources/catalog.js";
export { resourceCatalog } from "./resources/catalog.js";
export type {
  AgentDiscoverySummary,
  DiscoverySummaryOptions,
  DiscoverySummaryResult,
} from "./resources/discovery.js";
export { discoverySummary } from "./resources/discovery.js";
// secrets
export {
  assertMutationAuthorityCredentialTarget,
  assertOrdinarySecretCredentialTarget,
  MUTATION_AUTHORITY_ACCOUNT_PREFIX,
  MUTATION_AUTHORITY_CREDENTIAL_SERVICE,
} from "./secrets/authority-namespace.js";
export {
  detectSecret,
  isPlaceholderValue,
  type SecretFinding,
  scanTextForSecrets,
} from "./secrets/detector.js";
export {
  type DeleteStoredSecretOptions,
  deleteStoredSecret,
  diagnoseKeychainMutationRecovery,
  type KeychainMutationRecoveryDiagnosis,
  type ListStoredSecretNamesOptions,
  listStoredSecretNames,
  missingSecretReferences,
  type ReconcileKeychainMutationRecoveryOptions,
  reconcileKeychainMutationRecovery,
  type SecretReferenceVerification,
  type SecretReferenceVerificationStatus,
  type SetStoredSecretOptions,
  type StoredSecretMutationResult,
  type StoredSecretProvider,
  setStoredSecret,
  verifySecretReferences,
} from "./secrets/provider.js";
export {
  redactSafeObservableText,
  type SafeObservableOptions,
  serializeSafeObservable,
  serializeSafeWebObservable,
} from "./secrets/public-boundary.js";
export {
  deriveSecretName,
  envPlaceholder,
  parseSecretRef,
  redactFields,
  type SecretRef,
  secretPlaceholder,
} from "./secrets/redactor.js";
export {
  type CellarerSecretReference,
  cellarerSecretReference,
  type EnvironmentSecretReference,
  environmentSecretReference,
  parseSecretReference,
  type SecretReference,
  secretReferenceToken,
} from "./secrets/reference.js";
export type { SecretMode } from "./secrets/types.js";
export type {
  DefaultsPatch,
  SettingsCollection,
  SettingsSummary,
  SettingsSummaryOptions,
} from "./settings.js";
export {
  deleteCustomAdapterConfig,
  saveCollections,
  saveDefaults,
  setAgentEnabled,
  settingsSummary,
  upsertAdapterConfig,
} from "./settings.js";
export { sha256 } from "./store/checksum.js";
// store
export type { AdapterBodyConfig, AdapterPatchConfig, CellarerConfig } from "./store/config.js";
export {
  CONFIG_FILENAME,
  initialConfigText,
  loadAdapterSpecs,
  loadConfig,
  PACKAGED_CONFIG_PATH,
  packagedConfigText,
  parseConfig,
  parsePackagedConfigForSettings,
} from "./store/config.js";
export { type InitializeStoreResult, initializeStore } from "./store/initialize.js";
export {
  addEntries,
  addOwners,
  collectLedgerSecretRefStats,
  collectLedgerSecretRefs,
  emptyLedger,
  entryKey,
  type LedgerSecretRefStat,
  LegacyLedgerVersionError,
  loadLedger,
  targetKey,
} from "./store/ledger.js";
export type { InitResult } from "./store/store.js";
export {
  isSafeArtifactName,
  listMcpArtifacts,
  listRuleArtifacts,
  listSkillArtifacts,
  readMcpArtifact,
  readRuleArtifact,
  resolveStoreRoot,
  skillProvenancePath,
} from "./store/store.js";
export {
  fingerprintTarget,
  type InspectTargetOwnershipOptions,
  inspectTargetOwnership,
  type TargetOwnershipInspection,
} from "./target-ownership.js";
