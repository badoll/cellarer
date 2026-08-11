import { join } from "node:path";
import type { Env } from "../env.js";
import { readFileOrNull } from "../fs/probe.js";
import { CONFIG_FILENAME, loadConfig } from "../store/config.js";
import { loadLedger } from "../store/ledger.js";
import { requireMutationAuthority } from "./canonical.js";
import { readStoreMutationLockOwner, readStoreRecoveryLockOwner } from "./mutation-lock.js";
import { diagnoseMutationRecovery } from "./recovery.js";
import { readStoreRevision } from "./store-revision.js";

export type ClientReadinessBlocker =
  | { readonly code: "STORE_NOT_READY" }
  | { readonly code: "MUTATION_AUTHORITY_UNAVAILABLE" }
  | { readonly code: "MUTATION_AUTHORITY_NOT_CURRENT" }
  | { readonly code: "MUTATION_LOCKED"; readonly operationId: string }
  | { readonly code: "RECOVERY_REQUIRED"; readonly operationId?: string };

export interface ClientReadiness {
  readonly ready: boolean;
  readonly blockers: readonly ClientReadinessBlocker[];
}

export async function getClientReadiness(env: Env, storeRoot: string): Promise<ClientReadiness> {
  const blockers: ClientReadinessBlocker[] = [];
  let storeReady = false;
  try {
    const configText = await readFileOrNull(env, join(storeRoot, CONFIG_FILENAME));
    if (configText !== null) {
      await Promise.all([
        loadConfig(env, storeRoot),
        loadLedger(env, storeRoot),
        readStoreRevision(env, storeRoot),
      ]);
      storeReady = true;
    }
  } catch {
    storeReady = false;
  }
  if (!storeReady) blockers.push({ code: "STORE_NOT_READY" });

  let authorityCurrent = false;
  try {
    const authority = requireMutationAuthority(env);
    authorityCurrent = await authority.isCurrent().catch(() => false);
    if (!authorityCurrent) blockers.push({ code: "MUTATION_AUTHORITY_NOT_CURRENT" });
  } catch {
    blockers.push({ code: "MUTATION_AUTHORITY_UNAVAILABLE" });
  }

  const [mutationLockOwner, recoveryLockOwner] = await Promise.all([
    readStoreMutationLockOwner(env, storeRoot),
    readStoreRecoveryLockOwner(env, storeRoot),
  ]);
  if (mutationLockOwner) {
    blockers.push({ code: "MUTATION_LOCKED", operationId: mutationLockOwner.operationId });
  }
  if (recoveryLockOwner) {
    blockers.push({ code: "RECOVERY_REQUIRED", operationId: recoveryLockOwner.operationId });
  }

  if (authorityCurrent && !mutationLockOwner && !recoveryLockOwner && storeReady) {
    try {
      const recovery = await diagnoseMutationRecovery(env, storeRoot);
      if (recovery.status !== "clean") {
        const operationId =
          recovery.journal?.operationId ?? recovery.receipt?.operationId ?? undefined;
        blockers.push({
          code: "RECOVERY_REQUIRED",
          ...(operationId ? { operationId } : {}),
        });
      }
    } catch {
      blockers.push({ code: "RECOVERY_REQUIRED" });
    }
  }

  return { ready: blockers.length === 0, blockers };
}
