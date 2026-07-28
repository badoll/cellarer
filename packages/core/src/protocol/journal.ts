import { join } from "node:path";
import type { Env } from "../env.js";
import { assertSafeAtomicPublicationPath } from "../fs/safety.js";
import {
  assertSupportedMutationPlanRuntime,
  canonicalJson,
  verifyDurableMutationPlanDigest,
} from "./canonical.js";
import type { OperationJournal, OperationReceipt } from "./models.js";
import { publishVerifiedStoreFile, verifyAbsentPublication } from "./publication.js";

const OPERATIONS_DIRECTORY = "operations";
const ACTIVE_JOURNAL = "active.json";
const RECEIPTS_DIRECTORY = "receipts";

export const DEFAULT_OPERATION_RECEIPT_RETENTION = 100;

export function operationJournalPath(storeRoot: string): string {
  return join(storeRoot, OPERATIONS_DIRECTORY, ACTIVE_JOURNAL);
}

export function operationReceiptsPath(storeRoot: string): string {
  return join(storeRoot, OPERATIONS_DIRECTORY, RECEIPTS_DIRECTORY);
}

export function operationReceiptPath(storeRoot: string, operationId: string): string {
  assertSafeOperationId(operationId);
  return join(operationReceiptsPath(storeRoot), `${operationId}.json`);
}

export async function readOperationJournal(
  env: Env,
  storeRoot: string,
): Promise<OperationJournal | null> {
  const path = operationJournalPath(storeRoot);
  const text = await readFileOrNull(env, path);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    assertOperationJournal(value);
    return value;
  } catch (error) {
    throw new Error(
      `corrupt operation journal at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function publishOperationJournal(
  env: Env,
  storeRoot: string,
  journal: OperationJournal,
): Promise<void> {
  assertOperationJournal(journal);
  const path = operationJournalPath(storeRoot);
  await publishVerifiedStoreFile(
    env,
    storeRoot,
    path,
    `${JSON.stringify(journal, null, 2)}\n`,
    0o600,
    "operation journal",
  );
}

export async function removeOperationJournal(env: Env, storeRoot: string): Promise<void> {
  const path = operationJournalPath(storeRoot);
  await assertSafeAtomicPublicationPath(env, path, storeRoot, "operation journal removal");
  await env.fs.rm(path, { force: true });
  await verifyAbsentPublication(env, path);
}

export async function readOperationReceipt(
  env: Env,
  storeRoot: string,
  operationId: string,
): Promise<OperationReceipt | null> {
  const path = operationReceiptPath(storeRoot, operationId);
  const text = await readFileOrNull(env, path);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    assertOperationReceipt(value);
    return value;
  } catch (error) {
    throw new Error(
      `corrupt operation receipt at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function publishOperationReceipt(
  env: Env,
  storeRoot: string,
  receipt: OperationReceipt,
): Promise<void> {
  assertOperationReceipt(receipt);
  const path = operationReceiptPath(storeRoot, receipt.operationId);
  await publishVerifiedStoreFile(
    env,
    storeRoot,
    path,
    `${JSON.stringify(receipt, null, 2)}\n`,
    0o600,
    "operation receipt",
  );
}

export async function listOperationReceipts(
  env: Env,
  storeRoot: string,
): Promise<OperationReceipt[]> {
  const directory = operationReceiptsPath(storeRoot);
  const names = await env.fs.readdir(directory).catch((error: unknown) => {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  });
  const receipts: OperationReceipt[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const operationId = name.slice(0, -".json".length);
    const receipt = await readOperationReceipt(env, storeRoot, operationId);
    if (receipt) receipts.push(receipt);
  }
  return receipts.sort(
    (left, right) =>
      Date.parse(right.completedAt) - Date.parse(left.completedAt) ||
      right.operationId.localeCompare(left.operationId),
  );
}

async function readFileOrNull(env: Env, path: string): Promise<string | null> {
  return env.fs.readFile(path).catch((error: unknown) => {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  });
}

function assertSafeOperationId(operationId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(operationId)) {
    throw new TypeError(`unsafe operation id: ${JSON.stringify(operationId)}`);
  }
}

function assertOperationJournal(value: unknown): asserts value is OperationJournal {
  const journal = value as OperationJournal;
  if (
    typeof value !== "object" ||
    value === null ||
    journal.schemaVersion !== 1 ||
    typeof journal.operationId !== "string" ||
    typeof journal.plan !== "object" ||
    journal.plan === null ||
    !Number.isSafeInteger(journal.nextRevision) ||
    journal.nextRevision < 0 ||
    !["prepared", "executing", "publishing-state", "completed", "recovery-required"].includes(
      journal.status,
    ) ||
    Number.isNaN(Date.parse(journal.startedAt)) ||
    Number.isNaN(Date.parse(journal.updatedAt)) ||
    !Array.isArray(journal.actions)
  ) {
    throw new Error("invalid operation journal");
  }
  assertSafeOperationId(journal.operationId);
  assertSupportedMutationPlanRuntime(journal.plan);
  if (!verifyDurableMutationPlanDigest(journal.plan)) {
    throw new Error("operation journal durable plan digest is invalid");
  }
  if (journal.nextRevision !== journal.plan.baseRevision + 1) {
    throw new Error("operation journal next revision does not follow its signed plan");
  }
  const planActionIds = new Set(journal.plan.actions.map((action) => action.actionId));
  const preconditions = new Map(
    journal.plan.targetPreconditions.map((precondition) => [precondition.actionId, precondition]),
  );
  if (
    planActionIds.size !== journal.plan.actions.length ||
    preconditions.size !== journal.plan.targetPreconditions.length ||
    journal.plan.actions.length !== journal.plan.targetPreconditions.length ||
    journal.actions.length !== journal.plan.actions.length
  ) {
    throw new Error("operation journal plan evidence is not one-to-one");
  }

  for (const [index, action] of journal.actions.entries()) {
    const planned = journal.plan.actions[index];
    const precondition = planned ? preconditions.get(planned.actionId) : undefined;
    if (
      typeof action !== "object" ||
      action === null ||
      typeof action.actionId !== "string" ||
      typeof action.target !== "string" ||
      !["pending", "succeeded", "failed"].includes(action.status)
    ) {
      throw new Error("invalid operation journal action");
    }
    if (
      !planned ||
      !precondition ||
      action.actionId !== planned.actionId ||
      action.target !== planned.target ||
      precondition.target !== planned.target
    ) {
      throw new Error("operation journal action is not authorized by its signed plan");
    }
    if (planned.postcondition !== undefined && !isTargetStateReceipt(planned.postcondition)) {
      throw new Error("operation journal action has an invalid signed postcondition");
    }
    if (action.status !== "pending") {
      assertOperationActionReceipt(action.receipt);
      if (action.receipt.actionId !== action.actionId || action.receipt.target !== action.target) {
        throw new Error("operation journal action receipt does not match its action");
      }
      if (!sameAuthorizedBeforeState(precondition.expected, action.receipt.before)) {
        throw new Error("operation journal action before-state does not match its precondition");
      }
      if (
        action.status === "succeeded" &&
        planned.postcondition !== undefined &&
        !sameTargetState(planned.postcondition, action.receipt.after)
      ) {
        throw new Error(
          "operation journal action after-state does not match its signed postcondition",
        );
      }
    }
  }
  if (journal.statePublications !== undefined) {
    if (
      !Array.isArray(journal.statePublications) ||
      journal.statePublications.some(
        (publication) =>
          typeof publication.path !== "string" ||
          typeof publication.digest !== "string" ||
          (publication.mode !== undefined && !Number.isInteger(publication.mode)),
      )
    ) {
      throw new Error("invalid journal state publication");
    }
  }
  if (journal.status === "completed" && journal.completedReceipt === undefined) {
    throw new Error("completed operation journal is missing its exact receipt");
  }
  if (journal.status !== "completed" && journal.completedReceipt !== undefined) {
    throw new Error("incomplete operation journal contains a completed receipt");
  }
  if (journal.completedReceipt !== undefined) {
    assertOperationReceipt(journal.completedReceipt);
    const receipt = journal.completedReceipt;
    const journalReceipts = journal.actions.flatMap((action) =>
      action.status === "pending" ? [] : [action.receipt],
    );
    const expectedRevision =
      receipt.outcome === "committed" ? journal.nextRevision : journal.plan.baseRevision;
    if (
      receipt.operationId !== journal.operationId ||
      receipt.planId !== journal.plan.planId ||
      receipt.planDigest !== journal.plan.digest ||
      receipt.operation !== journal.plan.operation ||
      receipt.baseRevision !== journal.plan.baseRevision ||
      receipt.resultingRevision !== expectedRevision ||
      receipt.startedAt !== journal.startedAt ||
      receipt.completedAt !== journal.updatedAt ||
      canonicalJson(receipt.actionReceipts) !== canonicalJson(journalReceipts)
    ) {
      throw new Error("completed receipt does not match its operation journal");
    }
  }
}

function sameAuthorizedBeforeState(
  expected: OperationJournal["plan"]["targetPreconditions"][number]["expected"],
  actual: OperationReceipt["actionReceipts"][number]["before"],
): boolean {
  if (expected.state !== actual.state) return false;
  if (expected.state === "absent") return true;
  if (actual.state !== "present" || expected.fingerprint !== actual.fingerprint) return false;
  return (
    (expected.recoverySnapshot === undefined ||
      expected.recoverySnapshot === actual.recoverySnapshot) &&
    (expected.recoverySnapshotDigest === undefined ||
      expected.recoverySnapshotDigest === actual.recoverySnapshotDigest) &&
    (expected.recoverySnapshotMode === undefined ||
      expected.recoverySnapshotMode === actual.recoverySnapshotMode)
  );
}

function sameTargetState(
  expected: OperationJournal["plan"]["actions"][number]["postcondition"],
  actual: OperationReceipt["actionReceipts"][number]["after"],
): boolean {
  if (!expected || expected.state !== actual.state) return false;
  return (
    expected.state === "absent" ||
    (actual.state === "present" && expected.fingerprint === actual.fingerprint)
  );
}

function assertOperationActionReceipt(value: OperationReceipt["actionReceipts"][number]): void {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.actionId !== "string" ||
    typeof value.target !== "string" ||
    !["applied", "unchanged", "compensated", "failed"].includes(value.outcome) ||
    !isTargetStateReceipt(value.before) ||
    !isTargetStateReceipt(value.after) ||
    Number.isNaN(Date.parse(value.recordedAt))
  ) {
    throw new Error("invalid operation action receipt");
  }
}

function isTargetStateReceipt(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const state = value as {
    state?: unknown;
    fingerprint?: unknown;
    recoverySnapshot?: unknown;
    recoverySnapshotDigest?: unknown;
    recoverySnapshotMode?: unknown;
  };
  if (state.state === "absent") return true;
  const hasSnapshot = state.recoverySnapshot !== undefined;
  return (
    state.state === "present" &&
    typeof state.fingerprint === "string" &&
    (hasSnapshot
      ? typeof state.recoverySnapshot === "string" &&
        typeof state.recoverySnapshotDigest === "string" &&
        Number.isInteger(state.recoverySnapshotMode)
      : state.recoverySnapshotDigest === undefined && state.recoverySnapshotMode === undefined)
  );
}

function assertOperationReceipt(value: unknown): asserts value is OperationReceipt {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as OperationReceipt).schemaVersion !== 1 ||
    typeof (value as OperationReceipt).operationId !== "string" ||
    typeof (value as OperationReceipt).planId !== "string" ||
    typeof (value as OperationReceipt).planDigest !== "string" ||
    !Number.isSafeInteger((value as OperationReceipt).baseRevision) ||
    !Number.isSafeInteger((value as OperationReceipt).resultingRevision) ||
    !["committed", "compensated", "manual-recovery-required"].includes(
      (value as OperationReceipt).outcome,
    ) ||
    !Array.isArray((value as OperationReceipt).actionReceipts) ||
    (value as OperationReceipt).actionReceipts.some((receipt) => {
      try {
        assertOperationActionReceipt(receipt);
        return false;
      } catch {
        return true;
      }
    }) ||
    Number.isNaN(Date.parse((value as OperationReceipt).startedAt)) ||
    Number.isNaN(Date.parse((value as OperationReceipt).completedAt))
  ) {
    throw new Error("invalid operation receipt");
  }
  assertSafeOperationId((value as OperationReceipt).operationId);
}
