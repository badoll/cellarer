import { join } from "node:path";
import type { Env } from "../env.js";
import type { StoreRevision } from "./models.js";
import { publishVerifiedStoreFile } from "./publication.js";

const STORE_REVISION_SCHEMA_VERSION = 1;

export function storeRevisionPath(storeRoot: string): string {
  return join(storeRoot, "revision.json");
}

export async function readStoreRevision(env: Env, storeRoot: string): Promise<StoreRevision> {
  const path = storeRevisionPath(storeRoot);
  const text = await env.fs.readFile(path).catch((error: unknown) => {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return 0;
  try {
    const value = JSON.parse(text) as { schemaVersion?: unknown; revision?: unknown };
    if (
      value.schemaVersion !== STORE_REVISION_SCHEMA_VERSION ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 0
    ) {
      throw new Error("invalid revision record");
    }
    return value.revision as StoreRevision;
  } catch (error) {
    throw new Error(
      `corrupt store revision at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function publishStoreRevision(
  env: Env,
  storeRoot: string,
  revision: StoreRevision,
): Promise<void> {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError(`store revision must be a non-negative safe integer, got ${revision}`);
  }
  const path = storeRevisionPath(storeRoot);
  await publishVerifiedStoreFile(
    env,
    storeRoot,
    path,
    `${JSON.stringify({ schemaVersion: STORE_REVISION_SCHEMA_VERSION, revision }, null, 2)}\n`,
    0o600,
    "store revision",
  );
}

export class StoreRevisionChangedDuringPlanningError extends Error {
  readonly code = "REVISION_CHANGED_DURING_PLANNING" as const;
  readonly retryRequired = true as const;

  constructor(
    readonly beforeRevision: StoreRevision,
    readonly afterRevision: StoreRevision,
  ) {
    super(
      `store revision changed during planning (${beforeRevision} -> ${afterRevision}); retry required`,
    );
    this.name = "StoreRevisionChangedDuringPlanningError";
  }
}

export async function observeAtStableStoreRevision<T>(
  env: Env,
  storeRoot: string,
  observe: () => Promise<T>,
  maxAttempts = 2,
): Promise<{ value: T; revision: StoreRevision }> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError(`planning attempts must be a positive safe integer, got ${maxAttempts}`);
  }
  let beforeRevision = 0;
  let afterRevision = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    beforeRevision = await readStoreRevision(env, storeRoot);
    const value = await observe();
    afterRevision = await readStoreRevision(env, storeRoot);
    if (beforeRevision === afterRevision) return { value, revision: beforeRevision };
  }
  throw new StoreRevisionChangedDuringPlanningError(beforeRevision, afterRevision);
}
