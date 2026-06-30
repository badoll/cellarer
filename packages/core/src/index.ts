// @cellarer/core 对外 API barrel。

// adapters
export { builtinAdapters } from "./adapters/builtin.js";
export type { Registry } from "./adapters/registry.js";
export { loadRegistry } from "./adapters/registry.js";
export type {
  AgentAdapter,
  AgentPaths,
  DetectResult,
  RuleFragment,
  RulesCodec,
} from "./adapters/types.js";
export { apply } from "./engine/apply.js";
// engine
export { inChannels, plan } from "./engine/plan.js";
export { revert } from "./engine/revert.js";
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
export { sha256 } from "./store/checksum.js";
// store
export type { CellarerConfig } from "./store/config.js";
export { loadConfig, parseConfig } from "./store/config.js";
export { addEntries, emptyLedger, loadLedger, saveLedger } from "./store/ledger.js";
export type { InitResult } from "./store/store.js";
export {
  DEFAULT_CONFIG_TOML,
  initStore,
  listRuleArtifacts,
  readRuleArtifact,
  resolveStoreRoot,
} from "./store/store.js";
