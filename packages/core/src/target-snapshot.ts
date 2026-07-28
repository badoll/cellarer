import { Buffer } from "node:buffer";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { armor, Decrypter, Encrypter } from "age-encryption";
import type { Env, FileStat } from "./env.js";
import { lstatOrNull } from "./fs/probe.js";
import { isPathInside } from "./fs/safety.js";
import { sha256 } from "./store/checksum.js";
import { fingerprintTarget } from "./target-ownership.js";

export type TargetSnapshotEntry =
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "file"; mode: number; data: string }
  | { path: string; kind: "symlink"; mode: number; target: string };

export interface TargetSnapshot {
  version: 1;
  targetFingerprint: string;
  nodeFingerprint: string;
  sizeBytes: number;
  entries: TargetSnapshotEntry[];
}

export interface EncryptedTargetSnapshot {
  path: string;
  targetFingerprint: string;
  sizeBytes: number;
}

export class SnapshotCreationError extends Error {
  constructor(
    readonly target: string,
    cause: unknown,
  ) {
    super(
      `failed to create encrypted snapshot for "${target}": ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "SnapshotCreationError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let snapshotCounter = 0;
let restoreCounter = 0;

export async function createEncryptedTargetSnapshot(
  env: Env,
  storeRoot: string,
  target: string,
  passphrase: string,
  expectedFingerprint: string | null,
): Promise<EncryptedTargetSnapshot> {
  try {
    if (passphrase.length === 0) throw new Error("snapshot passphrase is empty");
    const snapshot = await captureTargetSnapshot(env, target);
    if (snapshot.targetFingerprint !== expectedFingerprint) {
      throw new Error("target receipt changed after planning");
    }
    const encrypted = await encryptTargetSnapshot(snapshot, passphrase);
    const dir = await prepareSnapshotDirectory(env, storeRoot);
    snapshotCounter += 1;
    const name = sha256(
      JSON.stringify([
        target,
        snapshot.targetFingerprint,
        env.now().toISOString(),
        snapshotCounter,
      ]),
    ).slice("sha256:".length);
    const path = join(dir, `${name}.age`);
    const temporaryPath = join(dir, `.${name}.tmp`);
    let renamed = false;

    try {
      await env.fs.chmod(dir, 0o700);
      await env.fs.writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await env.fs.chmod(temporaryPath, 0o600);
      await env.fs.rename(temporaryPath, path);
      renamed = true;
      await env.fs.chmod(path, 0o600);
    } catch (error) {
      await env.fs.rm(temporaryPath, { force: true }).catch(() => {});
      if (renamed) await env.fs.rm(path, { force: true }).catch(() => {});
      throw error;
    }

    return {
      path,
      targetFingerprint: snapshot.targetFingerprint,
      sizeBytes: snapshot.sizeBytes,
    };
  } catch (error) {
    if (error instanceof SnapshotCreationError) throw error;
    throw new SnapshotCreationError(target, error);
  }
}

async function prepareSnapshotDirectory(env: Env, storeRoot: string): Promise<string> {
  if (!isAbsolute(storeRoot)) {
    throw new Error(`snapshot store root must be absolute: "${storeRoot}"`);
  }

  const normalizedStoreRoot = normalize(storeRoot);
  const canonicalStoreRoot = await canonicalDirectoryWithoutSymlinks(
    env,
    normalizedStoreRoot,
    "snapshot store root",
  );
  const snapshotsRoot = join(normalizedStoreRoot, "snapshots");
  if (!(await lstatOrNull(env, snapshotsRoot))) {
    await env.fs.mkdir(snapshotsRoot, { recursive: true, mode: 0o700 });
  }
  const canonicalSnapshotsRoot = await canonicalDirectoryWithoutSymlinks(
    env,
    snapshotsRoot,
    "snapshot root",
  );
  if (!isPathInside(canonicalSnapshotsRoot, canonicalStoreRoot)) {
    throw new Error(`snapshot root resolves outside snapshot store root: "${snapshotsRoot}"`);
  }
  return snapshotsRoot;
}

async function canonicalDirectoryWithoutSymlinks(
  env: Env,
  path: string,
  label: string,
): Promise<string> {
  const ancestors: string[] = [];
  let current = normalize(path);
  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const ancestor of ancestors.reverse()) {
    const stat = await lstatOrNull(env, ancestor);
    if (!stat) throw new Error(`${label} has a missing ancestor: "${ancestor}"`);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} has an unsafe symlink ancestor: "${ancestor}"`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`${label} ancestor is not a directory: "${ancestor}"`);
    }
  }

  return env.fs.realpath(path);
}

export async function encryptTargetSnapshot(
  snapshot: TargetSnapshot,
  passphrase: string,
): Promise<string> {
  const encrypter = new Encrypter();
  encrypter.setPassphrase(passphrase);
  return armor.encode(await encrypter.encrypt(encoder.encode(JSON.stringify(snapshot))));
}

export async function decryptTargetSnapshot(
  encrypted: string,
  passphrase: string,
): Promise<TargetSnapshot> {
  const decrypter = new Decrypter();
  decrypter.addPassphrase(passphrase);
  const plaintext = await decrypter.decrypt(armor.decode(encrypted), "uint8array");
  const parsed: unknown = JSON.parse(decoder.decode(plaintext));
  assertTargetSnapshot(parsed);
  return parsed;
}

// Rebuild and verify on a sibling path, then swap it over the current target. Every fallible build
// and receipt read happens before displacement; swap/cleanup failures attempt to restore the exact
// current target so the caller can safely retain both owner and encrypted snapshot.
export async function restoreTargetSnapshot(
  env: Env,
  target: string,
  snapshot: TargetSnapshot,
  expectedCurrentFingerprint?: string | null,
): Promise<void> {
  assertTargetSnapshot(snapshot);
  restoreCounter += 1;
  const suffix = `${env.now().getTime()}-${restoreCounter}`;
  const parent = dirname(target);
  const name = basename(target);
  const staged = join(parent, `.${name}.cellarer-restore-stage-${suffix}`);
  const displaced = join(parent, `.${name}.cellarer-restore-before-${suffix}`);
  if ((await lstatOrNull(env, staged)) || (await lstatOrNull(env, displaced))) {
    throw new Error(`restore staging path already exists for "${target}"`);
  }

  try {
    await rebuildTargetSnapshot(env, staged, snapshot);
    if ((await fingerprintTargetNodeState(env, staged)) !== snapshot.nodeFingerprint) {
      throw new Error("staged target does not match the encrypted snapshot fingerprint");
    }
    if (
      expectedCurrentFingerprint !== undefined &&
      (await fingerprintTarget(env, target)) !== expectedCurrentFingerprint
    ) {
      throw new Error(`target "${target}" changed while its snapshot was being restored`);
    }
  } catch (error) {
    await env.fs.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  try {
    await env.fs.rename(target, displaced);
  } catch (error) {
    await env.fs.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  try {
    await env.fs.rename(staged, target);
  } catch (error) {
    try {
      await env.fs.rename(displaced, target);
    } catch (rollbackError) {
      throw restoreRollbackError(target, error, rollbackError, [staged, displaced]);
    }
    if (!(await lstatOrNull(env, target))) {
      throw restoreRollbackError(target, error, new Error("canonical target is missing"), [staged]);
    }
    try {
      await env.fs.rm(staged, { recursive: true, force: true });
    } catch (cleanupError) {
      throw restoreRollbackError(target, error, cleanupError, [target, staged]);
    }
    throw error;
  }

  try {
    await env.fs.rm(displaced, { recursive: true, force: true });
  } catch (error) {
    try {
      await env.fs.rename(target, staged);
    } catch (rollbackError) {
      throw restoreRollbackError(target, error, rollbackError, [target, displaced]);
    }
    try {
      await env.fs.rename(displaced, target);
    } catch (rollbackError) {
      throw restoreRollbackError(target, error, rollbackError, [staged, displaced]);
    }
    if (!(await lstatOrNull(env, target))) {
      throw restoreRollbackError(target, error, new Error("canonical target is missing"), [staged]);
    }
    try {
      await env.fs.rm(staged, { recursive: true, force: true });
    } catch (cleanupError) {
      throw restoreRollbackError(target, error, cleanupError, [target, staged]);
    }
    throw error;
  }
}

async function rebuildTargetSnapshot(
  env: Env,
  stagedTarget: string,
  snapshot: TargetSnapshot,
): Promise<void> {
  for (const entry of snapshot.entries) {
    const path = snapshotEntryPath(stagedTarget, entry.path);
    if (entry.kind === "directory") {
      await env.fs.mkdir(path, { recursive: true, mode: entry.mode });
      await env.fs.chmod(path, entry.mode);
      continue;
    }
    await env.fs.mkdir(dirname(path), { recursive: true });
    if (entry.kind === "file") {
      await env.fs.writeFileBytes(path, Buffer.from(entry.data, "base64"), { mode: entry.mode });
      await env.fs.chmod(path, entry.mode);
      continue;
    }
    await env.fs.symlink(entry.target, path);
  }
}

function restoreRollbackError(
  target: string,
  error: unknown,
  rollbackError: unknown,
  recoveryPaths: string[],
): Error {
  return new Error(
    `snapshot restore and rollback failed for "${target}": ${String(error)}; rollback: ${String(rollbackError)}; recoverable paths: ${recoveryPaths.map((path) => `"${path}"`).join(", ")}`,
    { cause: rollbackError },
  );
}

async function captureTargetSnapshot(env: Env, target: string): Promise<TargetSnapshot> {
  const stat = await lstatOrNull(env, target);
  if (!stat) throw new Error("target disappeared before snapshot creation");
  const fingerprint = await fingerprintTarget(env, target);
  if (!fingerprint) throw new Error("target cannot be fingerprinted completely");

  const entries: TargetSnapshotEntry[] = [];
  const sizeBytes = await captureEntry(env, target, "", stat, entries);
  return {
    version: 1,
    targetFingerprint: fingerprint,
    nodeFingerprint: fingerprintSnapshotEntries(entries),
    sizeBytes,
    entries,
  };
}

async function fingerprintTargetNodeState(env: Env, target: string): Promise<string | null> {
  const stat = await lstatOrNull(env, target);
  if (!stat) return null;
  const entries: TargetSnapshotEntry[] = [];
  await captureEntry(env, target, "", stat, entries);
  return fingerprintSnapshotEntries(entries);
}

function fingerprintSnapshotEntries(entries: readonly TargetSnapshotEntry[]): string {
  return sha256(JSON.stringify({ version: 1, entries }));
}

async function captureEntry(
  env: Env,
  absolutePath: string,
  relativePath: string,
  stat: FileStat,
  entries: TargetSnapshotEntry[],
): Promise<number> {
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    entries.push({
      path: relativePath,
      kind: "symlink",
      mode,
      target: await env.fs.readlink(absolutePath),
    });
    return 0;
  }
  if (stat.isFile()) {
    const bytes = await env.fs.readFileBytes(absolutePath);
    entries.push({
      path: relativePath,
      kind: "file",
      mode,
      data: Buffer.from(bytes).toString("base64"),
    });
    return bytes.byteLength;
  }
  if (!stat.isDirectory()) {
    throw new Error(`unsupported target entry type at "${absolutePath}"`);
  }

  entries.push({ path: relativePath, kind: "directory", mode });
  let sizeBytes = 0;
  for (const name of (await env.fs.readdir(absolutePath)).sort()) {
    const childAbsolute = join(absolutePath, name);
    const childRelative = relativePath.length === 0 ? name : `${relativePath}/${name}`;
    sizeBytes += await captureEntry(
      env,
      childAbsolute,
      childRelative,
      await env.fs.lstat(childAbsolute),
      entries,
    );
  }
  return sizeBytes;
}

function assertTargetSnapshot(value: unknown): asserts value is TargetSnapshot {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("targetFingerprint" in value) ||
    typeof value.targetFingerprint !== "string" ||
    !("nodeFingerprint" in value) ||
    typeof value.nodeFingerprint !== "string" ||
    !("sizeBytes" in value) ||
    typeof value.sizeBytes !== "number" ||
    !("entries" in value) ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("snapshot: decrypted payload has an invalid shape");
  }

  const paths = new Set<string>();
  for (const rawEntry of value.entries) {
    if (typeof rawEntry !== "object" || rawEntry === null) {
      throw new Error("snapshot: decrypted entry has an invalid shape");
    }
    const entry = rawEntry as Partial<TargetSnapshotEntry>;
    if (
      typeof entry.path !== "string" ||
      typeof entry.kind !== "string" ||
      typeof entry.mode !== "number" ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0
    ) {
      throw new Error("snapshot: decrypted entry has an invalid shape");
    }
    assertSafeSnapshotPath(entry.path);
    if (paths.has(entry.path)) throw new Error(`snapshot: duplicate entry path "${entry.path}"`);
    paths.add(entry.path);
    if (entry.kind === "file" && typeof entry.data !== "string") {
      throw new Error("snapshot: file entry is missing data");
    }
    if (entry.kind === "symlink" && typeof entry.target !== "string") {
      throw new Error("snapshot: symlink entry is missing its target");
    }
    if (entry.kind !== "file" && entry.kind !== "directory" && entry.kind !== "symlink") {
      throw new Error(`snapshot: unsupported entry kind "${entry.kind}"`);
    }
  }
  if (!paths.has("")) throw new Error("snapshot: root entry is missing");
}

function assertSafeSnapshotPath(path: string): void {
  if (path === "") return;
  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`snapshot: unsafe entry path "${path}"`);
  }
}

function snapshotEntryPath(target: string, path: string): string {
  assertSafeSnapshotPath(path);
  return path === "" ? target : join(target, ...path.split("/"));
}
