import { join, resolve } from "node:path";
import type { Env } from "../env.js";
import { lstatOrNull } from "../fs/probe.js";
import { assertSafeStoreObservationPath } from "../fs/safety.js";
import { storeRevisionPath } from "../protocol/store-revision.js";
import { CONFIG_FILENAME } from "./config.js";

export interface StoreLayout {
  readonly canonicalStoreRoot: string;
  readonly configurationPath: string;
  readonly revisionPath: string;
}

export type UnsafeStoreObservationReason = "symbolic-link" | "unsafe-path";

export class UnsafeStoreObservationPathError extends Error {
  readonly code = "UNSAFE_STORE_OBSERVATION" as const;

  constructor(
    readonly path: string,
    readonly reason: UnsafeStoreObservationReason,
    label: string,
  ) {
    const detail = reason === "symbolic-link" ? "symlink/symbolic-link" : reason;
    super(`unsafe Store observation for ${label} at "${path}": ${detail}`);
    this.name = "UnsafeStoreObservationPathError";
  }
}

export async function resolveStoreLayout(env: Env, storeRoot: string): Promise<StoreLayout> {
  const requestedStoreRoot = resolve(env.cwd(), storeRoot);
  const canonicalStoreRoot = await env.fs.realpath(requestedStoreRoot);
  const configurationPath = join(canonicalStoreRoot, CONFIG_FILENAME);
  const revisionPath = storeRevisionPath(canonicalStoreRoot);

  await Promise.all([
    assertSafeNamedStorePath(env, configurationPath, canonicalStoreRoot, "managed configuration"),
    assertSafeNamedStorePath(env, revisionPath, canonicalStoreRoot, "managed Store revision"),
  ]);

  return Object.freeze({ canonicalStoreRoot, configurationPath, revisionPath });
}

async function assertSafeNamedStorePath(
  env: Env,
  path: string,
  storeRoot: string,
  label: string,
): Promise<void> {
  const stat = await lstatOrNull(env, path);
  if (stat?.isSymbolicLink()) {
    throw new UnsafeStoreObservationPathError(path, "symbolic-link", label);
  }
  try {
    await assertSafeStoreObservationPath(env, path, storeRoot, label);
  } catch {
    throw new UnsafeStoreObservationPathError(path, "unsafe-path", label);
  }
}
