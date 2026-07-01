// 引擎对外选项与结果类型(不变量 3:plan/apply 分离)。

import type { Capability, DistributePlan, LedgerEntry, LinkMethod, Scope } from "../model/index.js";
import type { SecretMode } from "../secrets/resolver.js";

export interface DistributeOptions {
  storeRoot: string;
  scope: Scope;
  dir?: string; // project scope 的工程根
  agents: string[]; // 选中的 agent id
  channels?: string[]; // 通道过滤(缺省用 config.defaults.channels)
  capabilities?: Capability[]; // 缺省 ["rules"](M1)
  method?: LinkMethod; // 覆盖默认 method
  // mcp 合并策略覆盖(CLI --mcp-overwrite);缺省用 adapter/config 默认。
  mcpStrategy?: "merge" | "overwrite";
  // 密钥来源:缺省 env(零落盘);vault/keychain 需配套口令/store。
  secretMode?: SecretMode;
  vaultPassphrase?: string;
  dryRun?: boolean;
}

export interface ApplyResult {
  plan: DistributePlan;
  entries: LedgerEntry[]; // 实际写入台账的条目(dryRun 时为空)
}

export interface RevertOptions {
  storeRoot: string;
  scope?: Scope;
  dir?: string;
  agents?: string[];
  keepBackups?: boolean;
  dryRun?: boolean;
}

export interface RevertResult {
  reverted: LedgerEntry[];
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
