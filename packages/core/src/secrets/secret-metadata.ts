import type { Env } from "../env.js";
import { assertSafeAtomicPublicationPath } from "../fs/safety.js";
import type { OperationResult } from "../protocol/models.js";
import {
  executeStoreActionMutation,
  executeStorePublicationMutation,
  unwrapStorePublicationMutation,
} from "../protocol/store-mutation.js";
import { sha256 } from "../store/checksum.js";
import {
  keychainMetadataPath,
  serializeKeychainMetadata,
  serializeKeychainMutationIntent,
} from "./keychain-metadata.js";
import { createSecretValue, withObservableKnownValues } from "./observable.js";
import type {
  KeychainDeletePort,
  KeychainSetPort,
  StoredSecretProvider,
  VaultData,
  VaultPublicationPort,
  VaultReadPort,
  VaultWritePort,
} from "./provider-ports.js";
import { cellarerSecretReference } from "./reference.js";

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

export type VaultSecretMutationPorts = VaultReadPort & VaultPublicationPort;

export async function saveVaultWithPorts(
  env: Env,
  storeRoot: string,
  data: VaultData,
  passphrase: string,
  port: VaultWritePort,
): Promise<void> {
  const result = await executeStorePublicationMutation(
    env,
    storeRoot,
    "secret-metadata",
    "vault-update",
    async () => {
      const path = port.vaultPath(storeRoot);
      port.assertVaultMutationSupported(path);
      await port.assertVaultSecurity(path);
      return {
        value: undefined,
        publications: [
          {
            path,
            data: await port.encryptVault(data, passphrase),
            mode: 0o600,
            currentUserOnly: true,
          },
        ],
      };
    },
  );
  unwrapStorePublicationMutation(result);
}

export async function setVaultStoredSecretWithPorts(
  env: Env,
  storeRoot: string,
  options: SetStoredSecretOptions & { readonly provider: "vault" },
  ports: VaultSecretMutationPorts,
): Promise<StoredSecretMutationResult> {
  const name = cellarerSecretReference(options.name).name;
  const protectedValue = createSecretValue(options.value);
  const operationEnv = withObservableKnownValues(env, [protectedValue]);
  const passphrase = requireVaultPassphrase(options.vaultPassphrase);
  const result = await executeStoreActionMutation(
    operationEnv,
    storeRoot,
    "secret-metadata",
    "vault-secret-set",
    async () => {
      const current = await ports.loadVault(storeRoot, passphrase);
      const next = protectedValue.use((plaintext) => ({ ...current, [name]: plaintext }));
      return {
        value: undefined,
        actions: [],
        publications: [
          {
            path: ports.vaultPath(storeRoot),
            data: await ports.encryptVault(next, passphrase),
            mode: 0o600,
            currentUserOnly: true,
          },
        ],
      };
    },
  );
  return { provider: "vault", name, operation: result.operation };
}

export async function setKeychainStoredSecretWithPort(
  env: Env,
  storeRoot: string,
  options: SetStoredSecretOptions & { readonly provider: "keychain" },
  port: KeychainSetPort,
): Promise<StoredSecretMutationResult> {
  const name = cellarerSecretReference(options.name).name;
  const protectedValue = createSecretValue(options.value);
  const operationEnv = withObservableKnownValues(env, [protectedValue]);
  const service = options.keychainService ?? "cellarer";
  const metadata = serializeKeychainMetadata(service, name, true);
  const intent = serializeKeychainMutationIntent(service, name, "set");
  const target = keychainMetadataPath(storeRoot, service, name);
  const result = await executeStoreActionMutation(
    operationEnv,
    storeRoot,
    "secret-metadata",
    "keychain-secret-set",
    async () => {
      return {
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
              await port.setKeychain(service, name, protectedValue);
              await operationEnv.fs.publishFileAtomically(target, metadata, { mode: 0o600 });
            },
          },
        ],
      };
    },
  );
  return { provider: "keychain", name, operation: result.operation };
}

export async function deleteVaultStoredSecretWithPorts(
  env: Env,
  storeRoot: string,
  options: DeleteStoredSecretOptions & { readonly provider: "vault" },
  ports: VaultSecretMutationPorts,
): Promise<StoredSecretMutationResult> {
  const name = cellarerSecretReference(options.name).name;
  const passphrase = requireVaultPassphrase(options.vaultPassphrase);
  const result = await executeStoreActionMutation(
    env,
    storeRoot,
    "secret-metadata",
    "vault-secret-delete",
    async () => {
      const current = await ports.loadVault(storeRoot, passphrase);
      const next = { ...current };
      delete next[name];
      return {
        value: undefined,
        actions: [],
        publications: [
          {
            path: ports.vaultPath(storeRoot),
            data: await ports.encryptVault(next, passphrase),
            mode: 0o600,
            currentUserOnly: true,
          },
        ],
      };
    },
  );
  return { provider: "vault", name, operation: result.operation };
}

export async function deleteKeychainStoredSecretWithPort(
  env: Env,
  storeRoot: string,
  options: DeleteStoredSecretOptions & { readonly provider: "keychain" },
  port: KeychainDeletePort,
): Promise<StoredSecretMutationResult> {
  const name = cellarerSecretReference(options.name).name;
  const service = options.keychainService ?? "cellarer";
  const metadata = serializeKeychainMetadata(service, name, false);
  const intent = serializeKeychainMutationIntent(service, name, "delete");
  const target = keychainMetadataPath(storeRoot, service, name);
  const result = await executeStoreActionMutation(
    env,
    storeRoot,
    "secret-metadata",
    "keychain-secret-delete",
    async () => {
      return {
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
              await port.deleteKeychain(service, name);
              await env.fs.publishFileAtomically(target, metadata, { mode: 0o600 });
            },
          },
        ],
      };
    },
  );
  return { provider: "keychain", name, operation: result.operation };
}

function requireVaultPassphrase(passphrase: string | undefined): string {
  if (!passphrase) throw new TypeError("vault passphrase is required for vault secret mutation");
  return passphrase;
}

function keychainActionId(operation: "set" | "delete", service: string, name: string): string {
  return sha256(JSON.stringify({ kind: `keychain-secret-${operation}`, service, name }));
}
