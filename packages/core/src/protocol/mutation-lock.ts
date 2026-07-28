import { join } from "node:path";
import type { Env } from "../env.js";
import type { LockConflict, LockOwnerEvidence } from "./models.js";

export interface StoreMutationLock {
  readonly path: string;
  readonly owner: LockOwnerEvidence;
  release(): Promise<void>;
}

export type StoreMutationLockResult =
  | { readonly ok: true; readonly lock: StoreMutationLock }
  | { readonly ok: false; readonly conflict: LockConflict };

export function mutationLockPath(storeRoot: string): string {
  return join(storeRoot, "mutation.lock");
}

export function recoveryLockPath(storeRoot: string): string {
  return join(storeRoot, "recovery.lock");
}

export async function acquireStoreMutationLock(
  env: Env,
  storeRoot: string,
  owner: LockOwnerEvidence,
): Promise<StoreMutationLockResult> {
  return acquireEvidenceLock(
    env,
    mutationLockPath(storeRoot),
    owner,
    "store mutation lock is held",
    "mutation lock",
  );
}

export async function acquireStoreRecoveryLock(
  env: Env,
  storeRoot: string,
  owner: LockOwnerEvidence,
): Promise<StoreMutationLockResult> {
  // A recovery claim may have stopped between destructive effects. Unlike a matching mutation
  // owner, it is never considered abandoned automatically; operator inspection must clear it.
  return acquireEvidenceLock(
    env,
    recoveryLockPath(storeRoot),
    owner,
    "store recovery claim is held",
    "recovery claim",
  );
}

async function acquireEvidenceLock(
  env: Env,
  path: string,
  owner: LockOwnerEvidence,
  conflictMessage: string,
  label: string,
): Promise<StoreMutationLockResult> {
  const encodedOwner = `${JSON.stringify(owner)}\n`;
  const acquired = await env.fs.writeFileExclusive(path, encodedOwner, { mode: 0o600 });
  if (!acquired) {
    const activeOwner = parseOwnerEvidence(await env.fs.readFile(path), path, label);
    return {
      ok: false,
      conflict: {
        code: "LOCK_CONFLICT",
        message: conflictMessage,
        owner: activeOwner,
      },
    };
  }

  let released = false;
  return {
    ok: true,
    lock: {
      path,
      owner,
      release: async () => {
        if (released) return;
        await releaseEvidenceLock(env, path, owner, label);
        released = true;
      },
    },
  };
}

export async function readStoreMutationLockOwner(
  env: Env,
  storeRoot: string,
): Promise<LockOwnerEvidence | null> {
  return readEvidenceLockOwner(env, mutationLockPath(storeRoot), "mutation lock");
}

export async function readStoreRecoveryLockOwner(
  env: Env,
  storeRoot: string,
): Promise<LockOwnerEvidence | null> {
  return readEvidenceLockOwner(env, recoveryLockPath(storeRoot), "recovery claim");
}

async function readEvidenceLockOwner(
  env: Env,
  path: string,
  label: string,
): Promise<LockOwnerEvidence | null> {
  const text = await env.fs.readFile(path).catch((error: unknown) => {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  });
  return text === null ? null : parseOwnerEvidence(text, path, label);
}

export async function releaseStoreMutationLock(
  env: Env,
  storeRoot: string,
  owner: LockOwnerEvidence,
): Promise<void> {
  await releaseEvidenceLock(env, mutationLockPath(storeRoot), owner, "mutation lock");
}

export async function releaseStoreRecoveryLock(
  env: Env,
  storeRoot: string,
  owner: LockOwnerEvidence,
): Promise<void> {
  await releaseEvidenceLock(env, recoveryLockPath(storeRoot), owner, "recovery claim");
}

async function releaseEvidenceLock(
  env: Env,
  path: string,
  owner: LockOwnerEvidence,
  label: string,
): Promise<void> {
  const current = await env.fs.readFile(path).catch((error: unknown) => {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  });
  if (current === null) return;
  const encodedOwner = `${JSON.stringify(owner)}\n`;
  if (current !== encodedOwner) {
    throw new Error(`${label} owner changed before release at ${path}`);
  }
  await env.fs.rm(path);
}

function parseOwnerEvidence(text: string, path: string, label: string): LockOwnerEvidence {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} at ${path} has invalid owner evidence; inspect it before recovery`);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as LockOwnerEvidence).operationId !== "string" ||
    !Number.isInteger((value as LockOwnerEvidence).processId) ||
    typeof (value as LockOwnerEvidence).hostname !== "string" ||
    typeof (value as LockOwnerEvidence).acquiredAt !== "string"
  ) {
    throw new Error(`${label} at ${path} has invalid owner evidence; inspect it before recovery`);
  }
  return value as LockOwnerEvidence;
}
