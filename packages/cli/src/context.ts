// CLI 共享上下文:解析公共选项为 core 调用参数。CLI 是薄壳,不写业务逻辑(不变量 1)。
import { createRealEnv, type Env, resolveStoreRoot, type Scope } from "@cellarer/core";

export interface CommonOpts {
  global?: boolean;
  agent?: string;
  dir?: string;
  channel?: string;
}

export interface ResolvedContext {
  env: Env;
  storeRoot: string;
  // 写目标作用域(apply):始终具体 global | project。
  scope: Scope;
  // 查询作用域过滤(revert/status):--dir 时为 project,否则 undefined = 全部作用域。
  scopeFilter: Scope | undefined;
  dir?: string;
  agents: string[];
  channels?: string[];
}

// 逗号分隔 agent 列表 → 数组(去空白)。
export function parseAgents(spec: string | undefined): string[] {
  if (!spec) return [];
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// 解析作用域:--dir → project(指定工程根);否则 global。
export function resolveContext(opts: CommonOpts): ResolvedContext {
  const env = createRealEnv();
  const storeRoot = resolveStoreRoot(env);
  const scope: Scope = opts.dir ? "project" : "global";
  return {
    env,
    storeRoot,
    scope,
    scopeFilter: opts.dir ? "project" : undefined,
    dir: opts.dir,
    agents: parseAgents(opts.agent),
    channels: opts.channel ? [opts.channel] : undefined,
  };
}
