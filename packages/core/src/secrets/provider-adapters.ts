import type { CurrentUserOnlyPermissions, FsLike, Platform, SecretStore } from "../env.js";
import { listManagedKeychainSecretNames } from "./keychain-metadata.js";
import { deleteKeychainSecret, getKeychainSecret, setKeychainSecret } from "./keychain-provider.js";
import type {
  KeychainDeletePort,
  KeychainGetPort,
  KeychainListPort,
  KeychainSetPort,
  VaultPublicationPort,
  VaultReadPort,
  VaultWritePort,
} from "./provider-ports.js";
import {
  assertVaultMutationSupported,
  assertVaultSecurity,
  encryptVault,
  loadVault,
  vaultPath,
} from "./vault.js";

type VaultReadFs = Pick<FsLike, "lstat" | "readFile">;

type KeychainListFs = Pick<
  FsLike,
  | "lstat"
  | "readdir"
  | "snapshotFileNoFollow"
  | "snapshotTreeNoFollow"
  | "supportsSafeRecursiveSnapshots"
>;

export interface VaultReadAdapterInput {
  readonly fs: VaultReadFs;
  readonly platform: Platform;
  readonly currentUserOnlyPermissions?: Pick<CurrentUserOnlyPermissions, "supported" | "verify">;
}

export interface KeychainGetAdapterInput {
  readonly secretStore?: Pick<SecretStore, "get">;
}

export interface KeychainListAdapterInput {
  readonly fs: KeychainListFs;
}

export interface VaultWriteAdapterInput {
  readonly fs: Pick<FsLike, "lstat" | "readFile">;
  readonly platform: Platform;
  readonly currentUserOnlyPermissions?: CurrentUserOnlyPermissions;
}

export interface KeychainSetAdapterInput {
  readonly secretStore?: Pick<SecretStore, "set">;
}

export interface KeychainDeleteAdapterInput {
  readonly secretStore?: Pick<SecretStore, "delete">;
}

export function createVaultReadPort(input: VaultReadAdapterInput): VaultReadPort {
  return {
    loadVault: (storeRoot, passphrase) => loadVault(input, storeRoot, passphrase),
  };
}

export function createVaultWritePort(input: VaultWriteAdapterInput): VaultWritePort {
  return {
    ...createVaultPublicationPort(),
    assertVaultMutationSupported: (path) => assertVaultMutationSupported(input, path),
    assertVaultSecurity: (path) => assertVaultSecurity(input, path),
  };
}

export function createVaultPublicationPort(): VaultPublicationPort {
  return { vaultPath, encryptVault };
}

export function createKeychainGetPort(input: KeychainGetAdapterInput): KeychainGetPort {
  return {
    keychainAvailable: () => input.secretStore !== undefined,
    getKeychain: (service, account) =>
      getKeychainSecret(requireKeychainGet(input), service, account),
  };
}

export function createKeychainListPort(input: KeychainListAdapterInput): KeychainListPort {
  return {
    listManagedKeychainNames: (storeRoot, service) =>
      listManagedKeychainSecretNames(input, storeRoot, service),
  };
}

export function createKeychainSetPort(input: KeychainSetAdapterInput): KeychainSetPort {
  return {
    setKeychain: (service, account, value) =>
      setKeychainSecret(requireKeychainSet(input), service, account, value),
  };
}

export function createKeychainDeletePort(input: KeychainDeleteAdapterInput): KeychainDeletePort {
  return {
    deleteKeychain: (service, account) =>
      deleteKeychainSecret(requireKeychainDelete(input), service, account),
  };
}

function requireKeychainGet(input: KeychainGetAdapterInput) {
  if (!input.secretStore) throw new Error("keychain unavailable (no SecretStore injected)");
  return input.secretStore;
}

function requireKeychainSet(input: KeychainSetAdapterInput) {
  if (!input.secretStore) throw new Error("keychain unavailable (no SecretStore injected)");
  return input.secretStore;
}

function requireKeychainDelete(input: KeychainDeleteAdapterInput) {
  if (!input.secretStore) throw new Error("keychain unavailable (no SecretStore injected)");
  return input.secretStore;
}
