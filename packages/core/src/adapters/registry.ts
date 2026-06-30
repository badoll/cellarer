// 适配器注册表:内置 → 全局自定义 → 工程自定义,后者覆盖前者同名 id(kickoff §6.6)。
// 非法声明式适配器跳过并记 warning,不影响其余适配器。
import { join } from "node:path";
import type { Env } from "../env.js";
import { readdirOrEmpty } from "../fs/probe.js";
import { builtinAdapters } from "./builtin.js";
import { parseDeclarativeAdapter } from "./declarative.js";
import { specToAdapter } from "./spec.js";
import type { AgentAdapter } from "./types.js";

export interface Registry {
  get(id: string): AgentAdapter | undefined;
  list(): AgentAdapter[];
  warnings: string[];
}

// 从一个 adapters 目录加载所有 *.toml,逐个解析;非法记 warning。
async function loadDir(
  env: Env,
  dir: string,
  into: Map<string, AgentAdapter>,
  warnings: string[],
): Promise<void> {
  const files = await readdirOrEmpty(env, dir);
  // 仅检测「同一目录内」的同 id 重复(跨层覆盖内置/全局是设计,不告警)。
  const seenInDir = new Set<string>();
  for (const f of files.filter((x) => x.endsWith(".toml")).sort()) {
    const path = join(dir, f);
    try {
      const text = await env.fs.readFile(path);
      const spec = parseDeclarativeAdapter(text);
      if (seenInDir.has(spec.id)) {
        warnings.push(`adapter "${spec.id}" in ${f} shadows an earlier file in ${dir}`);
      }
      seenInDir.add(spec.id);
      into.set(spec.id, specToAdapter(spec));
    } catch (err) {
      warnings.push(
        `skipped invalid adapter ${f} (${path}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// 加载注册表:storeRoot/adapters(全局)+ projectDir/.cellarer/adapters(工程)。
export async function loadRegistry(
  env: Env,
  storeRoot: string,
  projectDir?: string,
): Promise<Registry> {
  const warnings: string[] = [];
  const map = new Map<string, AgentAdapter>();

  // 1. 内置
  for (const a of builtinAdapters()) map.set(a.id, a);
  // 2. 全局自定义(覆盖内置)
  await loadDir(env, join(storeRoot, "adapters"), map, warnings);
  // 3. 工程自定义(覆盖全局)
  if (projectDir) {
    await loadDir(env, join(projectDir, ".cellarer", "adapters"), map, warnings);
  }

  return {
    get: (id) => map.get(id),
    list: () => [...map.values()],
    warnings,
  };
}
