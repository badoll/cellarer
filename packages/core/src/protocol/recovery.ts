import { join } from "node:path";
import type { Env, MutationAuthorityLease } from "../env.js";
import { emptyDirectoryFingerprint } from "../fs/hashDir.js";
import { assertSafeAtomicPublicationPath, isPathInside } from "../fs/safety.js";
import { keychainMetadataPath, serializeKeychainMetadata } from "../secrets/keychain-metadata.js";
import { cellarerSecretReference } from "../secrets/reference.js";
import { vaultPath } from "../secrets/vault.js";
import { sha256 } from "../store/checksum.js";
import { CONFIG_FILENAME } from "../store/config.js";
import {
  decryptTargetSnapshot,
  readAuthorizedEncryptedTargetSnapshot,
  restoreTargetSnapshot,
} from "../target-snapshot.js";
import {
  acquireCurrentMutationAuthorityLease,
  canonicalJson,
  withCurrentMutationAuthorityLease,
} from "./canonical.js";
import { targetState } from "./execute.js";
import {
  DEFAULT_OPERATION_RECEIPT_RETENTION,
  matchesProtectedJournalTip,
  publishOperationJournal,
  publishOperationReceipt,
  readOperationJournal,
  readOperationReceipt,
  removeOperationJournal,
} from "./journal.js";
import type {
  LockConflict,
  LockOwnerEvidence,
  ManualRecoveryRequiredConflict,
  OperationActionReceipt,
  OperationJournal,
  OperationReceipt,
  OperationResult,
  TargetStateReceipt,
} from "./models.js";
import {
  acquireStoreMutationLock,
  acquireStoreRecoveryLock,
  readStoreMutationLockOwner,
  readStoreRecoveryLockOwner,
  releaseStoreMutationLock,
  type StoreMutationLock,
} from "./mutation-lock.js";
import { PublicationPostconditionError, verifyFilePublication } from "./publication.js";
import { StoreMutationConflictError } from "./store-mutation.js";
import { publishStoreRevision, readStoreRevision } from "./store-revision.js";

export type MutationRecoveryStatus =
  | "clean"
  | "incomplete"
  | "completed-pending-cleanup"
  | "manual-recovery-required";

export interface MutationRecoveryDiagnosis {
  readonly status: MutationRecoveryStatus;
  readonly journal: OperationJournal | null;
  readonly lockOwner: LockOwnerEvidence | null;
  readonly recoveryLockOwner: LockOwnerEvidence | null;
  readonly receipt: OperationReceipt | null;
  readonly message: string;
}

export interface RecoverInterruptedOperationOptions {
  readonly operationId: string;
  readonly snapshotPassphrase?: string;
}

export interface OperationRecoveryRetentionOptions {
  readonly retainReceipts?: number;
  readonly pruneUnreferencedSnapshots?: boolean;
}

export interface OperationRecoveryRetentionResult {
  readonly removedReceiptIds: readonly string[];
  readonly removedSnapshotPaths: readonly string[];
  readonly receiptPruning: { readonly status: "unsupported"; readonly reason: string };
  readonly snapshotPruning:
    | { readonly status: "not-requested" }
    | { readonly status: "unsupported"; readonly reason: string };
}

interface RecoveryClaim {
  readonly lock: StoreMutationLock;
  readonly originalMutationOwner: LockOwnerEvidence | null;
}

type RecoveryClaimResult =
  | { readonly ok: true; readonly claim: RecoveryClaim }
  | { readonly ok: false; readonly conflict: LockConflict };

export async function diagnoseMutationRecovery(
  env: Env,
  storeRoot: string,
): Promise<MutationRecoveryDiagnosis> {
  return withCurrentMutationAuthorityLease(env, (authorityLease) =>
    diagnoseMutationRecoveryWithAuthorityLease(env, storeRoot, authorityLease),
  );
}

async function diagnoseMutationRecoveryWithAuthorityLease(
  env: Env,
  storeRoot: string,
  authorityLease: MutationAuthorityLease,
): Promise<MutationRecoveryDiagnosis> {
  if (!(await authorityLease.isCurrent().catch(() => false))) {
    throw new TypeError("mutation authority is not current");
  }
  const journalResult = await readOperationJournal(env, storeRoot).then(
    (journal) => ({ ok: true as const, journal }),
    () => ({ ok: false as const }),
  );
  if (!journalResult.ok) {
    return {
      status: "manual-recovery-required",
      journal: null,
      lockOwner: null,
      recoveryLockOwner: null,
      receipt: null,
      message: "durable operation journal is invalid and cannot authorize recovery",
    };
  }
  const journal = journalResult.journal;
  if (journal && !(await matchesProtectedJournalTip(env, journal))) {
    return {
      status: "manual-recovery-required",
      journal,
      lockOwner: null,
      recoveryLockOwner: null,
      receipt: null,
      message: "protected journal tip is missing, unavailable, or does not match exactly",
    };
  }
  const [lockOwner, recoveryLockOwner] = await Promise.all([
    readStoreMutationLockOwner(env, storeRoot),
    readStoreRecoveryLockOwner(env, storeRoot),
  ]);
  if (!journal && !lockOwner && !recoveryLockOwner) {
    return {
      status: "clean",
      journal: null,
      lockOwner: null,
      recoveryLockOwner: null,
      receipt: null,
      message: "no incomplete mutation operation",
    };
  }
  if (!journal) {
    return {
      status: "manual-recovery-required",
      journal: null,
      lockOwner,
      recoveryLockOwner,
      receipt: null,
      message: "mutation or recovery lock has no matching durable journal",
    };
  }
  if (!(await isDurableRecoveryAuthorized(env, storeRoot, journal))) {
    return {
      status: "manual-recovery-required",
      journal,
      lockOwner,
      recoveryLockOwner,
      receipt: null,
      message: "durable operation cannot be authorized from current trusted store state",
    };
  }
  const receipt = await readOperationReceipt(env, storeRoot, journal.operationId);
  if (
    receipt &&
    (journal.status !== "completed" ||
      !journal.completedReceipt ||
      canonicalJson(receipt) !== canonicalJson(journal.completedReceipt))
  ) {
    throw new Error("durable operation receipt does not match its operation journal");
  }
  if (recoveryLockOwner) {
    return {
      status: "manual-recovery-required",
      journal,
      lockOwner,
      recoveryLockOwner,
      receipt,
      message:
        "store recovery claim is held; recovery claims are never cleared by age and require operator inspection after a recovery crash",
    };
  }
  if (lockOwner && lockOwner.operationId !== journal.operationId) {
    return {
      status: "manual-recovery-required",
      journal,
      lockOwner,
      recoveryLockOwner: null,
      receipt,
      message: "mutation lock and journal identify different operations",
    };
  }
  if (
    !lockOwner &&
    (journal.status === "prepared" || journal.actions.some((action) => action.status === "pending"))
  ) {
    return {
      status: "manual-recovery-required",
      journal,
      lockOwner: null,
      recoveryLockOwner: null,
      receipt,
      message:
        "journal sequence is ambiguous without its matching mutation owner; automatic recovery is refused",
    };
  }
  if (journal.status === "completed") {
    return {
      status: "completed-pending-cleanup",
      journal,
      lockOwner,
      recoveryLockOwner: null,
      receipt,
      message: "completed operation needs durable cleanup",
    };
  }
  return {
    status: journal.status === "recovery-required" ? "manual-recovery-required" : "incomplete",
    journal,
    lockOwner,
    recoveryLockOwner: null,
    receipt,
    message: "incomplete mutation operation requires evidence-based recovery",
  };
}

async function isDurableRecoveryAuthorized(
  _env: Env,
  storeRoot: string,
  journal: OperationJournal,
): Promise<boolean> {
  const allowedByOperation: Record<OperationJournal["plan"]["operation"], readonly string[]> = {
    initialize: ["mkdir", "preserve-file", "publish-file"],
    apply: ["copy", "merge", "overwrite", "sync-gitignore", "symlink", "write"],
    revert: ["remove-target", "restore-snapshot", "sync-gitignore"],
    settings: ["publish-file"],
    "secret-metadata": ["keychain-secret-delete", "keychain-secret-set", "publish-file"],
    "store-import": [
      "add-mcp",
      "add-rules",
      "add-skill-provenance",
      "add-skills",
      "publish-file",
      "scan-mcp",
      "scan-rules",
      "scan-skills",
    ],
  };
  if (
    journal.plan.actions.some(
      (action) => !allowedByOperation[journal.plan.operation].includes(action.kind),
    ) ||
    (journal.statePublications ?? []).some(
      (publication) => !isPathInside(publication.path, storeRoot),
    )
  ) {
    return false;
  }
  if (journal.plan.operation === "store-import") {
    // Store imports currently have no durable provenance outside the journal that can prove the
    // originating add/scan request, selected target, or payload. A self-consistent journal is
    // integrity evidence only, so interrupted imports remain manual-only before recovery claims,
    // target observation, providers, or effects.
    return false;
  }
  if (journal.plan.operation === "settings") {
    return isSettingsRecoveryAuthorized(storeRoot, journal);
  }
  if (journal.plan.operation === "initialize") {
    return isInitializeRecoveryAuthorized(storeRoot, journal);
  }
  if (journal.plan.operation === "secret-metadata") {
    if (
      journal.plan.actions.some((action) =>
        ["keychain-secret-set", "keychain-secret-delete"].includes(action.kind),
      )
    ) {
      // A keychain journal contains only attacker-recomputable identities and digests. Until an
      // independent durable authority binds the originating provider mutation, it cannot authorize
      // claims, provider access, target observation, or recovery effects.
      return false;
    }
    return isSecretMetadataRecoveryAuthorized(storeRoot, journal);
  }
  // Apply/revert durable actions intentionally omit the executable payload and canonical options.
  // Their origin and helper derivation therefore cannot be independently proven after a crash.
  return false;
}

function isSettingsRecoveryAuthorized(storeRoot: string, journal: OperationJournal): boolean {
  const mutationKind = durableMutationKind(journal, [
    "collections",
    "defaults",
    "agent-enabled",
    "adapter-upsert",
    "adapter-delete",
  ]);
  const action = journal.plan.actions[0];
  const precondition = journal.plan.targetPreconditions[0];
  const post = action?.postcondition;
  if (
    !mutationKind ||
    (journal.statePublications?.length ?? 0) !== 0 ||
    journal.plan.actions.length !== 1 ||
    !action ||
    action.kind !== "publish-file" ||
    action.target !== join(storeRoot, CONFIG_FILENAME) ||
    !precondition ||
    precondition.expected.state !== "present" ||
    precondition.target !== action.target ||
    !post ||
    post.state !== "present"
  ) {
    return false;
  }
  const payload = { path: action.target, digest: post.fingerprint, mode: 0o600 };
  return (
    action.payloadDigest === sha256(canonicalJson(payload)) &&
    action.actionId ===
      recoveryPublicationActionId(mutationKind, action.target, post.fingerprint, 0o600, 0)
  );
}

function isInitializeRecoveryAuthorized(storeRoot: string, journal: OperationJournal): boolean {
  if (
    durableMutationKind(journal, ["initialize-store"]) !== "initialize-store" ||
    journal.plan.actions.length !== 5 ||
    (journal.statePublications?.length ?? 0) !== 0
  ) {
    return false;
  }
  const configPath = join(storeRoot, CONFIG_FILENAME);
  const configAction = journal.plan.actions[0];
  const configPrecondition = journal.plan.targetPreconditions[0];
  const configPostcondition = configAction?.postcondition;
  const configKind =
    configPrecondition?.expected.state === "absent" ? "publish-file" : "preserve-file";
  if (
    !configAction ||
    !configPrecondition ||
    configAction.kind !== configKind ||
    configAction.target !== configPath ||
    configPrecondition.target !== configPath ||
    !configPostcondition ||
    configPostcondition.state !== "present"
  ) {
    return false;
  }
  const configPayload = {
    path: configPath,
    digest: configPostcondition.fingerprint,
    mode: 0o600,
  };
  if (
    configAction.payloadDigest !== sha256(canonicalJson(configPayload)) ||
    configAction.actionId !==
      sha256(
        JSON.stringify({
          mutationKind: "initialize-store",
          index: 0,
          kind: configKind,
          path: configPath,
          digest: configPostcondition.fingerprint,
          mode: 0o600,
        }),
      )
  ) {
    return false;
  }
  const layoutPaths = [
    join(storeRoot, "store", "rules"),
    join(storeRoot, "store", "mcp"),
    join(storeRoot, "store", "skills"),
    join(storeRoot, "store", "metadata", "skills"),
  ];
  return layoutPaths.every((path, index) => {
    const action = journal.plan.actions[index + 1];
    const precondition = journal.plan.targetPreconditions[index + 1];
    const postcondition = action?.postcondition;
    if (
      !action ||
      !precondition ||
      action.kind !== "mkdir" ||
      action.target !== path ||
      precondition.target !== path ||
      !postcondition ||
      postcondition.state !== "present"
    ) {
      return false;
    }
    if (
      precondition.expected.state === "absent" &&
      postcondition.fingerprint !== emptyDirectoryFingerprint(0o700)
    ) {
      return false;
    }
    return (
      action.payloadDigest === sha256(canonicalJson({ path })) &&
      action.actionId ===
        sha256(
          JSON.stringify({
            mutationKind: "initialize-store",
            index: index + 1,
            kind: "mkdir",
            path,
          }),
        )
    );
  });
}

function isSecretMetadataRecoveryAuthorized(storeRoot: string, journal: OperationJournal): boolean {
  const mutationKind = durableMutationKind(journal, [
    "vault-secret-set",
    "vault-secret-delete",
    "keychain-secret-set",
    "keychain-secret-delete",
  ]);
  const action = journal.plan.actions[0];
  const precondition = journal.plan.targetPreconditions[0];
  const postcondition = action?.postcondition;
  if (
    !mutationKind ||
    journal.plan.actions.length !== 1 ||
    (journal.statePublications?.length ?? 0) !== 0 ||
    !action ||
    !precondition ||
    precondition.target !== action.target ||
    !postcondition ||
    postcondition.state !== "present"
  ) {
    return false;
  }
  if (mutationKind === "vault-secret-set" || mutationKind === "vault-secret-delete") {
    const target = vaultPath(storeRoot);
    const payload = {
      path: target,
      digest: postcondition.fingerprint,
      mode: 0o600,
      currentUserOnly: true,
    };
    return (
      action.kind === "publish-file" &&
      action.target === target &&
      action.payloadDigest === sha256(canonicalJson(payload)) &&
      action.actionId ===
        recoveryPublicationActionId(mutationKind, target, postcondition.fingerprint, 0o600, 0, true)
    );
  }
  const payload = action.payload;
  if (
    !hasExactRuntimeKeys(payload, ["name", "provider", "service"]) ||
    payload.provider !== "keychain" ||
    typeof payload.service !== "string" ||
    payload.service.length === 0 ||
    typeof payload.name !== "string"
  ) {
    return false;
  }
  try {
    cellarerSecretReference(payload.name);
  } catch {
    return false;
  }
  const operation = mutationKind === "keychain-secret-set" ? "set" : "delete";
  const target = keychainMetadataPath(storeRoot, payload.service, payload.name);
  const metadata = serializeKeychainMetadata(payload.service, payload.name, operation === "set");
  return (
    action.kind === `keychain-secret-${operation}` &&
    action.target === target &&
    action.payloadDigest === sha256(canonicalJson(payload)) &&
    postcondition.fingerprint === sha256(metadata) &&
    action.actionId ===
      sha256(
        JSON.stringify({
          kind: `keychain-secret-${operation}`,
          service: payload.service,
          name: payload.name,
        }),
      )
  );
}

function durableMutationKind(
  journal: OperationJournal,
  candidates: readonly string[],
): string | null {
  return (
    candidates.find(
      (candidate) =>
        journal.plan.normalizedInputsDigest === sha256(canonicalJson({ mutationKind: candidate })),
    ) ?? null
  );
}

function recoveryPublicationActionId(
  mutationKind: string,
  path: string,
  digest: string,
  mode: number,
  index: number,
  currentUserOnly = false,
): string {
  return sha256(
    JSON.stringify({
      mutationKind,
      index,
      kind: "publish-file",
      path,
      digest,
      mode,
      currentUserOnly,
    }),
  );
}

function hasExactRuntimeKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\u0000") === [...expectedKeys].sort().join("\u0000")
  );
}

export async function recoverInterruptedOperation(
  env: Env,
  storeRoot: string,
  opts: RecoverInterruptedOperationOptions,
): Promise<OperationResult> {
  const authorityLease = await acquireCurrentMutationAuthorityLease(env).catch(() => null);
  if (!authorityLease) {
    return manualRecovery(opts.operationId, [], "mutation authority is not current");
  }
  try {
    return await recoverInterruptedOperationWithProviderState(env, storeRoot, opts, authorityLease);
  } finally {
    await authorityLease.release();
  }
}

async function recoverInterruptedOperationWithProviderState(
  env: Env,
  storeRoot: string,
  opts: RecoverInterruptedOperationOptions,
  authorityLease: MutationAuthorityLease,
): Promise<OperationResult> {
  const diagnosis = await diagnoseMutationRecoveryWithAuthorityLease(
    env,
    storeRoot,
    authorityLease,
  );
  const journal = diagnosis.journal;
  if (!journal) {
    return manualRecovery(opts.operationId, [], diagnosis.message);
  }
  if (journal.operationId !== opts.operationId) {
    return manualRecovery(
      journal.operationId,
      journal.plan.actions.map((action) => action.target),
      `requested operation ${opts.operationId} does not match journal ${journal.operationId}`,
      journal,
    );
  }
  if (diagnosis.status === "manual-recovery-required") {
    return manualRecovery(journal.operationId, [], diagnosis.message);
  }
  const acquired = await acquireRecoveryClaim(env, storeRoot, journal, diagnosis);
  if (!acquired.ok) return { ok: false, conflict: acquired.conflict, journal };
  const claim = acquired.claim;
  if (!(await authorityLease.isCurrent().catch(() => false))) {
    await claim.lock.release();
    return manualRecovery(journal.operationId, [], "mutation authority is not current", journal);
  }

  // Once the claim is durable, re-read the authorization and durable result. A recovery that
  // throws unexpectedly intentionally leaves this claim behind so a later process cannot guess
  // whether mutation stopped before or after the failing effect.
  const claimedJournal = await readOperationJournal(env, storeRoot);
  if (!claimedJournal || claimedJournal.operationId !== journal.operationId) {
    throw new Error("operation journal changed while acquiring the recovery claim");
  }
  if (!(await matchesProtectedJournalTip(env, claimedJournal))) {
    await claim.lock.release();
    return manualRecovery(
      claimedJournal.operationId,
      [],
      "protected journal tip changed while acquiring the recovery claim",
      claimedJournal,
    );
  }
  const claimedReceipt = await readOperationReceipt(env, storeRoot, claimedJournal.operationId);
  let result: OperationResult;
  try {
    result = await recoverClaimedOperation(
      env,
      storeRoot,
      opts,
      claimedJournal,
      claimedReceipt,
      claim.originalMutationOwner,
    );
  } catch (error) {
    if (!(error instanceof PublicationPostconditionError)) throw error;
    let recoveryJournal = claimedJournal;
    if (claimedJournal.status !== "completed") {
      const recoveryRequired: OperationJournal = {
        ...claimedJournal,
        status: "recovery-required",
        updatedAt: env.now().toISOString(),
      };
      recoveryJournal = await publishOperationJournal(env, storeRoot, recoveryRequired).catch(
        () => claimedJournal,
      );
    }
    result = manualRecovery(
      claimedJournal.operationId,
      [error.path],
      "recovery protocol metadata publication did not match its signed digest or mode",
      recoveryJournal,
    );
  }
  await claim.lock.release();
  return result;
}

async function acquireRecoveryClaim(
  env: Env,
  storeRoot: string,
  journal: OperationJournal,
  diagnosis: MutationRecoveryDiagnosis,
): Promise<RecoveryClaimResult> {
  if (diagnosis.recoveryLockOwner) {
    return {
      ok: false,
      conflict: recoveryClaimConflict(diagnosis.recoveryLockOwner),
    };
  }
  if (diagnosis.lockOwner && diagnosis.lockOwner.operationId !== journal.operationId) {
    return {
      ok: false,
      conflict: mutationLockConflict(diagnosis.lockOwner),
    };
  }
  if (diagnosis.lockOwner && !(await isConfirmedDeadLocalOwner(env, diagnosis.lockOwner))) {
    return {
      ok: false,
      conflict: mutationLockConflict(diagnosis.lockOwner),
    };
  }

  const owner: LockOwnerEvidence = {
    operationId: `recovery-${env.randomId()}`,
    processId: env.processId(),
    hostname: env.hostname(),
    acquiredAt: env.now().toISOString(),
  };
  const acquired = diagnosis.lockOwner
    ? await acquireStoreRecoveryLock(env, storeRoot, owner)
    : await acquireStoreMutationLock(env, storeRoot, owner);
  if (!acquired.ok) return acquired;
  if (diagnosis.lockOwner) {
    const currentMutationOwner = await readStoreMutationLockOwner(env, storeRoot);
    if (!sameLockOwner(currentMutationOwner, diagnosis.lockOwner)) {
      await acquired.lock.release();
      return {
        ok: false,
        conflict: mutationLockConflict(currentMutationOwner ?? diagnosis.lockOwner),
      };
    }
  }
  return {
    ok: true,
    claim: {
      lock: acquired.lock,
      originalMutationOwner: diagnosis.lockOwner,
    },
  };
}

async function isConfirmedDeadLocalOwner(env: Env, owner: LockOwnerEvidence): Promise<boolean> {
  if (owner.hostname !== env.hostname()) return false;
  try {
    return (await env.probeProcessLiveness(owner.processId)) === "dead";
  } catch {
    return false;
  }
}

function sameLockOwner(left: LockOwnerEvidence | null, right: LockOwnerEvidence): boolean {
  return (
    left !== null &&
    left.operationId === right.operationId &&
    left.processId === right.processId &&
    left.hostname === right.hostname &&
    left.acquiredAt === right.acquiredAt
  );
}

function mutationLockConflict(owner: LockOwnerEvidence): LockConflict {
  return {
    code: "LOCK_CONFLICT",
    message: "store mutation lock is held",
    owner,
  };
}

function recoveryClaimConflict(owner: LockOwnerEvidence): LockConflict {
  return {
    code: "LOCK_CONFLICT",
    message: "store recovery claim is held",
    owner,
  };
}

async function recoverClaimedOperation(
  env: Env,
  storeRoot: string,
  opts: RecoverInterruptedOperationOptions,
  journal: OperationJournal,
  durableReceipt: OperationReceipt | null,
  originalMutationOwner: LockOwnerEvidence | null,
): Promise<OperationResult> {
  const currentRevision = await readStoreRevision(env, storeRoot);
  if (journal.status === "completed") {
    const receipt = durableReceipt ?? journal.completedReceipt;
    if (!receipt) {
      return manualRecovery(
        journal.operationId,
        journal.plan.actions.map((action) => action.target),
        "completed journal is missing its exact operation receipt",
        journal,
      );
    }
    if (currentRevision !== receipt.resultingRevision) {
      return manualRecovery(
        journal.operationId,
        journal.plan.actions.map((action) => action.target),
        "completed journal does not match the current store revision",
        journal,
      );
    }
    await publishOperationReceipt(env, storeRoot, receipt);
    await cleanupRecoveredOperation(env, storeRoot, journal, originalMutationOwner);
    return { ok: true, receipt };
  }

  const keychainActions = journal.plan.actions.filter((action) =>
    ["keychain-secret-set", "keychain-secret-delete"].includes(action.kind),
  );
  if (keychainActions.length > 0) {
    return persistManualRecovery(
      env,
      storeRoot,
      journal,
      keychainActions.map((action) => action.target),
      "keychain mutation outcome requires provider-specific manual reconciliation; prior provider values are never inferred or restored automatically",
    );
  }

  const observations = await Promise.all(
    journal.actions.map(async (action) => ({
      action,
      current: await targetState(env, action.target),
    })),
  );
  const everyAfterStateIsProven =
    journal.status === "publishing-state" &&
    journal.actions.length === journal.plan.actions.length &&
    journal.actions.every((action) => action.status === "succeeded") &&
    observations.every(
      ({ action, current }) =>
        action.status !== "pending" && sameTargetState(current, action.receipt.after),
    );

  if (
    everyAfterStateIsProven &&
    (currentRevision === journal.plan.baseRevision || currentRevision === journal.nextRevision)
  ) {
    for (const publication of journal.statePublications ?? []) {
      try {
        await assertSafeAtomicPublicationPath(
          env,
          publication.path,
          storeRoot,
          "recovery state publication",
        );
      } catch (error) {
        return persistManualRecovery(
          env,
          storeRoot,
          journal,
          [publication.path],
          error instanceof Error ? error.message : String(error),
        );
      }
      try {
        await verifyFilePublication(env, publication.path, publication.digest, publication.mode);
        await assertSafeAtomicPublicationPath(
          env,
          publication.path,
          storeRoot,
          "recovery state publication postcondition",
        );
      } catch {
        return persistManualRecovery(
          env,
          storeRoot,
          journal,
          [publication.path],
          "state publication is missing or does not match its durable digest; recovery will not reconstruct raw state by guessing",
        );
      }
    }
    if (currentRevision === journal.plan.baseRevision) {
      await publishStoreRevision(env, storeRoot, journal.nextRevision);
    }
    const receipt = buildReceipt(journal, "committed", journal.nextRevision, env.now());
    const completed = completedJournal(journal, receipt);
    const publishedCompleted = await publishOperationJournal(env, storeRoot, completed);
    await publishOperationReceipt(env, storeRoot, receipt);
    await cleanupRecoveredOperation(env, storeRoot, publishedCompleted, originalMutationOwner);
    return { ok: true, receipt };
  }

  if (currentRevision !== journal.plan.baseRevision) {
    return persistManualRecovery(
      env,
      storeRoot,
      journal,
      observations.map(({ action }) => action.target),
      "store revision no longer matches either safe recovery boundary",
    );
  }

  const manualTargets: string[] = [];
  for (const { action, current } of observations) {
    const before = beforeStateFor(journal, action.actionId);
    if (action.status === "pending") {
      if (!sameTargetState(current, before)) manualTargets.push(action.target);
      continue;
    }
    if (sameTargetState(current, before)) continue;
    if (!sameTargetState(current, action.receipt.after) || !isRestorable(before, opts)) {
      manualTargets.push(action.target);
    }
  }
  if (manualTargets.length > 0) {
    return persistManualRecovery(
      env,
      storeRoot,
      journal,
      manualTargets,
      "current target state matches neither a safe finalize path nor a provable compensation path",
    );
  }

  const compensatedReceipts: OperationActionReceipt[] = [];
  for (const { action } of [...observations].reverse()) {
    if (action.status === "pending") continue;
    const before = beforeStateFor(journal, action.actionId);
    const current = await targetState(env, action.target);
    if (!sameTargetState(current, before)) {
      if (!sameTargetState(current, action.receipt.after)) {
        return persistManualRecovery(
          env,
          storeRoot,
          journal,
          [action.target],
          "target changed after recovery observation; compensation was not attempted",
        );
      }
      try {
        await restoreBeforeState(env, storeRoot, action.target, before, action.receipt.after, opts);
      } catch (error) {
        return persistManualRecovery(
          env,
          storeRoot,
          journal,
          [action.target],
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const restored = await targetState(env, action.target);
    if (!sameTargetState(restored, before)) {
      return persistManualRecovery(
        env,
        storeRoot,
        journal,
        [action.target],
        "compensation did not restore the recorded before-state",
      );
    }
    compensatedReceipts.unshift({
      ...action.receipt,
      outcome: "compensated",
      after: before,
      recordedAt: env.now().toISOString(),
    });
  }

  const compensatedById = new Map(
    compensatedReceipts.map((action) => [action.actionId, action] as const),
  );
  const compensatedJournal: OperationJournal = {
    ...journal,
    actions: journal.actions.map((action) => {
      if (action.status === "pending") return action;
      const receipt = compensatedById.get(action.actionId);
      return receipt ? { ...action, status: "succeeded" as const, receipt } : action;
    }),
  };
  const completedAt = env.now();
  const receipt: OperationReceipt = {
    ...buildReceipt(
      compensatedJournal,
      "compensated",
      compensatedJournal.plan.baseRevision,
      completedAt,
    ),
    actionReceipts: compensatedReceipts,
  };
  const completed = completedJournal(compensatedJournal, receipt);
  const publishedCompleted = await publishOperationJournal(env, storeRoot, completed);
  await publishOperationReceipt(env, storeRoot, receipt);
  await cleanupRecoveredOperation(env, storeRoot, publishedCompleted, originalMutationOwner);
  return { ok: true, receipt };
}

export async function pruneOperationRecoveryArtifacts(
  env: Env,
  storeRoot: string,
  opts: OperationRecoveryRetentionOptions = {},
): Promise<OperationRecoveryRetentionResult> {
  return withCurrentMutationAuthorityLease(env, (authorityLease) =>
    pruneOperationRecoveryArtifactsWithAuthorityLease(env, storeRoot, opts, authorityLease),
  );
}

async function pruneOperationRecoveryArtifactsWithAuthorityLease(
  env: Env,
  storeRoot: string,
  opts: OperationRecoveryRetentionOptions,
  authorityLease: MutationAuthorityLease,
): Promise<OperationRecoveryRetentionResult> {
  if (!(await authorityLease.isCurrent().catch(() => false))) {
    throw new TypeError("mutation authority is not current");
  }
  const retainReceipts = opts.retainReceipts ?? DEFAULT_OPERATION_RECEIPT_RETENTION;
  if (!Number.isSafeInteger(retainReceipts) || retainReceipts < 0) {
    throw new TypeError(
      `receipt retention must be a non-negative safe integer, got ${retainReceipts}`,
    );
  }
  const recoveryOwner = await readStoreRecoveryLockOwner(env, storeRoot);
  if (recoveryOwner) throw new StoreMutationConflictError(recoveryClaimConflict(recoveryOwner));

  const owner: LockOwnerEvidence = {
    operationId: `retention-${env.randomId()}`,
    processId: env.processId(),
    hostname: env.hostname(),
    acquiredAt: env.now().toISOString(),
  };
  const acquired = await acquireStoreMutationLock(env, storeRoot, owner);
  if (!acquired.ok) throw new StoreMutationConflictError(acquired.conflict);
  try {
    const recoveryAfterAcquire = await readStoreRecoveryLockOwner(env, storeRoot);
    if (recoveryAfterAcquire) {
      throw new StoreMutationConflictError(recoveryClaimConflict(recoveryAfterAcquire));
    }
    const journal = await readOperationJournal(env, storeRoot);
    if (journal) {
      throw new StoreMutationConflictError({
        code: "INTERRUPTED_OPERATION",
        message: "an incomplete operation requires recovery before retention",
        operationId: journal.operationId,
        journalStatus: journal.status,
      });
    }

    // Node's current fs/Env surface cannot bind directory identity to a no-follow unlink. Keep
    // every receipt and encrypted snapshot rather than presenting check-then-delete as atomic.
    const unsupportedReason =
      "automatic deletion is disabled because directory-identity no-follow deletion is unavailable";
    return {
      removedReceiptIds: [],
      removedSnapshotPaths: [],
      receiptPruning: { status: "unsupported", reason: unsupportedReason },
      snapshotPruning: opts.pruneUnreferencedSnapshots
        ? {
            status: "unsupported",
            reason: unsupportedReason,
          }
        : { status: "not-requested" },
    };
  } finally {
    await acquired.lock.release();
  }
}

async function restoreBeforeState(
  env: Env,
  storeRoot: string,
  target: string,
  before: TargetStateReceipt,
  after: TargetStateReceipt,
  opts: RecoverInterruptedOperationOptions,
): Promise<void> {
  const current = await targetState(env, target);
  if (!sameTargetState(current, after)) {
    throw new RecoveryTargetChangedError(target);
  }
  if (before.state === "absent") {
    await env.fs.rm(target, { recursive: true, force: true });
    return;
  }
  if (
    !before.recoverySnapshot ||
    !before.recoverySnapshotDigest ||
    before.recoverySnapshotMode === undefined ||
    !opts.snapshotPassphrase
  ) {
    throw new Error(`target ${target} has no authorized recovery snapshot`);
  }
  const snapshot = await decryptTargetSnapshot(
    await readAuthorizedEncryptedTargetSnapshot(env, storeRoot, {
      path: before.recoverySnapshot,
      digest: before.recoverySnapshotDigest,
      mode: before.recoverySnapshotMode,
    }),
    opts.snapshotPassphrase,
  );
  await restoreTargetSnapshot(
    env,
    target,
    snapshot,
    after.state === "absent" ? null : after.fingerprint,
  );
}

class RecoveryTargetChangedError extends Error {
  constructor(target: string) {
    super(`target ${target} changed at the final compensation boundary`);
    this.name = "RecoveryTargetChangedError";
  }
}

function isRestorable(
  before: TargetStateReceipt,
  opts: RecoverInterruptedOperationOptions,
): boolean {
  return (
    before.state === "absent" ||
    Boolean(
      before.recoverySnapshot &&
        before.recoverySnapshotDigest &&
        before.recoverySnapshotMode !== undefined &&
        opts.snapshotPassphrase,
    )
  );
}

function beforeStateFor(journal: OperationJournal, actionId: string): TargetStateReceipt {
  const before = journal.plan.targetPreconditions.find(
    (precondition) => precondition.actionId === actionId,
  )?.expected;
  if (!before) throw new Error(`journal action ${actionId} has no target precondition`);
  const action = journal.actions.find((candidate) => candidate.actionId === actionId);
  if (action && action.status !== "pending" && action.receipt.before.state === "present") {
    return action.receipt.before;
  }
  return before;
}

async function persistManualRecovery(
  env: Env,
  storeRoot: string,
  journal: OperationJournal,
  targets: readonly string[],
  guidance: string,
): Promise<OperationResult> {
  const recoveryRequired: OperationJournal = {
    ...journal,
    status: "recovery-required",
    updatedAt: env.now().toISOString(),
  };
  const publishedRecoveryRequired = await publishOperationJournal(env, storeRoot, recoveryRequired);
  return manualRecovery(journal.operationId, targets, guidance, publishedRecoveryRequired);
}

function manualRecovery(
  operationId: string,
  targets: readonly string[],
  guidance: string,
  journal?: OperationJournal,
): OperationResult {
  const conflict: ManualRecoveryRequiredConflict = {
    code: "MANUAL_RECOVERY_REQUIRED",
    message: "manual recovery is required",
    operationId,
    targets: [...new Set(targets)],
    guidance,
  };
  return { ok: false, conflict, ...(journal ? { journal } : {}) };
}

function buildReceipt(
  journal: OperationJournal,
  outcome: OperationReceipt["outcome"],
  resultingRevision: number,
  completedAt: Date,
): OperationReceipt {
  return {
    schemaVersion: 1,
    operationId: journal.operationId,
    planId: journal.plan.planId,
    planDigest: journal.plan.digest,
    operation: journal.plan.operation,
    baseRevision: journal.plan.baseRevision,
    resultingRevision,
    outcome,
    actionReceipts: journal.actions.flatMap((action) =>
      action.status === "pending" ? [] : [action.receipt],
    ),
    startedAt: journal.startedAt,
    completedAt: completedAt.toISOString(),
  };
}

function completedJournal(journal: OperationJournal, receipt: OperationReceipt): OperationJournal {
  return {
    ...journal,
    status: "completed",
    updatedAt: receipt.completedAt,
    completedReceipt: receipt,
  };
}

async function cleanupRecoveredOperation(
  env: Env,
  storeRoot: string,
  journal: OperationJournal,
  lockOwner: LockOwnerEvidence | null,
): Promise<void> {
  if (lockOwner) await releaseStoreMutationLock(env, storeRoot, lockOwner);
  const current = await readOperationJournal(env, storeRoot);
  if (current && current.operationId !== journal.operationId) {
    throw new Error("operation journal changed before recovery cleanup");
  }
  await removeOperationJournal(env, storeRoot);
}

function sameTargetState(left: TargetStateReceipt, right: TargetStateReceipt): boolean {
  return (
    left.state === right.state &&
    (left.state === "absent" ||
      (right.state === "present" && left.fingerprint === right.fingerprint))
  );
}
