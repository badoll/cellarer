import type { Env, FsLike, SecretStore } from "../env.js";
import {
  type ActiveSecretValueOptions,
  discoverActiveSecretValues as discoverActiveSecretValuesWithPort,
  type EnvironmentOnlySecretObservationInput,
  inventoryActiveSecretValues as inventoryActiveSecretValuesWithPort,
  type KeychainGetSecretObservationInput,
  type KeychainInventorySecretObservationInput,
  providerScopeForEnv,
  resolveActiveSecretValues as resolveActiveSecretValuesWithPort,
  type SecretObservationUseCaseInput,
  type VaultReadSecretObservationInput,
  withProviderScope,
} from "./active-values.js";
import {
  diagnoseKeychainMutationRecoveryWithPort,
  type KeychainMutationRecoveryDiagnosis,
  type ListStoredSecretNamesOptions,
  listStoredSecretNamesWithPort,
  type SecretReferenceVerification,
  verifySecretReferencesWithPort,
} from "./provider.js";
import {
  createKeychainGetPort,
  createKeychainListPort,
  createVaultReadPort,
} from "./provider-adapters.js";
import type { StorePublicationSecretGuardContext } from "./provider-ports.js";
import type { SecretReference } from "./reference.js";
import {
  type ResolveOutcome,
  resolveFields as resolveFieldsWithPort,
  resolveSecretValue as resolveSecretValueWithPort,
  type SecretSources,
} from "./resolver.js";

export type {
  KeychainMutationRecoveryDiagnosis,
  ListStoredSecretNamesOptions,
  ReconcileKeychainMutationRecoveryOptions,
  SecretReferenceVerification,
  SecretReferenceVerificationStatus,
  StoredSecretProvider,
} from "./provider.js";
export {
  missingSecretReferences,
  reconcileKeychainMutationRecovery,
} from "./provider.js";
export type { ResolveOutcome, SecretSources } from "./resolver.js";

export type SecretObservationUseCase =
  | "environment-only"
  | "vault-read"
  | "keychain-get"
  | "keychain-inventory";

type EnvironmentObservationContext = Pick<Env, "env">;
type VaultObservationContext = EnvironmentObservationContext & {
  readonly fs: Pick<FsLike, "lstat" | "readFile">;
  readonly platform: Env["platform"];
  readonly currentUserOnlyPermissions?: Pick<
    NonNullable<Env["currentUserOnlyPermissions"]>,
    "supported" | "verify"
  >;
};
type KeychainGetObservationContext = EnvironmentObservationContext & {
  readonly secretStore?: Pick<SecretStore, "get">;
};
type KeychainInventoryObservationContext = KeychainGetObservationContext & {
  readonly fs: Pick<
    FsLike,
    | "lstat"
    | "readdir"
    | "snapshotFileNoFollow"
    | "snapshotTreeNoFollow"
    | "supportsSafeRecursiveSnapshots"
  >;
};
type SecretObservationCompositionContext = Pick<StorePublicationSecretGuardContext, "env"> & {
  readonly fs?: Partial<StorePublicationSecretGuardContext["fs"]>;
  readonly platform?: Env["platform"];
  readonly secretStore?: Pick<SecretStore, "get">;
  readonly currentUserOnlyPermissions?: Pick<
    NonNullable<Env["currentUserOnlyPermissions"]>,
    "supported" | "verify"
  >;
};

type SecretObservationContextForSources<Sources extends SecretSources> = Sources extends {
  readonly mode: "keychain";
}
  ? KeychainGetObservationContext
  : Sources extends { readonly vaultPassphrase: string }
    ? VaultObservationContext
    : EnvironmentObservationContext;

type SecretObservationContextForActiveOptions<
  Options extends ActiveSecretValueOptions,
  Inventory extends boolean,
> = Options extends { readonly secretMode: "keychain" }
  ? Inventory extends true
    ? KeychainInventoryObservationContext
    : KeychainGetObservationContext
  : Options extends { readonly vaultPassphrase: string }
    ? VaultObservationContext
    : EnvironmentObservationContext;

export function createSecretObservationUseCaseInput(
  env: EnvironmentObservationContext,
  useCase: "environment-only",
): EnvironmentOnlySecretObservationInput;
export function createSecretObservationUseCaseInput(
  env: VaultObservationContext,
  useCase: "vault-read",
): VaultReadSecretObservationInput;
export function createSecretObservationUseCaseInput(
  env: KeychainGetObservationContext,
  useCase: "keychain-get",
): KeychainGetSecretObservationInput;
export function createSecretObservationUseCaseInput(
  env: KeychainInventoryObservationContext,
  useCase: "keychain-inventory",
): KeychainInventorySecretObservationInput;
export function createSecretObservationUseCaseInput(
  env: SecretObservationCompositionContext,
  useCase: SecretObservationUseCase,
): SecretObservationUseCaseInput;
export function createSecretObservationUseCaseInput(
  env: SecretObservationCompositionContext,
  useCase: SecretObservationUseCase,
): SecretObservationUseCaseInput {
  const common = { environment: env.env, scopeCarrier: readOnlyScopeCarrier(env) };
  switch (useCase) {
    case "environment-only":
      return { ...common, useCase, observation: {} };
    case "vault-read": {
      if (!isVaultObservationContext(env)) {
        throw new TypeError("vault-read composition requires fs and platform");
      }
      const { fs, platform } = env;
      const observation = createVaultReadPort({
        fs: vaultReadFs(fs),
        platform,
        ...(env.currentUserOnlyPermissions
          ? {
              currentUserOnlyPermissions: {
                supported: (platform) =>
                  env.currentUserOnlyPermissions?.supported(platform) ?? false,
                verify: (path) =>
                  env.currentUserOnlyPermissions?.verify(path) ?? Promise.resolve(false),
              },
            }
          : {}),
      });
      return { ...common, useCase, observation };
    }
    case "keychain-get":
      return { ...common, useCase, observation: createKeychainGetPort(keychainGetInput(env)) };
    case "keychain-inventory": {
      if (!isKeychainInventoryObservationContext(env)) {
        throw new TypeError("keychain-inventory composition requires fs");
      }
      const { fs } = env;
      return {
        ...common,
        useCase,
        observation: {
          ...createKeychainGetPort(keychainGetInput(env)),
          ...createKeychainListPort({ fs: keychainListFs(fs) }),
        },
      };
    }
  }
}

function readOnlyScopeCarrier(env: object): object {
  const scope = providerScopeForEnv(env);
  return scope ? withProviderScope({}, scope) : {};
}

export function resolveActiveSecretValues<const Options extends ActiveSecretValueOptions>(
  env: SecretObservationContextForActiveOptions<Options, false>,
  storeRoot: string,
  references: readonly SecretReference[],
  options: Options,
) {
  return resolveActiveSecretValuesWithPort(
    createSecretObservationUseCaseInput(
      env,
      observationUseCase(options.secretMode, false, options.vaultPassphrase),
    ),
    storeRoot,
    references,
    options,
  );
}

export function inventoryActiveSecretValues<const Options extends ActiveSecretValueOptions>(
  env: SecretObservationContextForActiveOptions<Options, true>,
  storeRoot: string,
  options: Options,
) {
  return inventoryActiveSecretValuesWithPort(
    createSecretObservationUseCaseInput(
      env,
      observationUseCase(options.secretMode, true, options.vaultPassphrase),
    ),
    storeRoot,
    options,
  );
}

export function inventoryStorePublicationSecretValues(
  context: StorePublicationSecretGuardContext,
  storeRoot: string,
  options: Omit<Parameters<typeof inventoryActiveSecretValuesWithPort>[2], "vaultPassphrase">,
) {
  const input =
    options.secretMode === "keychain"
      ? createSecretObservationUseCaseInput(context, "keychain-inventory")
      : createSecretObservationUseCaseInput(context, "environment-only");
  return inventoryActiveSecretValuesWithPort(input, storeRoot, options);
}

export function discoverActiveSecretValues<const Options extends ActiveSecretValueOptions>(
  env: SecretObservationContextForActiveOptions<Options, false>,
  storeRoot: string,
  texts: readonly string[],
  options: Options,
) {
  return discoverActiveSecretValuesWithPort(
    createSecretObservationUseCaseInput(
      env,
      observationUseCase(options.secretMode, false, options.vaultPassphrase),
    ),
    storeRoot,
    texts,
    options,
  );
}

export function resolveSecretValue<const Sources extends SecretSources>(
  env: SecretObservationContextForSources<Sources>,
  storeRoot: string,
  value: string,
  sources: Sources,
): Promise<ResolveOutcome> {
  return resolveSecretValueWithPort(
    createSecretObservationUseCaseInput(
      env,
      observationUseCase(sources.mode, false, sources.vaultPassphrase),
    ),
    storeRoot,
    value,
    sources,
  );
}

export function resolveFields<const Sources extends SecretSources>(
  env: SecretObservationContextForSources<Sources>,
  storeRoot: string,
  fields: Record<string, string>,
  sources: Sources,
) {
  return resolveFieldsWithPort(
    createSecretObservationUseCaseInput(
      env,
      observationUseCase(sources.mode, false, sources.vaultPassphrase),
    ),
    storeRoot,
    fields,
    sources,
  );
}

export function listStoredSecretNames(
  env: Env,
  storeRoot: string,
  options: ListStoredSecretNamesOptions,
): Promise<string[]> {
  return listStoredSecretNamesWithPort(
    createSecretObservationUseCaseInput(env, "vault-read"),
    storeRoot,
    options,
  );
}

export function verifySecretReferences(
  env: Env,
  storeRoot: string,
  references: readonly SecretReference[],
  sources: SecretSources,
): Promise<SecretReferenceVerification[]> {
  return verifySecretReferencesWithPort(
    createSecretObservationUseCaseInput(
      env,
      observationUseCase(sources.mode, false, sources.vaultPassphrase),
    ),
    storeRoot,
    references,
    sources,
  );
}

export function diagnoseKeychainMutationRecovery(
  env: Env,
  storeRoot: string,
  operationId: string,
): Promise<KeychainMutationRecoveryDiagnosis> {
  const input = createSecretObservationUseCaseInput(env, "keychain-get");
  return diagnoseKeychainMutationRecoveryWithPort(env, storeRoot, operationId, input.observation);
}

function observationUseCase(
  mode: SecretSources["mode"],
  inventory: boolean,
  vaultPassphrase: string | undefined,
): SecretObservationUseCase {
  if (mode === "keychain") return inventory ? "keychain-inventory" : "keychain-get";
  return vaultPassphrase ? "vault-read" : "environment-only";
}

function keychainGetInput(env: { readonly secretStore?: Pick<SecretStore, "get"> }) {
  const secretStore = env.secretStore;
  return secretStore
    ? {
        secretStore: {
          get: (service: string, account: string) => secretStore.get(service, account),
        },
      }
    : {};
}

function isVaultObservationContext(
  env: SecretObservationCompositionContext,
): env is VaultObservationContext {
  return (
    typeof env.platform === "string" &&
    typeof env.fs?.lstat === "function" &&
    typeof env.fs.readFile === "function"
  );
}

function isKeychainInventoryObservationContext(
  env: SecretObservationCompositionContext,
): env is KeychainInventoryObservationContext {
  return (
    typeof env.fs?.lstat === "function" &&
    typeof env.fs.readdir === "function" &&
    typeof env.fs.snapshotFileNoFollow === "function" &&
    typeof env.fs.snapshotTreeNoFollow === "function" &&
    typeof env.fs.supportsSafeRecursiveSnapshots === "function"
  );
}

function vaultReadFs(fs: Pick<FsLike, "lstat" | "readFile">): Pick<FsLike, "lstat" | "readFile"> {
  return {
    lstat: (path) => fs.lstat(path),
    readFile: (path) => fs.readFile(path),
  };
}

function keychainListFs(
  fs: Pick<
    FsLike,
    | "lstat"
    | "readdir"
    | "snapshotFileNoFollow"
    | "snapshotTreeNoFollow"
    | "supportsSafeRecursiveSnapshots"
  >,
): Pick<
  FsLike,
  | "lstat"
  | "readdir"
  | "snapshotFileNoFollow"
  | "snapshotTreeNoFollow"
  | "supportsSafeRecursiveSnapshots"
> {
  return {
    lstat: (path) => fs.lstat(path),
    readdir: (path) => fs.readdir(path),
    snapshotFileNoFollow: (path) => fs.snapshotFileNoFollow(path),
    snapshotTreeNoFollow: (path) => fs.snapshotTreeNoFollow(path),
    supportsSafeRecursiveSnapshots: () => fs.supportsSafeRecursiveSnapshots(),
  };
}
