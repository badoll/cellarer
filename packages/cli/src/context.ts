// CLI 共享上下文:解析公共选项为 core 调用参数。CLI 是薄壳,不写业务逻辑(不变量 1)。
import { isAbsolute, resolve } from "node:path";
import { createRealEnv, type Env, resolveStoreRoot, type Scope } from "@cellarer/core";
import { loadKeychainStore } from "./keychain.js";
import {
  attachMutationAuthority,
  canonicalizeStoreRoot,
  type MutationAuthorityCompositionMode,
} from "./mutation-authority.js";

export interface CommonOpts {
  global?: boolean;
  agent?: string;
  dir?: string;
  collection?: string;
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
  collections?: string[];
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
export async function resolveContext(
  opts: CommonOpts,
  authorityMode: MutationAuthorityCompositionMode = "optional",
): Promise<ResolvedContext> {
  const env = createRealEnv();
  // keychain(密钥分层第 4 层)经此注入 Env.secretStore;native 不可用则保持 undefined(降级 vault)。
  // 纯只读 dry-run 的 none 模式不加载任何 credential capability。
  if (authorityMode !== "none") {
    const keychain = loadKeychainStore();
    if (keychain.available) {
      env.secretStore = keychain.store;
      env.nativeKeychainReadiness = "credential-store-not-isolated";
    } else {
      env.nativeKeychainReadiness = keychain.reason;
    }
  }
  const requestedStoreRoot = resolveStoreRoot(env);
  let storeRoot: string;
  try {
    storeRoot = await canonicalizeStoreRoot(env, requestedStoreRoot, {
      create: authorityMode === "provision",
    });
  } catch (error) {
    if (
      (authorityMode === "none" || authorityMode === "optional") &&
      (error as { code?: unknown } | null)?.code === "ENOENT"
    ) {
      storeRoot = isAbsolute(requestedStoreRoot)
        ? requestedStoreRoot
        : resolve(env.cwd(), requestedStoreRoot);
    } else {
      throw error;
    }
  }
  await attachMutationAuthority(env, storeRoot, authorityMode);
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
    collections: opts.collection ? [opts.collection] : undefined,
  };
}
