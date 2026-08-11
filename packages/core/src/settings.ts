import type { Env } from "./env.js";
import type {
  AssertExact,
  ExactContract,
  SettingsCollection,
  SettingsSummary,
} from "./protocol/client-types.js";
import { loadConfig, packagedConfigText, parsePackagedConfigForSettings } from "./store/config.js";
import { collectLedgerSecretRefStats, loadLedger } from "./store/ledger.js";
import { resolveStoreRoot } from "./store/store.js";

export interface SettingsSummaryOptions {
  storeRoot: string;
}

export type { SettingsCollection, SettingsSummary } from "./protocol/client-types.js";

async function settingsSummaryImplementation(env: Env, opts: SettingsSummaryOptions) {
  const [config, packaged, ledger] = await Promise.all([
    loadConfig(env, opts.storeRoot),
    packagedConfigText(env).then(parsePackagedConfigForSettings),
    loadLedger(env, opts.storeRoot),
  ]);
  const builtinAdapterIds = Object.keys(packaged.builtinAdapters);
  const customAdapterIds = Object.keys(config.customAdapters);
  const collections = Object.entries(config.collections).map(([name, value]) =>
    settingsCollection(name, value.description),
  );
  return {
    storeRoot: opts.storeRoot,
    cellarerHomeActive: resolveStoreRoot(env) === opts.storeRoot && !!env.env.CELLARER_HOME,
    defaults: config.defaults,
    collections,
    builtinAdapterIds,
    customAdapterIds,
    secretRefs: collectLedgerSecretRefStats(ledger),
  } satisfies SettingsSummary;
}

export async function settingsSummary(
  env: Env,
  opts: SettingsSummaryOptions,
): Promise<SettingsSummary> {
  return settingsSummaryImplementation(env, opts);
}

export type SettingsSummaryProducerContract = AssertExact<
  ExactContract<Awaited<ReturnType<typeof settingsSummaryImplementation>>, SettingsSummary>
>;

function settingsCollection(name: string, description: string | undefined) {
  const optionalDescription: { description?: string } = { description };
  return { name, ...optionalDescription };
}

export type SettingsCollectionProducerContract = AssertExact<
  ExactContract<ReturnType<typeof settingsCollection>, SettingsCollection>
>;
