import type { Env } from "../env.js";
import {
  type CellarerConfig,
  loadAdapterSpecs,
  loadAdapterSpecsFromConfig,
} from "../store/config.js";
import { specToAdapter } from "./spec.js";
import type { AgentAdapter } from "./types.js";

export interface Registry {
  get(id: string): AgentAdapter | undefined;
  list(): AgentAdapter[];
  warnings: string[];
}

// 加载注册表:packaged built-ins + key-based user adapters。
export async function loadRegistry(env: Env, storeRoot: string): Promise<Registry> {
  return registryFromSpecs(await loadAdapterSpecs(env, storeRoot));
}

export async function loadRegistryFromConfig(
  env: Env,
  configuration: CellarerConfig,
): Promise<Registry> {
  return registryFromSpecs(await loadAdapterSpecsFromConfig(env, configuration));
}

function registryFromSpecs(loaded: {
  specs: Awaited<ReturnType<typeof loadAdapterSpecs>>["specs"];
  warnings: string[];
}): Registry {
  const map = new Map<string, AgentAdapter>();
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
