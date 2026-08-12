import type { Env } from "../env.js";
import {
  createKeychainDeletePort,
  createKeychainSetPort,
  createVaultPublicationPort,
  createVaultReadPort,
  createVaultWritePort,
} from "./provider-adapters.js";
import type {
  KeychainDeletePort,
  KeychainSetPort,
  VaultData,
  VaultWritePort,
} from "./provider-ports.js";
import {
  type DeleteStoredSecretOptions,
  deleteKeychainStoredSecretWithPort,
  deleteVaultStoredSecretWithPorts,
  type SetStoredSecretOptions,
  type StoredSecretMutationResult,
  saveVaultWithPorts,
  setKeychainStoredSecretWithPort,
  setVaultStoredSecretWithPorts,
  type VaultSecretMutationPorts,
} from "./secret-metadata.js";

export type {
  DeleteStoredSecretOptions,
  SetStoredSecretOptions,
  StoredSecretMutationResult,
} from "./secret-metadata.js";

export function saveVault(
  env: Env,
  storeRoot: string,
  data: VaultData,
  passphrase: string,
): Promise<void> {
  return saveVaultWithPorts(
    env,
    storeRoot,
    data,
    passphrase,
    secretMetadataCapabilitiesFor(env, "vault-write"),
  );
}

export function setStoredSecret(
  env: Env,
  storeRoot: string,
  options: SetStoredSecretOptions,
): Promise<StoredSecretMutationResult> {
  return options.provider === "vault"
    ? setVaultStoredSecretWithPorts(
        env,
        storeRoot,
        { ...options, provider: "vault" },
        secretMetadataCapabilitiesFor(env, "vault-set"),
      )
    : setKeychainStoredSecretWithPort(
        env,
        storeRoot,
        { ...options, provider: "keychain" },
        secretMetadataCapabilitiesFor(env, "keychain-set"),
      );
}

export function deleteStoredSecret(
  env: Env,
  storeRoot: string,
  options: DeleteStoredSecretOptions,
): Promise<StoredSecretMutationResult> {
  return options.provider === "vault"
    ? deleteVaultStoredSecretWithPorts(
        env,
        storeRoot,
        { ...options, provider: "vault" },
        secretMetadataCapabilitiesFor(env, "vault-delete"),
      )
    : deleteKeychainStoredSecretWithPort(
        env,
        storeRoot,
        { ...options, provider: "keychain" },
        secretMetadataCapabilitiesFor(env, "keychain-delete"),
      );
}

export type SecretMetadataUseCase =
  | "vault-write"
  | "vault-set"
  | "vault-delete"
  | "keychain-set"
  | "keychain-delete";

export function secretMetadataCapabilitiesFor(env: Env, useCase: "vault-write"): VaultWritePort;
export function secretMetadataCapabilitiesFor(
  env: Env,
  useCase: "vault-set" | "vault-delete",
): VaultSecretMutationPorts;
export function secretMetadataCapabilitiesFor(env: Env, useCase: "keychain-set"): KeychainSetPort;
export function secretMetadataCapabilitiesFor(
  env: Env,
  useCase: "keychain-delete",
): KeychainDeletePort;
export function secretMetadataCapabilitiesFor(
  env: Env,
  useCase: SecretMetadataUseCase,
): VaultWritePort | VaultSecretMutationPorts | KeychainSetPort | KeychainDeletePort {
  switch (useCase) {
    case "vault-write":
      return createVaultWritePort(env);
    case "vault-set":
    case "vault-delete":
      return { ...createVaultReadPort(env), ...createVaultPublicationPort() };
    case "keychain-set":
      return createKeychainSetPort(env);
    case "keychain-delete":
      return createKeychainDeletePort(env);
  }
}
