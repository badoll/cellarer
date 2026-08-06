import type { Env } from "./env.js";
import type { CellarerConfig } from "./store/config.js";
import { loadConfig, packagedConfigText, parsePackagedConfigForSettings } from "./store/config.js";
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
  const customAdapterIds = Object.keys(config.customAdapters);
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
