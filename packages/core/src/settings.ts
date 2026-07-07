import type { Env } from "./env.js";
import type { LinkMethod } from "./model/index.js";
import type { SecretMode } from "./secrets/resolver.js";
import {
  type AdapterPatchConfig,
  type CellarerConfig,
  loadConfig,
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
  const next = { ...config, adapters: { ...config.adapters, [adapterId]: adapter } };
  await saveConfig(env, storeRoot, next);
  return next;
}

export async function deleteCustomAdapterConfig(
  env: Env,
  storeRoot: string,
  adapterId: string,
): Promise<CellarerConfig> {
  const packaged = parsePackagedConfigForSettings(await packagedConfigText(env));
  if (Object.keys(packaged.builtinAdapters).includes(adapterId)) {
    throw new Error(`cannot delete built-in adapter "${adapterId}"`);
  }
  const config = await loadConfig(env, storeRoot);
  const adapters = { ...config.adapters };
  delete adapters[adapterId];
  const next = { ...config, adapters };
  await saveConfig(env, storeRoot, next);
  return next;
}
