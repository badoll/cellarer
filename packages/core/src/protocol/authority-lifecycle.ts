import type { Env } from "../env.js";
import { operationJournalPath } from "./journal.js";
import { acquireStoreMutationLock, readStoreRecoveryLockOwner } from "./mutation-lock.js";

export type MutationAuthorityRotationFailure =
  | "active-journal"
  | "mutation-active"
  | "recovery-active"
  | "safety-check-failed";

export class MutationAuthorityRotationError extends Error {
  readonly code = "MUTATION_AUTHORITY_ROTATION_FAILURE" as const;

  constructor(readonly failure: MutationAuthorityRotationFailure) {
    super(rotationFailureMessage(failure));
    this.name = "MutationAuthorityRotationError";
  }
}

function rotationFailureMessage(failure: MutationAuthorityRotationFailure): string {
  switch (failure) {
    case "active-journal":
      return "mutation authority rotation refused while an active operation journal exists";
    case "mutation-active":
      return "mutation authority rotation refused while a mutation is active";
    case "recovery-active":
      return "mutation authority rotation refused while recovery is active";
    case "safety-check-failed":
      return "mutation authority rotation safety check failed";
  }
}

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
      throw new MutationAuthorityRotationError("safety-check-failed");
    });
  if (exists) {
    throw new MutationAuthorityRotationError("active-journal");
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
    throw new MutationAuthorityRotationError("mutation-active");
  }
  try {
    if (await readStoreRecoveryLockOwner(env, storeRoot)) {
      throw new MutationAuthorityRotationError("recovery-active");
    }
    await assertMutationAuthorityRotationAllowed(env, storeRoot);
    return await rotate();
  } finally {
    await acquired.lock.release();
  }
}
