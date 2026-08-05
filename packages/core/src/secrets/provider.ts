import type { Env, MutationAuthorityLease, SecretStore } from "../env.js";
import { assertSafeAtomicPublicationPath } from "../fs/safety.js";
import type { SecretReferenceFinding } from "../model/index.js";
import { withCurrentMutationAuthorityLease } from "../protocol/canonical.js";
import { readOperationJournal } from "../protocol/journal.js";
import type { OperationResult } from "../protocol/models.js";
import { executeStoreActionMutation } from "../protocol/store-mutation.js";
import { sha256 } from "../store/checksum.js";
import { providerScopeForEnv, resolveActiveSecretValues } from "./active-values.js";
import { assertOrdinarySecretCredentialTarget } from "./authority-namespace.js";
import {
  keychainMetadataPath,
  serializeKeychainMetadata,
  serializeKeychainMutationIntent,
} from "./keychain-metadata.js";
import { deleteKeychainSecret, getKeychainSecret, setKeychainSecret } from "./keychain-provider.js";
import { createSecretValue, withObservableKnownValues } from "./observable.js";
import {
  cellarerSecretReference,
  type SecretReference,
  secretReferenceToken,
} from "./reference.js";
import type { SecretSources } from "./resolver.js";
import { encryptVault, loadVault, vaultPath } from "./vault.js";

export type StoredSecretProvider = "vault" | "keychain";

export interface SetStoredSecretOptions {
  readonly provider: StoredSecretProvider;
  readonly name: string;
  readonly value: string;
  readonly vaultPassphrase?: string;
  readonly keychainService?: string;
}

export interface DeleteStoredSecretOptions {
  readonly provider: StoredSecretProvider;
  readonly name: string;
  readonly vaultPassphrase?: string;
  readonly keychainService?: string;
}

export interface StoredSecretMutationResult {
  readonly provider: StoredSecretProvider;
  readonly name: string;
  readonly operation: OperationResult;
}

export interface ListStoredSecretNamesOptions {
  readonly provider: "vault";
  readonly vaultPassphrase: string;
}

export async function listStoredSecretNames(
  env: Env,
  storeRoot: string,
  options: ListStoredSecretNamesOptions,
): Promise<string[]> {
  const passphrase = requireVaultPassphrase(options.vaultPassphrase);
  const vault = await loadVault(env, storeRoot, passphrase);
  return Object.keys(vault).sort((left, right) => left.localeCompare(right));
}

export type SecretReferenceVerificationStatus = "available" | "missing" | "unavailable";

export interface SecretReferenceVerification {
  readonly reference: string;
  readonly provider: "environment" | StoredSecretProvider;
  readonly status: SecretReferenceVerificationStatus;
}

export interface KeychainMutationRecoveryDiagnosis {
  readonly status: "manual-recovery-required";
  readonly provider: "keychain";
  readonly mutation: "set" | "delete";
  readonly reference: string;
  readonly providerStatus: "present" | "missing" | "unavailable";
  readonly supportedResolution: "rollback-new-entry" | null;
  readonly steps: readonly string[];
}

export interface ReconcileKeychainMutationRecoveryOptions {
  readonly operationId: string;
  readonly resolution: "rollback-new-entry";
}

export function missingSecretReferences(
  results: readonly SecretReferenceVerification[],
): SecretReferenceFinding[] {
  return results.flatMap((result) =>
    result.status === "available"
      ? []
      : [
          {
            reference: result.reference,
            provider: result.provider,
            status: result.status,
          },
        ],
  );
}

export async function setStoredSecret(
  env: Env,
  storeRoot: string,
  options: SetStoredSecretOptions,
): Promise<StoredSecretMutationResult> {
  const name = validateStoredSecretName(options.name);
  const protectedValue = createSecretValue(options.value);
  const operationEnv = withObservableKnownValues(env, [protectedValue]);
  if (options.provider === "vault") {
    const passphrase = requireVaultPassphrase(options.vaultPassphrase);
    const result = await executeStoreActionMutation(
      operationEnv,
      storeRoot,
      "secret-metadata",
      "vault-secret-set",
      async () => {
        const current = await loadVault(operationEnv, storeRoot, passphrase);
        const next = protectedValue.use((plaintext) => ({ ...current, [name]: plaintext }));
        return {
          value: undefined,
          actions: [],
          publications: [
            {
              path: vaultPath(storeRoot),
              data: await encryptVault(next, passphrase),
              mode: 0o600,
              currentUserOnly: true,
            },
          ],
        };
      },
    );
    return { provider: "vault", name, operation: result.operation };
  }

  const service = options.keychainService ?? "cellarer";
  assertOrdinarySecretCredentialTarget(service, name);
  const secretStore = requireKeychain(env);
  const metadata = serializeKeychainMetadata(service, name, true);
  const intent = serializeKeychainMutationIntent(service, name, "set");
  const target = keychainMetadataPath(storeRoot, service, name);
  const result = await executeStoreActionMutation(
    operationEnv,
    storeRoot,
    "secret-metadata",
    "keychain-secret-set",
    async () => ({
      value: undefined,
      actions: [
        {
          actionId: keychainActionId("set", service, name),
          kind: "keychain-secret-set",
          target,
          payload: { provider: "keychain", service, name },
          postcondition: { state: "present", fingerprint: sha256(metadata) },
          execute: async () => {
            await assertSafeAtomicPublicationPath(
              operationEnv,
              target,
              storeRoot,
              "keychain metadata",
            );
            await operationEnv.fs.publishFileAtomically(target, intent, { mode: 0o600 });
            await setKeychainSecret(secretStore, service, name, protectedValue);
            await operationEnv.fs.publishFileAtomically(target, metadata, { mode: 0o600 });
          },
        },
      ],
    }),
  );
  return { provider: "keychain", name, operation: result.operation };
}

export async function deleteStoredSecret(
  env: Env,
  storeRoot: string,
  options: DeleteStoredSecretOptions,
): Promise<StoredSecretMutationResult> {
  const name = validateStoredSecretName(options.name);
  if (options.provider === "vault") {
    const passphrase = requireVaultPassphrase(options.vaultPassphrase);
    const result = await executeStoreActionMutation(
      env,
      storeRoot,
      "secret-metadata",
      "vault-secret-delete",
      async () => {
        const current = await loadVault(env, storeRoot, passphrase);
        const next = { ...current };
        delete next[name];
        return {
          value: undefined,
          actions: [],
          publications: [
            {
              path: vaultPath(storeRoot),
              data: await encryptVault(next, passphrase),
              mode: 0o600,
              currentUserOnly: true,
            },
          ],
        };
      },
    );
    return { provider: "vault", name, operation: result.operation };
  }

  const service = options.keychainService ?? "cellarer";
  assertOrdinarySecretCredentialTarget(service, name);
  const secretStore = requireKeychain(env);
  const metadata = serializeKeychainMetadata(service, name, false);
  const intent = serializeKeychainMutationIntent(service, name, "delete");
  const target = keychainMetadataPath(storeRoot, service, name);
  const result = await executeStoreActionMutation(
    env,
    storeRoot,
    "secret-metadata",
    "keychain-secret-delete",
    async () => ({
      value: undefined,
      actions: [
        {
          actionId: keychainActionId("delete", service, name),
          kind: "keychain-secret-delete",
          target,
          payload: { provider: "keychain", service, name },
          postcondition: { state: "present", fingerprint: sha256(metadata) },
          execute: async () => {
            await assertSafeAtomicPublicationPath(env, target, storeRoot, "keychain metadata");
            await env.fs.publishFileAtomically(target, intent, { mode: 0o600 });
            await deleteKeychainSecret(secretStore, service, name);
            await env.fs.publishFileAtomically(target, metadata, { mode: 0o600 });
          },
        },
      ],
    }),
  );
  return { provider: "keychain", name, operation: result.operation };
}

export async function verifySecretReferences(
  env: Env,
  storeRoot: string,
  references: readonly SecretReference[],
  sources: SecretSources,
): Promise<SecretReferenceVerification[]> {
  const scope = providerScopeForEnv(env);
  if (
    scope?.mode === sources.mode &&
    (sources.mode !== "keychain" || scope.service === (sources.keychainService ?? "cellarer"))
  ) {
    await resolveActiveSecretValues(env, storeRoot, references, {
      secretMode: sources.mode,
      vaultPassphrase: sources.vaultPassphrase,
      keychainService: sources.keychainService,
    });
    return references.map((reference) => ({
      reference: secretReferenceToken(reference),
      provider:
        reference.kind === "environment"
          ? "environment"
          : sources.mode === "keychain"
            ? "keychain"
            : "vault",
      status: scope.availability.get(secretReferenceToken(reference)) ?? "unavailable",
    }));
  }
  let vaultData: Record<string, string> | undefined;
  let vaultUnavailable = false;
  const results: SecretReferenceVerification[] = [];
  for (const reference of references) {
    if (reference.kind === "environment") {
      const value = env.env[reference.name];
      results.push({
        reference: secretReferenceToken(reference),
        provider: "environment",
        status: value === undefined || value.length === 0 ? "missing" : "available",
      });
      continue;
    }

    if (sources.mode === "keychain") {
      assertOrdinarySecretCredentialTarget(sources.keychainService ?? "cellarer", reference.name);
      const status = await keychainReferenceStatus(
        env.secretStore,
        sources.keychainService ?? "cellarer",
        reference.name,
      );
      results.push({
        reference: secretReferenceToken(reference),
        provider: "keychain",
        status,
      });
      continue;
    }

    if (!vaultData && !vaultUnavailable) {
      if (sources.vaultPassphrase) {
        try {
          vaultData = await loadVault(env, storeRoot, sources.vaultPassphrase);
        } catch {
          vaultUnavailable = true;
        }
      } else vaultUnavailable = true;
    }
    results.push({
      reference: secretReferenceToken(reference),
      provider: "vault",
      status: vaultUnavailable
        ? "unavailable"
        : vaultData?.[reference.name] === undefined
          ? "missing"
          : "available",
    });
  }
  return results;
}

export async function diagnoseKeychainMutationRecovery(
  env: Env,
  storeRoot: string,
  operationId: string,
): Promise<KeychainMutationRecoveryDiagnosis> {
  return withCurrentMutationAuthorityLease(env, (authorityLease) =>
    diagnoseKeychainMutationRecoveryWithAuthorityLease(env, storeRoot, operationId, authorityLease),
  );
}

async function diagnoseKeychainMutationRecoveryWithAuthorityLease(
  env: Env,
  storeRoot: string,
  operationId: string,
  authorityLease: MutationAuthorityLease,
): Promise<KeychainMutationRecoveryDiagnosis> {
  if (!(await authorityLease.isCurrent().catch(() => false))) {
    throw new TypeError("mutation authority is not current");
  }
  const context = await keychainRecoveryContext(env, storeRoot, operationId);
  const reference = secretReferenceToken(cellarerSecretReference(context.name));
  const providerStatus = await diagnosedKeychainStatus(
    env.secretStore,
    context.service,
    context.name,
  );
  const supportedResolution = null;
  const steps = [
    `Inspect ${context.service}/${context.name} with the operating-system credential manager.`,
    "Restore the provider entry and cellarer metadata to the recorded before-state without copying a value into protocol evidence.",
    `Re-run diagnoseKeychainMutationRecovery for operation ${operationId}.`,
  ];
  return {
    status: "manual-recovery-required",
    provider: "keychain",
    mutation: context.mutation,
    reference,
    providerStatus,
    supportedResolution,
    steps,
  };
}

export async function reconcileKeychainMutationRecovery(
  env: Env,
  storeRoot: string,
  options: ReconcileKeychainMutationRecoveryOptions,
): Promise<OperationResult> {
  return withCurrentMutationAuthorityLease(env, async (authorityLease) => {
    if (!(await authorityLease.isCurrent().catch(() => false))) {
      throw new TypeError("mutation authority is not current");
    }
    await keychainRecoveryContext(env, storeRoot, options.operationId);
    throw new Error(
      "keychain recovery requires provider-specific manual reconciliation; automatic provider rollback is unsupported",
    );
  });
}

interface KeychainRecoveryContext {
  readonly target: string;
  readonly service: string;
  readonly name: string;
  readonly mutation: "set" | "delete";
  readonly beforeState: "absent" | "present";
}

async function keychainRecoveryContext(
  env: Env,
  storeRoot: string,
  operationId: string,
): Promise<KeychainRecoveryContext> {
  const journal = await readOperationJournal(env, storeRoot);
  if (!journal || journal.operationId !== operationId) {
    throw new Error("keychain recovery operation does not match the active journal");
  }
  // Keychain recovery currently has no journal-external durable authority that proves the
  // originating provider identity. A self-consistent journal is integrity evidence only, so do
  // not derive a provider lookup or reconciliation target from it.
  throw new Error("keychain recovery journal is not authorized");
}

async function diagnosedKeychainStatus(
  store: SecretStore | undefined,
  service: string,
  name: string,
): Promise<"present" | "missing" | "unavailable"> {
  if (!store) return "unavailable";
  try {
    return (await getKeychainSecret(store, service, name)).found ? "present" : "missing";
  } catch {
    return "unavailable";
  }
}

function validateStoredSecretName(name: string): string {
  return cellarerSecretReference(name).name;
}

function requireVaultPassphrase(passphrase: string | undefined): string {
  if (!passphrase) throw new TypeError("vault passphrase is required for vault secret mutation");
  return passphrase;
}

function requireKeychain(env: Env): SecretStore {
  if (!env.secretStore) throw new Error("keychain unavailable (no SecretStore injected)");
  return env.secretStore;
}

async function keychainReferenceStatus(
  secretStore: SecretStore | undefined,
  service: string,
  name: string,
): Promise<SecretReferenceVerificationStatus> {
  if (!secretStore) return "unavailable";
  try {
    const result = await getKeychainSecret(secretStore, service, name);
    return result.found ? "available" : "missing";
  } catch {
    return "unavailable";
  }
}

function keychainActionId(operation: "set" | "delete", service: string, name: string): string {
  return sha256(JSON.stringify({ kind: `keychain-secret-${operation}`, service, name }));
}
