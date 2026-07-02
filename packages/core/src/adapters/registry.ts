import type { Env } from "../env.js";
import { loadAdapterSpecs } from "../store/config.js";
import { specToAdapter } from "./spec.js";
import type { AgentAdapter } from "./types.js";

export interface Registry {
  get(id: string): AgentAdapter | undefined;
  list(): AgentAdapter[];
  warnings: string[];
}

// 加载注册表:packaged built-ins + key-based user adapters。
export async function loadRegistry(env: Env, storeRoot: string): Promise<Registry> {
  const map = new Map<string, AgentAdapter>();
  const loaded = await loadAdapterSpecs(env, storeRoot);
  const warnings = [...loaded.warnings];

  for (const spec of loaded.specs) {
    if (map.has(spec.id)) {
      warnings.push(`adapter "${spec.id}" shadows an earlier config entry`);
    }
    map.set(spec.id, specToAdapter(spec));
  }

  return {
    get: (id) => map.get(id),
    list: () => [...map.values()],
    warnings,
  };
}
