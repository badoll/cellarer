import { basename, dirname, join } from "node:path";
import type { Env, FileTreeSnapshot } from "../env.js";
import { lstatOrNull } from "../fs/probe.js";
import { sha256 } from "../store/checksum.js";

export type UnsafeRecursiveSourceReason =
  | "symbolic-link"
  | "non-regular"
  | "unreadable"
  | "stale"
  | "unsupported";

export class UnsafeRecursiveSourceError extends Error {
  readonly code = "UNSAFE_RECURSIVE_SOURCE" as const;

  constructor(
    readonly path: string,
    readonly reason: UnsafeRecursiveSourceReason,
  ) {
    super(`recursive source rejected at ${path}: ${reason}`);
    this.name = "UnsafeRecursiveSourceError";
  }
}

export interface SafeRecursiveFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly mode: number;
  readonly content: string;
  readonly data: Uint8Array;
}

export interface SafeRecursiveDirectory {
  readonly relativePath: string;
  readonly mode: number;
}

export interface SafeRecursiveSnapshot {
  readonly rootPath: string;
  readonly kind: "file" | "directory";
  readonly files: readonly SafeRecursiveFile[];
  readonly directories: readonly SafeRecursiveDirectory[];
  readonly fingerprint: string;
  readonly identity: string;
  readonly tree: FileTreeSnapshot;
}

/** Capture one immutable, no-follow tree. All public evidence is derived from this snapshot. */
export async function captureSafeRecursiveSource(
  env: Env,
  rootPath: string,
): Promise<SafeRecursiveSnapshot> {
  let tree: FileTreeSnapshot;
  try {
    const root = await env.fs.lstat(rootPath);
    if (root.isSymbolicLink()) {
      throw Object.assign(new Error("symbolic link source"), {
        code: "CELLARER_SNAPSHOT_SYMLINK",
        path: rootPath,
      });
    }
    if (root.isFile()) {
      tree = await env.fs.snapshotFileNoFollow(rootPath);
    } else if (root.isDirectory()) {
      if (!env.fs.supportsSafeRecursiveSnapshots()) {
        throw Object.assign(new Error("recursive snapshots are unsupported"), {
          code: "CELLARER_SNAPSHOT_UNSUPPORTED",
          path: rootPath,
        });
      }
      tree = await env.fs.snapshotTreeNoFollow(rootPath);
    } else {
      throw Object.assign(new Error("non-regular source"), {
        code: "CELLARER_SNAPSHOT_NON_REGULAR",
        path: rootPath,
      });
    }
  } catch (error) {
    throw normalizeSnapshotError(rootPath, error);
  }
  const root = tree.nodes.find((node) => node.relativePath === "");
  if (!root) throw new UnsafeRecursiveSourceError(rootPath, "stale");
  const files = tree.nodes.flatMap((node) => {
    if (node.kind !== "file" || !node.data) return [];
    return [
      Object.freeze({
        absolutePath: node.relativePath
          ? join(rootPath, ...node.relativePath.split("/"))
          : rootPath,
        relativePath: node.relativePath,
        mode: node.mode,
        content: new TextDecoder().decode(node.data),
        data: node.data,
      }),
    ];
  });
  const directories = tree.nodes.flatMap((node) =>
    node.kind === "directory"
      ? [Object.freeze({ relativePath: node.relativePath, mode: node.mode })]
      : [],
  );
  return Object.freeze({
    rootPath,
    kind: root.kind,
    files: Object.freeze(files),
    directories: Object.freeze(directories),
    fingerprint: snapshotFingerprint(tree),
    identity: sha256(JSON.stringify(tree.nodes.map((node) => [node.relativePath, node.identity]))),
    tree,
  });
}

/** Compatibility view for scanners that only need file contents. */
export async function scanSafeRecursiveSource(
  env: Env,
  rootPath: string,
): Promise<readonly SafeRecursiveFile[]> {
  return (await captureSafeRecursiveSource(env, rootPath)).files;
}

export async function assertSafeRecursiveSnapshotCurrent(
  env: Env,
  snapshot: SafeRecursiveSnapshot,
): Promise<void> {
  const current =
    snapshot.kind === "file"
      ? await env.fs.verifyFileSnapshot(snapshot.tree)
      : await env.fs.verifyTreeSnapshot(snapshot.tree);
  if (current) return;
  throw Object.assign(new Error(`recursive source changed after snapshot: ${snapshot.rootPath}`), {
    code: "ESTALE",
  });
}

export async function installSafeRecursiveSnapshot(
  env: Env,
  snapshot: SafeRecursiveSnapshot,
  target: string,
  replaceExisting: boolean,
): Promise<void> {
  if (snapshot.kind !== "directory") {
    throw new UnsafeRecursiveSourceError(snapshot.rootPath, "non-regular");
  }
  const parent = dirname(target);
  const suffix = env.randomId();
  const staged = join(parent, `.${basename(target)}.cellarer-snapshot-${suffix}`);
  const displaced = join(parent, `.${basename(target)}.cellarer-before-${suffix}`);
  await env.fs.mkdir(parent, { recursive: true });
  if ((await lstatOrNull(env, staged)) || (await lstatOrNull(env, displaced))) {
    throw new Error(`snapshot staging path already exists for "${target}"`);
  }

  try {
    await materializeSnapshot(env, snapshot, staged);
    const stagedSnapshot = await captureSafeRecursiveSource(env, staged);
    if (stagedSnapshot.fingerprint !== snapshot.fingerprint) {
      throw Object.assign(new Error(`snapshot materialization mismatch for ${target}`), {
        code: "ESTALE",
      });
    }
    const existing = await lstatOrNull(env, target);
    if (!existing) {
      await env.fs.rename(staged, target);
      return;
    }
    if (!replaceExisting) throw new Error(`destination exists: "${target}"`);
    await env.fs.rename(target, displaced);
    try {
      await env.fs.rename(staged, target);
    } catch (error) {
      await env.fs.rename(displaced, target).catch(() => {});
      throw error;
    }
    await env.fs.rm(displaced, { recursive: true, force: true });
  } catch (error) {
    await env.fs.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function materializeSnapshot(
  env: Env,
  snapshot: SafeRecursiveSnapshot,
  target: string,
): Promise<void> {
  const root = snapshot.directories.find((directory) => directory.relativePath === "");
  if (!root) throw new UnsafeRecursiveSourceError(snapshot.rootPath, "non-regular");
  await env.fs.mkdir(target, { recursive: false, mode: root.mode });
  await env.fs.chmod(target, root.mode);
  for (const directory of snapshot.directories) {
    if (!directory.relativePath) continue;
    const path = join(target, ...directory.relativePath.split("/"));
    await env.fs.mkdir(path, { recursive: true, mode: directory.mode });
    await env.fs.chmod(path, directory.mode);
  }
  for (const file of snapshot.files) {
    const path = join(target, ...file.relativePath.split("/"));
    await env.fs.mkdir(dirname(path), { recursive: true });
    await env.fs.writeFileBytes(path, file.data, { mode: file.mode });
    await env.fs.chmod(path, file.mode);
  }
}

function snapshotFingerprint(tree: FileTreeSnapshot): string {
  const root = tree.nodes.find((node) => node.relativePath === "");
  if (!root) throw new UnsafeRecursiveSourceError(tree.rootPath, "stale");
  if (root.kind === "file") {
    if (!root.data) throw new UnsafeRecursiveSourceError(tree.rootPath, "unreadable");
    return sha256(root.data);
  }
  const manifest = tree.nodes.map((node) =>
    node.kind === "directory"
      ? { path: node.relativePath, kind: "directory" as const, mode: node.mode }
      : {
          path: node.relativePath,
          kind: "file" as const,
          mode: node.mode,
          digest: sha256(node.data ?? new Uint8Array()),
        },
  );
  return sha256(JSON.stringify(manifest));
}

function normalizeSnapshotError(rootPath: string, error: unknown): UnsafeRecursiveSourceError {
  if (error instanceof UnsafeRecursiveSourceError) return error;
  const detail = error as { code?: unknown; path?: unknown } | null;
  const path = typeof detail?.path === "string" ? detail.path : rootPath;
  const reason =
    detail?.code === "CELLARER_SNAPSHOT_SYMLINK"
      ? "symbolic-link"
      : detail?.code === "CELLARER_SNAPSHOT_NON_REGULAR"
        ? "non-regular"
        : detail?.code === "CELLARER_SNAPSHOT_STALE"
          ? "stale"
          : detail?.code === "CELLARER_SNAPSHOT_UNSUPPORTED"
            ? "unsupported"
            : "unreadable";
  return new UnsafeRecursiveSourceError(path, reason);
}
