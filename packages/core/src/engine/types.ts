// 引擎对外选项与结果类型(不变量 3:plan/apply 分离)。

import type {
  AppliedReceipt,
  Capability,
  DistributePlan,
  LedgerEntry,
  LinkMethod,
  Scope,
  TargetAcknowledgement,
  TargetConflict,
  TargetOwnershipEvidence,
} from "../model/index.js";
import type {
  MutationConflict,
  MutationPlan,
  OperationResult,
  PlanExpiry,
} from "../protocol/models.js";
import type { MutationPresentation } from "../protocol/presentation.js";
import type { SecretMode } from "../secrets/types.js";

export interface DistributeOptions {
  storeRoot: string;
  scope: Scope;
  dir?: string; // project scope 的工程根
  agents: string[]; // 选中的 agent id
  resourceIds?: string[]; // 已解析的精确不可变 resource id 集合(profile sync 使用)
  collections?: string[]; // collection 过滤(缺省用 config.defaults.collections)
  capabilities?: Capability[]; // 缺省 ["rules"](M1)
  method?: LinkMethod; // 覆盖默认 method
  // mcp 合并策略覆盖(CLI --mcp-overwrite);缺省用 adapter/config 默认。
  mcpStrategy?: "merge" | "overwrite";
  // 密钥来源:缺省 env(零落盘);vault/keychain 需配套口令/store。
  secretMode?: SecretMode;
  vaultPassphrase?: string;
  keychainService?: string;
  // 精确 token 来自 plan.conflicts；两类破坏性授权不能互换。
  replaceUnowned?: string[];
  overrideDrift?: string[];
  // 仅在调用期间用于 age 加密，不进入 plan、state、activity 或制品。
  snapshotPassphrase?: string;
  dryRun?: boolean;
}

export interface ApplyFailure {
  code: "SNAPSHOT_FAILED" | "ACTION_IO_FAILED";
  target: string;
  message: string;
}

export interface ApplyResult {
  plan: DistributePlan;
  entries: LedgerEntry[]; // 实际写入台账的条目(dryRun 时为空)
  failures: ApplyFailure[];
}

export interface ApplyCallResult extends ApplyResult {
  mutation: MutationPresentation;
}

export interface MutationPlanOptions {
  planId?: string;
  expires?: PlanExpiry;
}

export interface PlannedApplyMutation {
  plan: DistributePlan;
  mutationPlan: MutationPlan;
}

export type ApplyMutationPlanPreflight =
  | {
      readonly ok: true;
      /** True only for CELLARER_SECRET references that use the selected vault/keychain provider. */
      readonly requiresCellarerSecretResolution: boolean;
      readonly requiresSnapshotPassphrase: boolean;
    }
  | { readonly ok: false; readonly conflict: MutationConflict };

export interface ApplyMutationContext {
  storeRoot: string;
  /** Canonical profile selection expected by a sync-profile apply entrypoint. */
  syncProfileId?: string;
  /** Existing argv path supplies its caller-owned options; exact sealed-plan input derives them. */
  options?: DistributeOptions;
  snapshotPassphrase?: string;
  secretMode?: SecretMode;
  vaultPassphrase?: string;
  keychainService?: string;
}

export interface ApplyMutationResult extends ApplyCallResult {
  operation: OperationResult;
}

export interface RevertOptions {
  storeRoot: string;
  scope?: Scope;
  dir?: string;
  agents?: string[];
  artifactIds?: string[];
  // 精确 token 来自 planRevert；绑定当前 target fingerprint 与 owner receipt。
  acknowledgements?: string[];
  // 仅用于本次解密 before-state，不写入 plan、state 或 activity。
  snapshotPassphrase?: string;
  keepBackups?: boolean;
  dryRun?: boolean;
}

export type RevertProposedAction = "remove-target" | "restore-snapshot";
export type RevertSnapshotStatus = "none" | "available" | "missing" | "invalid";

export interface RevertSnapshotAvailability {
  path: string | null;
  status: RevertSnapshotStatus;
  encrypted: boolean;
  digest?: string;
  mode?: number;
}

export interface RevertPlanTarget {
  target: string;
  // 同一物理 target 可能被多个历史选择命中；apply 只变更一次，成功后再释放这些 owners。
  owners: LedgerEntry[];
  expectedReceipt: AppliedReceipt;
  ownership: TargetOwnershipEvidence;
  snapshot: RevertSnapshotAvailability;
  proposedAction: RevertProposedAction;
  blocked: boolean;
  blockReason?: string;
  acknowledgement?: TargetAcknowledgement;
  driftOverridden: boolean;
}

export interface RevertPlan {
  targets: RevertPlanTarget[];
  conflicts: TargetConflict[];
  warnings: string[];
}

export interface RevertFailure {
  code: "SNAPSHOT_PASSPHRASE_REQUIRED" | "REVERT_FAILED";
  target: string;
  message: string;
}

export interface RevertResult {
  plan: RevertPlan;
  reverted: LedgerEntry[];
  failures: RevertFailure[];
  // 越界跳过等告警(如 target 在受管根之外,拒绝删除但保留台账)。
  warnings: string[];
}

export interface RevertCallResult extends RevertResult {
  mutation: MutationPresentation;
}

export interface PlannedRevertMutation {
  plan: RevertPlan;
  mutationPlan: MutationPlan;
}

export interface RevertMutationContext {
  storeRoot: string;
  /** Caller-owned canonical options; executable authority is never reconstructed from the plan. */
  options: RevertOptions;
  snapshotPassphrase?: string;
  keepBackups?: boolean;
}

export interface RevertMutationResult extends RevertCallResult {
  operation: OperationResult;
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

export interface StatusOptions {
  storeRoot: string;
  scope?: Scope;
  dir?: string;
  agents?: string[];
}
