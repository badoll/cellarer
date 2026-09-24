import { resolve } from "node:path";
import type { Env, SnapshotLimits } from "../env.js";
import { isWithinRoot } from "../fs/safety.js";
import {
  assertSafeRecursiveSnapshotCurrent,
  captureAnchoredSafeRecursiveSource,
  type SafeRecursiveSnapshot,
  UnsafeRecursiveSourceError,
} from "../secrets/safe-tree.js";
import { sha256 } from "../store/checksum.js";

export interface CapturedSkillChild {
  readonly snapshot: SafeRecursiveSnapshot;
  readonly linkText?: string;
}

export interface SkillTargetCaptureCache {
  readonly captures: Map<string, Promise<SafeRecursiveSnapshot>>;
}

const MAX_CACHED_SKILL_TARGETS = 256;

export function createSkillTargetCaptureCache(): SkillTargetCaptureCache {
  return { captures: new Map() };
}

/** Resolve only a direct Skill alias; content is always captured from a no-follow canonical path. */
export async function captureInventorySkillChild(
  env: Env,
  boundaryRoot: string,
  aliasPath: string,
  limits: SnapshotLimits,
  expectedLinkText?: string,
  cache?: SkillTargetCaptureCache,
): Promise<CapturedSkillChild> {
  const entry = await env.fs.lstat(aliasPath);
  if (!entry.isSymbolicLink()) {
    if (expectedLinkText !== undefined || !entry.isDirectory()) {
      throw new UnsafeRecursiveSourceError(aliasPath, "stale");
    }
    const snapshot = await captureAnchoredSafeRecursiveSource(env, boundaryRoot, aliasPath, limits);
    if (snapshot?.kind !== "directory") {
      throw new UnsafeRecursiveSourceError(aliasPath, "stale");
    }
    return { snapshot };
  }

  let linkText: string;
  let canonicalTarget: string;
  try {
    linkText = await env.fs.readlink(aliasPath);
    if (expectedLinkText !== undefined && linkText !== expectedLinkText) {
      throw new UnsafeRecursiveSourceError(aliasPath, "stale");
    }
    canonicalTarget = await env.fs.realpath(aliasPath);
  } catch (error) {
    if (error instanceof UnsafeRecursiveSourceError) throw error;
    throw new UnsafeRecursiveSourceError(aliasPath, "symbolic-link");
  }
  if (!isWithinRoot(resolve(env.cwd(), boundaryRoot), canonicalTarget)) {
    throw new UnsafeRecursiveSourceError(aliasPath, "symbolic-link");
  }
  const target = cache
    ? await cachedTargetCapture(env, cache, boundaryRoot, canonicalTarget, limits)
    : await captureAnchoredSafeRecursiveSource(env, boundaryRoot, canonicalTarget, limits);
  if (target?.kind !== "directory") {
    throw new UnsafeRecursiveSourceError(aliasPath, "symbolic-link");
  }
  try {
    const current = await env.fs.lstat(aliasPath);
    if (
      !current.isSymbolicLink() ||
      (await env.fs.readlink(aliasPath)) !== linkText ||
      (await env.fs.realpath(aliasPath)) !== canonicalTarget
    ) {
      throw new UnsafeRecursiveSourceError(aliasPath, "stale");
    }
  } catch {
    throw new UnsafeRecursiveSourceError(aliasPath, "stale");
  }
  return {
    linkText,
    snapshot: Object.freeze({
      ...target,
      rootPath: aliasPath,
      identity: sha256(JSON.stringify([linkText, canonicalTarget, target.identity])),
      tree: Object.freeze({ ...target.tree, rootPath: aliasPath }),
    }),
  };
}

async function cachedTargetCapture(
  env: Env,
  cache: SkillTargetCaptureCache,
  boundaryRoot: string,
  canonicalTarget: string,
  limits: SnapshotLimits,
): Promise<SafeRecursiveSnapshot | null> {
  const key = JSON.stringify([boundaryRoot, canonicalTarget]);
  const prior = cache.captures.get(key);
  if (prior) {
    let snapshot: SafeRecursiveSnapshot;
    try {
      snapshot = await prior;
    } catch {
      if (cache.captures.get(key) === prior) cache.captures.delete(key);
      return cachedTargetCapture(env, cache, boundaryRoot, canonicalTarget, limits);
    }
    assertWithinLimits(snapshot, limits);
    try {
      await assertSafeRecursiveSnapshotCurrent(env, snapshot);
      return snapshot;
    } catch {
      if (cache.captures.get(key) === prior) cache.captures.delete(key);
      throw new UnsafeRecursiveSourceError(canonicalTarget, "stale");
    }
  }
  if (cache.captures.size >= MAX_CACHED_SKILL_TARGETS) {
    return captureAnchoredSafeRecursiveSource(env, boundaryRoot, canonicalTarget, limits);
  }
  const capture = captureAnchoredSafeRecursiveSource(
    env,
    boundaryRoot,
    canonicalTarget,
    limits,
  ).then((snapshot) => {
    if (snapshot?.kind !== "directory") {
      throw new UnsafeRecursiveSourceError(canonicalTarget, "stale");
    }
    return snapshot;
  });
  cache.captures.set(key, capture);
  try {
    return await capture;
  } catch (error) {
    if (cache.captures.get(key) === capture) cache.captures.delete(key);
    throw error;
  }
}

function assertWithinLimits(snapshot: SafeRecursiveSnapshot, limits: SnapshotLimits): void {
  const maxDepth = Math.max(
    ...snapshot.tree.nodes.map((node) =>
      node.relativePath ? node.relativePath.split("/").length : 0,
    ),
  );
  const bytes = snapshot.files.reduce((sum, file) => sum + file.data.byteLength, 0);
  if (
    maxDepth > limits.maxDepth ||
    snapshot.tree.nodes.length > limits.maxEntries ||
    bytes > limits.maxBytes
  ) {
    throw new UnsafeRecursiveSourceError(snapshot.rootPath, "budget-exceeded");
  }
}
