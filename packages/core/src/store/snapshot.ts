import type { Env, FileTreeSnapshot, FileTreeSnapshotNode } from "../env.js";
import type { StoreRevision } from "../protocol/models.js";
import { parseStoreRevisionRecord } from "../protocol/store-revision.js";
import { type CellarerConfig, loadConfigFromReadContext, PACKAGED_CONFIG_PATH } from "./config.js";
import {
  resolveStoreLayout,
  type StoreLayout,
  UnsafeStoreObservationPathError,
  type UnsafeStoreObservationReason,
} from "./layout.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_OBSERVATION_ATTEMPTS = 2;

export interface StoreConfigSnapshot {
  readonly canonicalStoreRoot: string;
  readonly configuration: CellarerConfig;
  readonly revision: StoreRevision;
}

export interface StaleStoreSnapshotError {
  readonly code: "STALE_STORE_SNAPSHOT";
  readonly beforeRevision: StoreRevision;
  readonly afterRevision: StoreRevision;
}

export interface UnsafeStoreSnapshotError {
  readonly code: "UNSAFE_STORE_OBSERVATION";
  readonly path: string;
  readonly reason: UnsafeStoreObservationReason;
}

export type StoreConfigSnapshotObservation =
  | { readonly ok: true; readonly snapshot: StoreConfigSnapshot }
  | {
      readonly ok: false;
      readonly error: StaleStoreSnapshotError | UnsafeStoreSnapshotError;
    };

export async function observeStoreConfigSnapshot(
  env: Env,
  storeRoot: string,
): Promise<StoreConfigSnapshotObservation> {
  try {
    return await observeStoreConfigSnapshotBounded(env, storeRoot);
  } catch (error) {
    if (!(error instanceof UnsafeStoreObservationPathError)) throw error;
    return Object.freeze({
      ok: false,
      error: Object.freeze({
        code: error.code,
        path: error.path,
        reason: error.reason,
      }),
    });
  }
}

async function observeStoreConfigSnapshotBounded(
  env: Env,
  storeRoot: string,
): Promise<StoreConfigSnapshotObservation> {
  const layout = await resolveStoreLayout(env, storeRoot);
  let beforeRevision: StoreRevision = 0;
  let afterRevision: StoreRevision = 0;

  for (let attempt = 0; attempt < MAX_OBSERVATION_ATTEMPTS; attempt += 1) {
    beforeRevision = await observeRevision(env, layout);
    const configuration = await observeConfiguration(env, layout);
    afterRevision = await observeRevision(env, layout);
    if (beforeRevision === afterRevision) {
      const snapshot = Object.freeze({
        canonicalStoreRoot: layout.canonicalStoreRoot,
        configuration: deepFreeze(configuration),
        revision: beforeRevision,
      });
      return Object.freeze({ ok: true, snapshot });
    }
  }

  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "STALE_STORE_SNAPSHOT",
      beforeRevision,
      afterRevision,
    }),
  });
}

async function observeRevision(env: Env, layout: StoreLayout): Promise<StoreRevision> {
  const text = await observeManagedFileText(env, layout, layout.revisionPath);
  return parseStoreRevisionRecord(text, layout.revisionPath);
}

async function observeConfiguration(env: Env, layout: StoreLayout): Promise<CellarerConfig> {
  const text = await observeManagedFileText(env, layout, layout.configurationPath);
  return loadConfigFromReadContext(
    {
      fs: {
        readFile: async (path) => {
          if (path === layout.configurationPath) {
            if (text !== null) return text;
            throw Object.assign(new Error(`missing managed configuration at ${path}`), {
              code: "ENOENT",
            });
          }
          if (path === PACKAGED_CONFIG_PATH) return env.fs.readFile(path);
          throw new Error(`unexpected configuration read outside Store layout: ${path}`);
        },
      },
    },
    layout.canonicalStoreRoot,
  );
}

async function observeManagedFileText(
  env: Env,
  layout: StoreLayout,
  path: string,
): Promise<string | null> {
  let observation: FileTreeSnapshot | null;
  try {
    observation = await env.fs.snapshotPathNoFollow(layout.canonicalStoreRoot, path);
  } catch (error) {
    const reason = unsafeSnapshotReason(error);
    if (reason !== null) {
      throw new UnsafeStoreObservationPathError(path, reason, "managed Store file");
    }
    throw error;
  }
  if (observation === null) return null;
  const node = singleRegularFileNode(observation.nodes, path);
  return decoder.decode(node.data);
}

function unsafeSnapshotReason(error: unknown): UnsafeStoreObservationReason | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "CELLARER_SNAPSHOT_SYMLINK") return "symbolic-link";
  if (
    code === "CELLARER_SNAPSHOT_NON_REGULAR" ||
    code === "CELLARER_SNAPSHOT_STALE" ||
    code === "CELLARER_SNAPSHOT_UNSUPPORTED" ||
    code === "CELLARER_SNAPSHOT_TIMEOUT" ||
    code === "CELLARER_SNAPSHOT_BUDGET_EXCEEDED"
  ) {
    return "unsafe-path";
  }
  return null;
}

function singleRegularFileNode(
  nodes: readonly FileTreeSnapshotNode[],
  path: string,
): FileTreeSnapshotNode & { readonly data: Uint8Array } {
  const node = nodes[0];
  if (
    nodes.length !== 1 ||
    node?.relativePath !== "" ||
    node.kind !== "file" ||
    node.data === undefined
  ) {
    throw new Error(`managed Store file observation is not one regular file: ${path}`);
  }
  return node as FileTreeSnapshotNode & { readonly data: Uint8Array };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
