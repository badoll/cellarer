import type { FsLike, SecretStore } from "../env.js";
import type { SecretValue } from "./observable.js";

export type StoredSecretProvider = "vault" | "keychain";
export type VaultData = Record<string, string>;

export interface VaultReadPort {
  loadVault(storeRoot: string, passphrase: string): Promise<VaultData>;
}

export interface VaultPublicationPort {
  vaultPath(storeRoot: string): string;
  encryptVault(data: VaultData, passphrase: string): Promise<string>;
}

export interface VaultWritePort extends VaultPublicationPort {
  assertVaultMutationSupported(path: string): void;
  assertVaultSecurity(path: string): Promise<void>;
}

export interface KeychainGetPort {
  keychainAvailable(): boolean;
  getKeychain(
    service: string,
    account: string,
  ): Promise<{ found: false } | { found: true; value: SecretValue }>;
}

export interface KeychainListPort {
  listManagedKeychainNames(storeRoot: string, service: string): Promise<string[]>;
}

export interface KeychainSetPort {
  setKeychain(service: string, account: string, value: SecretValue): Promise<void>;
}

export interface KeychainDeletePort {
  deleteKeychain(service: string, account: string): Promise<boolean>;
}

export type StorePublicationSecretGuardFs = Pick<
  FsLike,
  | "lstat"
  | "readFile"
  | "readdir"
  | "snapshotFileNoFollow"
  | "snapshotTreeNoFollow"
  | "supportsSafeRecursiveSnapshots"
>;

export interface StorePublicationSecretGuardContext {
  readonly fs: StorePublicationSecretGuardFs;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly secretStore?: Pick<SecretStore, "get">;
}

export interface StorePublicationSecretGuard {
  prepare<Context extends StorePublicationSecretGuardContext>(
    context: Context,
    storeRoot: string,
  ): Promise<{ readonly env: Context; readonly knownValues: readonly SecretValue[] }>;
}
