// CLI 共享上下文:解析公共选项为 core 调用参数。CLI 是薄壳,不写业务逻辑(不变量 1)。
import { isAbsolute, resolve } from "node:path";
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
  // --dir 在边界 absolutize,使 core 拿到的 target 与台账过滤都基于绝对路径
  // (core 的 relativeInside/expand 对相对路径会读 process.cwd,故在此一次性消解)。
  const dir = opts.dir
    ? isAbsolute(opts.dir)
      ? opts.dir
      : resolve(env.cwd(), opts.dir)
    : undefined;
  const scope: Scope = dir ? "project" : "global";
  return {
    env,
    storeRoot,
    scope,
    scopeFilter: dir ? "project" : undefined,
    dir,
    agents: parseAgents(opts.agent),
    channels: opts.channel ? [opts.channel] : undefined,
  };
}
