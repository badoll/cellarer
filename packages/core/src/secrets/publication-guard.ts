import { loadConfigFromReadContext } from "../store/config.js";
import { createProviderScope, providerScopeForEnv, withProviderScope } from "./active-values.js";
import type { StorePublicationSecretGuard } from "./provider-ports.js";
import { inventoryStorePublicationSecretValues } from "./provider-runtime.js";

export const activeSecretPublicationGuard: StorePublicationSecretGuard = {
  async prepare(context, storeRoot) {
    const existing = providerScopeForEnv(context);
    const config = existing ? undefined : await loadConfigFromReadContext(context, storeRoot);
    const scope =
      existing ??
      createProviderScope({
        secretMode: config?.defaults.secretMode ?? "env",
      });
    const operationEnv = existing ? context : withProviderScope(context, scope);
    await inventoryStorePublicationSecretValues(operationEnv, storeRoot, {
      secretMode: scope.mode,
      keychainService: scope.service,
      requireAvailable: true,
    });
    return { env: operationEnv, knownValues: scope.knownValues };
  },
};
