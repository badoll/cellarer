import type { Env } from "./env.js";
import type { LinkMethod } from "./model/index.js";
import type { SecretMode } from "./secrets/resolver.js";
import {
  type AdapterPatchConfig,
  type AdapterBodyConfig,
  type CellarerConfig,
  loadConfig,
  parseAdapterBodyConfig,
  parseAdapterPatchConfig,
  packagedConfigText,
  parsePackagedConfigForSettings,
  saveConfig,
} from "./store/config.js";
import { collectLedgerSecretRefStats, loadLedger } from "./store/ledger.js";
import { resolveStoreRoot } from "./store/store.js";

export interface SettingsSummaryOptions {
  storeRoot: string;
}

export interface SettingsCollection {
  name: string;
  description?: string;
}

export interface SettingsSummary {
  storeRoot: string;
  cellarerHomeActive: boolean;
  defaults: CellarerConfig["defaults"];
  collections: SettingsCollection[];
  builtinAdapterIds: string[];
  customAdapterIds: string[];
  secretRefs: { name: string; ledgerEntryCount: number }[];
}

export interface DefaultsPatch {
  method?: LinkMethod;
  collections?: string[];
  secretMode?: SecretMode;
}

function validateCollectionsConfig(config: CellarerConfig): void {
  const errors: string[] = [];

  if (!config.collections.default) {
    errors.push('collections.default must exist');
  }

  if (config.defaults.collections.length === 0) {
    errors.push("defaults.collections must contain at least one collection");
  }

  const missingDefaults = config.defaults.collections.filter((name) => !config.collections[name]);
  if (missingDefaults.length > 0) {
    errors.push(
      `defaults.collections contains unknown collection${missingDefaults.length > 1 ? "s" : ""}: ${missingDefaults.join(", ")}`,
    );
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

async function loadBuiltinAdapterIds(env: Env): Promise<Set<string>> {
  const packaged = parsePackagedConfigForSettings(await packagedConfigText(env));
  return new Set(Object.keys(packaged.builtinAdapters));
}

function validateCustomAdapterConfig(adapterId: string, adapter: AdapterPatchConfig): AdapterBodyConfig {
  try {
    return parseAdapterBodyConfig(adapter);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid custom adapter "${adapterId}": ${message}`);
  }
}

export async function settingsSummary(
  env: Env,
  opts: SettingsSummaryOptions,
): Promise<SettingsSummary> {
  const [config, packaged, ledger] = await Promise.all([
    loadConfig(env, opts.storeRoot),
    packagedConfigText(env).then(parsePackagedConfigForSettings),
    loadLedger(env, opts.storeRoot),
  ]);
  const builtinAdapterIds = Object.keys(packaged.builtinAdapters);
  const customAdapterIds = Object.keys(config.adapters).filter((id) => !builtinAdapterIds.includes(id));
  return {
    storeRoot: opts.storeRoot,
    cellarerHomeActive: resolveStoreRoot(env) === opts.storeRoot && !!env.env.CELLARER_HOME,
    defaults: config.defaults,
    collections: Object.entries(config.collections).map(([name, value]) => ({
      name,
      description: value.description,
    })),
    builtinAdapterIds,
    customAdapterIds,
    secretRefs: collectLedgerSecretRefStats(ledger),
  };
}

export async function saveCollections(
  env: Env,
  storeRoot: string,
  collections: CellarerConfig["collections"],
): Promise<CellarerConfig> {
  const config = await loadConfig(env, storeRoot);
  const next = { ...config, collections };
  validateCollectionsConfig(next);
  await saveConfig(env, storeRoot, next);
  return next;
}

export async function saveDefaults(
  env: Env,
  storeRoot: string,
  patch: DefaultsPatch,
): Promise<CellarerConfig> {
  const config = await loadConfig(env, storeRoot);
  const next = { ...config, defaults: { ...config.defaults, ...patch } };
  validateCollectionsConfig(next);
  await saveConfig(env, storeRoot, next);
  return next;
}

export async function setAgentEnabled(
  env: Env,
  storeRoot: string,
  agentId: string,
  enabled: boolean,
): Promise<CellarerConfig> {
  const config = await loadConfig(env, storeRoot);
  const next = {
    ...config,
    agents: {
      ...config.agents,
      [agentId]: { ...config.agents[agentId], enabled },
    },
  };
  await saveConfig(env, storeRoot, next);
  return next;
}

export async function upsertAdapterConfig(
  env: Env,
  storeRoot: string,
  adapterId: string,
  adapter: AdapterPatchConfig,
): Promise<CellarerConfig> {
  const config = await loadConfig(env, storeRoot);
  const builtinAdapterIds = await loadBuiltinAdapterIds(env);
  const nextAdapter = builtinAdapterIds.has(adapterId)
    ? parseAdapterPatchConfig(adapter)
    : validateCustomAdapterConfig(adapterId, adapter);
  const next = { ...config, adapters: { ...config.adapters, [adapterId]: nextAdapter } };
  await saveConfig(env, storeRoot, next);
  return next;
}

export async function deleteCustomAdapterConfig(
  env: Env,
  storeRoot: string,
  adapterId: string,
): Promise<CellarerConfig> {
  const builtinAdapterIds = await loadBuiltinAdapterIds(env);
  if (builtinAdapterIds.has(adapterId)) {
    throw new Error(`cannot delete built-in adapter "${adapterId}"`);
  }
  const config = await loadConfig(env, storeRoot);
  const adapters = { ...config.adapters };
  delete adapters[adapterId];
  const next = { ...config, adapters };
  await saveConfig(env, storeRoot, next);
  return next;
}
