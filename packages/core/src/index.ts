// @cellarer/core 对外 API barrel。

export type {
  AgentAdapter,
  AgentPaths,
  DetectResult,
  RuleFragment,
  RulesCodec,
} from "./adapters/types.js";
export type {
  Env,
  FileStat,
  FsLike,
  Platform,
  SecretStore,
  SymlinkType,
} from "./env.js";
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
