// @cellarer/core 对外 API barrel。

// engine
export {
  type ActivityAction,
  type ActivityActor,
  type ActivityEvent,
  type ActivityFilter,
  activityPath,
  appendActivity,
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
export { apply } from "./engine/apply.js";
export { inCollections, plan } from "./engine/plan.js";
export { revert } from "./engine/revert.js";
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
  ApplyResult,
  DistributeOptions,
  DriftStatus,
  RevertOptions,
  RevertResult,
  StatusItem,
  StatusOptions,
} from "./engine/types.js";
export type {
  Env,
  FileStat,
  FsLike,
  Platform,
  SecretGet,
  SecretStore,
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
  Artifact,
  ArtifactKind,
  Capability,
  Collection,
  DistributePlan,
  Ledger,
  LedgerEntry,
  LinkMethod,
  PlanAction,
  Scope,
} from "./model/index.js";
export { createRealEnv } from "./real-env.js";
// secrets
export {
  detectSecret,
  isPlaceholderValue,
  type SecretFinding,
  scanTextForSecrets,
} from "./secrets/detector.js";
export {
  deriveSecretName,
  envPlaceholder,
  parseSecretRef,
  redactFields,
  type SecretRef,
  secretPlaceholder,
} from "./secrets/redactor.js";
export {
  resolveFields,
  resolveSecretValue,
  type SecretMode,
  type SecretSources,
} from "./secrets/resolver.js";
export {
  decryptVault,
  encryptVault,
  loadVault,
  saveVault,
  vaultPath,
} from "./secrets/vault.js";
export { sha256 } from "./store/checksum.js";
// store
export type { CellarerConfig } from "./store/config.js";
export {
  CONFIG_FILENAME,
  initialConfigText,
  loadAdapterSpecs,
  loadConfig,
  PACKAGED_CONFIG_PATH,
  packagedConfigText,
  parseConfig,
  tagArtifactCollections,
} from "./store/config.js";
export {
  addEntries,
  collectLedgerSecretRefStats,
  collectLedgerSecretRefs,
  emptyLedger,
  entryKey,
  type LedgerSecretRefStat,
  loadLedger,
  saveLedger,
} from "./store/ledger.js";
export type { InitResult } from "./store/store.js";
export {
  importSkillArtifact,
  initStore,
  isSafeArtifactName,
  listMcpArtifacts,
  listRuleArtifacts,
  listSkillArtifacts,
  readMcpArtifact,
  readRuleArtifact,
  resolveStoreRoot,
  skillProvenancePath,
  writeMcpArtifact,
  writeRuleArtifact,
  writeSkillProvenance,
} from "./store/store.js";
