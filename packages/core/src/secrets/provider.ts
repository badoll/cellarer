import type { Env, MutationAuthorityLease } from "../env.js";
import type { SecretReferenceFinding } from "../model/index.js";
import { withCurrentMutationAuthorityLease } from "../protocol/canonical.js";
import { readOperationJournal } from "../protocol/journal.js";
import type { OperationResult } from "../protocol/models.js";
import {
  providerScopeForEnv,
  resolveActiveSecretValues,
  type SecretObservationUseCaseInput,
  type VaultReadSecretObservationInput,
} from "./active-values.js";
import { assertOrdinarySecretCredentialTarget } from "./authority-namespace.js";
import type { KeychainGetPort, StoredSecretProvider } from "./provider-ports.js";
import {
  cellarerSecretReference,
  type SecretReference,
  secretReferenceToken,
} from "./reference.js";
import type { SecretSources } from "./resolver.js";

export type { StoredSecretProvider } from "./provider-ports.js";

export interface ListStoredSecretNamesOptions {
  readonly provider: "vault";
  readonly vaultPassphrase: string;
}

export async function listStoredSecretNamesWithPort(
  input: VaultReadSecretObservationInput,
  storeRoot: string,
  options: ListStoredSecretNamesOptions,
): Promise<string[]> {
  const passphrase = requireVaultPassphrase(options.vaultPassphrase);
  const vault = await input.observation.loadVault(storeRoot, passphrase);
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

export async function verifySecretReferencesWithPort(
  input: SecretObservationUseCaseInput,
  storeRoot: string,
  references: readonly SecretReference[],
  sources: SecretSources,
): Promise<SecretReferenceVerification[]> {
  const scope = providerScopeForEnv(input.scopeCarrier);
  if (
    scope?.mode === sources.mode &&
    (sources.mode !== "keychain" || scope.service === (sources.keychainService ?? "cellarer"))
  ) {
    await resolveActiveSecretValues(input, storeRoot, references, {
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
      const value = input.environment[reference.name];
      results.push({
        reference: secretReferenceToken(reference),
        provider: "environment",
        status: value === undefined || value.length === 0 ? "missing" : "available",
      });
      continue;
    }

    if (sources.mode === "keychain") {
      if (input.useCase !== "keychain-get" && input.useCase !== "keychain-inventory") {
        throw new TypeError("keychain reference verification requires a keychain get port");
      }
      assertOrdinarySecretCredentialTarget(sources.keychainService ?? "cellarer", reference.name);
      const status = await keychainReferenceStatus(
        input.observation,
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
        if (input.useCase !== "vault-read") {
          throw new TypeError("vault reference verification requires a vault read port");
        }
        try {
          vaultData = await input.observation.loadVault(storeRoot, sources.vaultPassphrase);
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

export async function diagnoseKeychainMutationRecoveryWithPort(
  env: Env,
  storeRoot: string,
  operationId: string,
  observation: KeychainGetPort,
): Promise<KeychainMutationRecoveryDiagnosis> {
  return withCurrentMutationAuthorityLease(env, (authorityLease) =>
    diagnoseKeychainMutationRecoveryWithAuthorityLease(
      env,
      storeRoot,
      operationId,
      authorityLease,
      observation,
    ),
  );
}

async function diagnoseKeychainMutationRecoveryWithAuthorityLease(
  env: Env,
  storeRoot: string,
  operationId: string,
  authorityLease: MutationAuthorityLease,
  observation: KeychainGetPort,
): Promise<KeychainMutationRecoveryDiagnosis> {
  if (!(await authorityLease.isCurrent().catch(() => false))) {
    throw new TypeError("mutation authority is not current");
  }
  const context = await keychainRecoveryContext(env, storeRoot, operationId);
  const reference = secretReferenceToken(cellarerSecretReference(context.name));
  const providerStatus = await diagnosedKeychainStatus(observation, context.service, context.name);
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
  observation: KeychainGetPort,
  service: string,
  name: string,
): Promise<"present" | "missing" | "unavailable"> {
  if (!observation.keychainAvailable()) return "unavailable";
  try {
    return (await observation.getKeychain(service, name)).found ? "present" : "missing";
  } catch {
    return "unavailable";
  }
}

function requireVaultPassphrase(passphrase: string | undefined): string {
  if (!passphrase) throw new TypeError("vault passphrase is required for vault secret mutation");
  return passphrase;
}

async function keychainReferenceStatus(
  observation: KeychainGetPort,
  service: string,
  name: string,
): Promise<SecretReferenceVerificationStatus> {
  if (!observation.keychainAvailable()) return "unavailable";
  try {
    const result = await observation.getKeychain(service, name);
    return result.found ? "available" : "missing";
  } catch {
    return "unavailable";
  }
}
