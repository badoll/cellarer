import type { SecretStore } from "../env.js";
import { assertOrdinarySecretCredentialTarget } from "./authority-namespace.js";
import { createSecretValue, type SecretValue } from "./observable.js";

export type KeychainProviderOperation = "get" | "set" | "delete";

export class KeychainProviderError extends Error {
  readonly code = "SECRET_PROVIDER_ERROR" as const;

  constructor(readonly operation: KeychainProviderOperation) {
    super(`keychain provider ${operation} failed`);
    this.name = "KeychainProviderError";
  }
}

export async function getKeychainSecret(
  store: SecretStore,
  service: string,
  account: string,
): Promise<{ found: false } | { found: true; value: SecretValue }> {
  assertOrdinarySecretCredentialTarget(service, account);
  try {
    const result = await store.get(service, account);
    if ("error" in result) throw new KeychainProviderError("get");
    return result.found ? { found: true, value: createSecretValue(result.value) } : result;
  } catch (error) {
    if (error instanceof KeychainProviderError) throw error;
    throw new KeychainProviderError("get");
  }
}

export async function setKeychainSecret(
  store: SecretStore,
  service: string,
  account: string,
  value: SecretValue,
): Promise<void> {
  assertOrdinarySecretCredentialTarget(service, account);
  try {
    await value.use((plaintext) => store.set(service, account, plaintext));
  } catch {
    throw new KeychainProviderError("set");
  }
}

export async function deleteKeychainSecret(
  store: SecretStore,
  service: string,
  account: string,
): Promise<boolean> {
  assertOrdinarySecretCredentialTarget(service, account);
  try {
    return await store.delete(service, account);
  } catch {
    throw new KeychainProviderError("delete");
  }
}
