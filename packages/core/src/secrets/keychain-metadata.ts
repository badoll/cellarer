import { join } from "node:path";
import type { FsLike } from "../env.js";
import { sha256 } from "../store/checksum.js";
import { assertOrdinarySecretCredentialTarget } from "./authority-namespace.js";
import { cellarerSecretReference } from "./reference.js";
import { captureSafeRecursiveSource } from "./safe-tree.js";

interface KeychainMetadata {
  readonly schemaVersion: 1;
  readonly provider: "keychain";
  readonly service: string;
  readonly name: string;
  readonly present: boolean;
}

export function keychainMetadataPath(storeRoot: string, service: string, name: string): string {
  assertOrdinarySecretCredentialTarget(service, name);
  const identity = sha256(JSON.stringify({ service, name }));
  return join(storeRoot, "secrets", "keychain", `${identity}.json`);
}

export function serializeKeychainMetadata(service: string, name: string, present: boolean): string {
  assertOrdinarySecretCredentialTarget(service, name);
  return `${JSON.stringify({ schemaVersion: 1, provider: "keychain", service, name, present }, null, 2)}\n`;
}

export function serializeKeychainMutationIntent(
  service: string,
  name: string,
  mutation: "set" | "delete",
): string {
  assertOrdinarySecretCredentialTarget(service, name);
  return `${JSON.stringify(
    { schemaVersion: 1, provider: "keychain", service, name, mutation, status: "executing" },
    null,
    2,
  )}\n`;
}

export async function listManagedKeychainSecretNames(
  env: {
    readonly fs: Pick<
      FsLike,
      | "lstat"
      | "readdir"
      | "snapshotFileNoFollow"
      | "snapshotTreeNoFollow"
      | "supportsSafeRecursiveSnapshots"
    >;
  },
  storeRoot: string,
  service: string,
): Promise<string[]> {
  const directory = join(storeRoot, "secrets", "keychain");
  const entries = await env.fs.readdir(directory).catch((error: unknown) => {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  });
  const names: string[] = [];
  for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
    if (!/^sha256:[0-9a-f]{64}\.json$/.test(entry)) {
      throw new Error("keychain metadata inventory contains an invalid entry");
    }
    const path = join(directory, entry);
    const snapshot = await captureSafeRecursiveSource(env, path);
    if (snapshot.kind !== "file" || snapshot.files.length !== 1) {
      throw new Error("keychain metadata inventory contains a non-file entry");
    }
    const parsed: unknown = JSON.parse(snapshot.files[0]?.content ?? "");
    if (!isKeychainMetadata(parsed)) {
      throw new Error("keychain metadata inventory contains invalid metadata");
    }
    assertOrdinarySecretCredentialTarget(parsed.service, parsed.name);
    cellarerSecretReference(parsed.name);
    if (keychainMetadataPath(storeRoot, parsed.service, parsed.name) !== path) {
      throw new Error("keychain metadata inventory identity does not match its path");
    }
    if (parsed.service === service && parsed.present) names.push(parsed.name);
  }
  return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

function isKeychainMetadata(value: unknown): value is KeychainMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    keys.length === 5 &&
    keys.join("\u0000") ===
      ["name", "present", "provider", "schemaVersion", "service"].join("\u0000") &&
    record.schemaVersion === 1 &&
    record.provider === "keychain" &&
    typeof record.service === "string" &&
    record.service.length > 0 &&
    typeof record.name === "string" &&
    typeof record.present === "boolean"
  );
}
