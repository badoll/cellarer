import type { Env } from "../env.js";
import { operationJournalPath } from "./journal.js";
import { acquireStoreMutationLock, readStoreRecoveryLockOwner } from "./mutation-lock.js";

// Rotation is a composition-level credential operation, but the decision whether it is safe is
// Core policy. Any active-journal entry (including malformed or unsigned bytes) blocks rotation:
// changing the authority first would strand evidence that still requires the current capability.
export async function assertMutationAuthorityRotationAllowed(
  env: Env,
  storeRoot: string,
): Promise<void> {
  const path = operationJournalPath(storeRoot);
  const exists = await env.fs
    .lstat(path)
    .then(() => true)
    .catch((error: unknown) => {
      if ((error as { code?: string }).code === "ENOENT") return false;
      throw new Error("mutation authority rotation safety check failed");
    });
  if (exists) {
    throw new Error("mutation authority rotation refused while an active operation journal exists");
  }
}

export async function withMutationAuthorityRotationExclusion<T>(
  env: Env,
  storeRoot: string,
  rotate: () => Promise<T>,
): Promise<T> {
  const owner = {
    operationId: `authority-rotation-${env.randomId()}`,
    processId: env.processId(),
    hostname: env.hostname(),
    acquiredAt: env.now().toISOString(),
  };
  const acquired = await acquireStoreMutationLock(env, storeRoot, owner);
  if (!acquired.ok) {
    throw new Error("mutation authority rotation refused while a mutation is active");
  }
  try {
    if (await readStoreRecoveryLockOwner(env, storeRoot)) {
      throw new Error("mutation authority rotation refused while recovery is active");
    }
    await assertMutationAuthorityRotationAllowed(env, storeRoot);
    return await rotate();
  } finally {
    await acquired.lock.release();
  }
}
