// @cellarer/core 对外 API barrel。

// adapters
export { builtinAdapters } from "./adapters/builtin.js";
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
export { apply } from "./engine/apply.js";
// engine
export { inChannels, plan } from "./engine/plan.js";
export { revert } from "./engine/revert.js";
export {
  applyScan,
  type ConflictStrategy,
  type ScanItem,
  type ScanOptions,
  type ScanPlan,
  type ScanResult,
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
  SecretStore,
  SymlinkType,
} from "./env.js";
// markers
export { GENERATED_HEADER, isGenerated, renderRules, sourceMarker } from "./markers.js";
// mcp
export type { McpCodec } from "./mcp/codec.js";
export { applyMerge, jsonMcpCodec, mcpCodecFor, tomlMcpCodec } from "./mcp/codec.js";
export type { MergeStrategy } from "./mcp/merge.js";
export type { McpServer, McpServerSet } from "./mcp/model.js";
export type {
  AppliedMethod,
  Artifact,
  ArtifactKind,
  Capability,
  Channel,
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
export { loadConfig, parseConfig } from "./store/config.js";
export {
  addEntries,
  collectLedgerSecretRefs,
  emptyLedger,
  loadLedger,
  saveLedger,
} from "./store/ledger.js";
export type { InitResult } from "./store/store.js";
export {
  DEFAULT_CONFIG_TOML,
  importSkillArtifact,
  initStore,
  listMcpArtifacts,
  listRuleArtifacts,
  listSkillArtifacts,
  readMcpArtifact,
  readRuleArtifact,
  resolveStoreRoot,
  writeMcpArtifact,
  writeRuleArtifact,
} from "./store/store.js";
