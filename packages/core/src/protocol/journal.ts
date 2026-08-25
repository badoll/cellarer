import { join, resolve } from "node:path";
import type { Env, ProtectedJournalTip } from "../env.js";
import { assertSafeAtomicPublicationPath } from "../fs/safety.js";
import {
  observableOptionsForEnv,
  registerObservableMutationAuthorization,
  serializeObservable,
} from "../secrets/observable.js";
import { sha256 } from "../store/checksum.js";
import {
  assertSupportedMutationPlanRuntime,
  canonicalJson,
  isStrictMutationAuthorizationEnvelope,
  MUTATION_ACTION_KINDS,
  MUTATION_OPERATIONS,
  requireMutationAuthority,
  verifyDurableMutationPlanAuthorization,
  verifyDurableMutationPlanDigest,
} from "./canonical.js";
import type { OperationJournal, OperationReceipt } from "./models.js";
import { MUTATION_AUTHORIZATION_SCHEMA_VERSION, OPERATION_JOURNAL_DOMAIN } from "./models.js";
import { publishVerifiedStoreFile, verifyAbsentPublication } from "./publication.js";

const OPERATIONS_DIRECTORY = "operations";
const ACTIVE_JOURNAL = "active.json";
const RECEIPTS_DIRECTORY = "receipts";

export const DEFAULT_OPERATION_RECEIPT_RETENTION = 100;

export type OperationJournalInput = Omit<
  OperationJournal,
  "authorization" | "previousJournalSeal" | "sequence"
> &
  Partial<Pick<OperationJournal, "authorization" | "previousJournalSeal" | "sequence">>;

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
    assertOperationJournal(env, storeRoot, value);
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
  journal: OperationJournalInput,
): Promise<OperationJournal> {
  const sealedJournal = sealNextOperationJournal(env, storeRoot, journal);
  assertOperationJournal(env, storeRoot, sealedJournal);
  const path = operationJournalPath(storeRoot);
  const serialized = serializeAuthorizedOperationJournal(sealedJournal, {
    ...observableOptionsForEnv(env),
    pretty: true,
  });
  const published: unknown = JSON.parse(serialized);
  assertOperationJournal(env, storeRoot, published);
  await publishVerifiedStoreFile(
    env,
    storeRoot,
    path,
    `${serialized}\n`,
    0o600,
    "operation journal",
  );
  const authority = requireMutationAuthority(env);
  await authority.publishJournalTip(operationJournalTip(sealedJournal)).catch(() => {
    throw new Error("protected journal tip publication failed");
  });
  return sealedJournal;
}

function serializeAuthorizedOperationJournal(
  journal: OperationJournal,
  options: ReturnType<typeof observableOptionsForEnv> & { readonly pretty: true },
): string {
  return serializeObservable("journal", journal, {
    ...options,
    protocolShape: "operation-journal",
  });
}

export function operationJournalTip(journal: OperationJournal): ProtectedJournalTip {
  return {
    operationId: journal.operationId,
    sequence: journal.sequence,
    seal: journal.authorization.seal,
  };
}

export async function matchesProtectedJournalTip(
  env: Env,
  journal: OperationJournal,
): Promise<boolean> {
  try {
    return await requireMutationAuthority(env).matchesJournalTip(operationJournalTip(journal));
  } catch {
    return false;
  }
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
  const serialized = serializeObservable("receipt", receipt, {
    ...observableOptionsForEnv(env),
    pretty: true,
    protocolShape: "operation-receipt",
  });
  const published: unknown = JSON.parse(serialized);
  assertOperationReceipt(published);
  await publishVerifiedStoreFile(
    env,
    storeRoot,
    path,
    `${serialized}\n`,
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

function assertOperationJournal(
  env: Env,
  storeRoot: string,
  value: unknown,
): asserts value is OperationJournal {
  const journal = value as OperationJournal;
  const journalKeys = [
    "actions",
    "authorization",
    "nextRevision",
    "operationId",
    "plan",
    "previousJournalSeal",
    "schemaVersion",
    "sequence",
    "startedAt",
    "status",
    "updatedAt",
  ];
  if (typeof value === "object" && value !== null) {
    if ("statePublications" in value) journalKeys.push("statePublications");
    if ("completedReceipt" in value) journalKeys.push("completedReceipt");
  }
  if (
    !hasExactKeys(value, journalKeys) ||
    journal.schemaVersion !== 1 ||
    typeof journal.operationId !== "string" ||
    typeof journal.plan !== "object" ||
    journal.plan === null ||
    !Number.isSafeInteger(journal.nextRevision) ||
    journal.nextRevision < 0 ||
    !Number.isSafeInteger(journal.sequence) ||
    journal.sequence < 1 ||
    (journal.sequence === 1
      ? journal.previousJournalSeal !== null
      : typeof journal.previousJournalSeal !== "string" ||
        !/^hmac-sha256:[0-9a-f]{64}$/.test(journal.previousJournalSeal)) ||
    !isStrictMutationAuthorizationEnvelope(journal.authorization, OPERATION_JOURNAL_DOMAIN) ||
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
  if (
    !hasExactKeys(journal.plan, [
      "actions",
      "authorization",
      "baseRevision",
      "digest",
      "durableDigest",
      "expires",
      "normalizedInputsDigest",
      "operation",
      "planId",
      "schemaVersion",
      "targetPreconditions",
    ]) ||
    !MUTATION_OPERATIONS.includes(journal.plan.operation) ||
    typeof journal.plan.planId !== "string" ||
    typeof journal.plan.normalizedInputsDigest !== "string" ||
    !Array.isArray(journal.plan.actions) ||
    !Array.isArray(journal.plan.targetPreconditions)
  ) {
    throw new Error("operation journal durable plan has an invalid runtime schema");
  }
  if (!verifyDurableMutationPlanDigest(journal.plan)) {
    throw new Error("operation journal durable plan digest is invalid");
  }
  if (!verifyDurableMutationPlanAuthorization(env, storeRoot, journal.plan)) {
    throw new Error("operation journal durable plan authorization is invalid");
  }
  if (!verifyOperationJournalAuthorization(env, storeRoot, journal)) {
    throw new Error("operation journal authorization is invalid");
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

  for (const planned of journal.plan.actions) {
    const plannedKeys = ["actionId", "kind", "payloadDigest", "target"];
    if (planned.payload !== undefined) plannedKeys.push("payload");
    if (planned.postcondition !== undefined) plannedKeys.push("postcondition");
    if (
      !hasExactKeys(planned, plannedKeys) ||
      typeof planned.actionId !== "string" ||
      planned.actionId.length === 0 ||
      !MUTATION_ACTION_KINDS.includes(planned.kind as (typeof MUTATION_ACTION_KINDS)[number]) ||
      typeof planned.target !== "string" ||
      planned.target.length === 0 ||
      typeof planned.payloadDigest !== "string"
    ) {
      throw new Error("operation journal durable action has an invalid runtime schema");
    }
  }
  for (const precondition of journal.plan.targetPreconditions) {
    if (
      !hasExactKeys(precondition, ["actionId", "expected", "target"]) ||
      typeof precondition.actionId !== "string" ||
      typeof precondition.target !== "string" ||
      !isTargetStateReceipt(precondition.expected)
    ) {
      throw new Error("operation journal precondition has an invalid runtime schema");
    }
  }

  for (const [index, action] of journal.actions.entries()) {
    const planned = journal.plan.actions[index];
    const precondition = planned ? preconditions.get(planned.actionId) : undefined;
    if (
      !hasExactKeys(
        action,
        action && typeof action === "object" && "receipt" in action
          ? ["actionId", "receipt", "status", "target"]
          : ["actionId", "status", "target"],
      ) ||
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
    const isKeychainAction = ["keychain-secret-set", "keychain-secret-delete"].includes(
      planned.kind,
    );
    if (
      (isKeychainAction &&
        (typeof planned.payload !== "object" ||
          planned.payload === null ||
          sha256(canonicalJson(planned.payload)) !== planned.payloadDigest)) ||
      (!isKeychainAction && planned.payload !== undefined)
    ) {
      throw new Error("operation journal action has invalid durable provider authorization");
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
        !sameTargetState(planned.postcondition, action.receipt.after) &&
        !(
          (journal.status === "executing" ||
            (journal.status === "completed" &&
              journal.completedReceipt?.outcome === "compensated")) &&
          action.receipt.outcome === "compensated" &&
          sameTargetState(action.receipt.before, action.receipt.after)
        )
      ) {
        throw new Error(
          "operation journal action after-state does not match its signed postcondition",
        );
      }
      if (
        (action.status === "failed" && action.receipt.outcome !== "failed") ||
        (action.status === "succeeded" && action.receipt.outcome === "failed")
      ) {
        throw new Error("operation journal action status does not match its receipt outcome");
      }
    }
  }
  if (journal.statePublications !== undefined) {
    if (
      !Array.isArray(journal.statePublications) ||
      journal.statePublications.some(
        (publication) =>
          !hasExactKeys(
            publication,
            publication && typeof publication === "object" && "mode" in publication
              ? ["digest", "mode", "path"]
              : ["digest", "path"],
          ) ||
          typeof publication.path !== "string" ||
          typeof publication.digest !== "string" ||
          (publication.mode !== undefined && !Number.isInteger(publication.mode)),
      )
    ) {
      throw new Error("invalid journal state publication");
    }
  }
  if (
    (journal.status === "prepared" &&
      journal.actions.some((action) => action.status !== "pending")) ||
    (journal.status === "publishing-state" &&
      journal.actions.some((action) => action.status !== "succeeded")) ||
    (["prepared", "executing"].includes(journal.status) && journal.statePublications !== undefined)
  ) {
    throw new Error("operation journal status does not match its durable action receipts");
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
  registerObservableMutationAuthorization(
    journal.plan.authorization,
    journal.plan.authorization.domain,
  );
  registerObservableMutationAuthorization(journal.authorization, OPERATION_JOURNAL_DOMAIN);
}

function sealNextOperationJournal(
  env: Env,
  storeRoot: string,
  journal: OperationJournalInput,
): OperationJournal {
  const hasPriorAuthorization = journal.authorization !== undefined;
  if (
    hasPriorAuthorization !== (journal.sequence !== undefined) ||
    hasPriorAuthorization !== (journal.previousJournalSeal !== undefined)
  ) {
    throw new TypeError("operation journal chain metadata is incomplete");
  }
  if (
    hasPriorAuthorization &&
    (!Number.isSafeInteger(journal.sequence) ||
      (journal.sequence ?? 0) < 1 ||
      !isStrictMutationAuthorizationEnvelope(journal.authorization, OPERATION_JOURNAL_DOMAIN))
  ) {
    throw new TypeError("operation journal prior authorization is invalid");
  }
  const {
    authorization: priorAuthorization,
    previousJournalSeal: _previousJournalSeal,
    sequence: priorSequence,
    ...payload
  } = journal;
  const unsigned = {
    ...payload,
    sequence: (priorSequence ?? 0) + 1,
    previousJournalSeal: priorAuthorization?.seal ?? null,
  };
  const authority = requireMutationAuthority(env);
  const request = operationJournalAuthorityRequest(env, storeRoot, unsigned);
  const authorization = authority.seal(request);
  if (!isStrictMutationAuthorizationEnvelope(authorization, OPERATION_JOURNAL_DOMAIN)) {
    throw new TypeError("mutation authority returned an invalid journal authorization envelope");
  }
  if (!authority.verify(request, authorization)) {
    throw new TypeError("mutation authority could not verify its journal authorization envelope");
  }
  return {
    ...unsigned,
    authorization: registerObservableMutationAuthorization(authorization, OPERATION_JOURNAL_DOMAIN),
  };
}

function verifyOperationJournalAuthorization(
  env: Env,
  storeRoot: string,
  journal: OperationJournal,
): boolean {
  try {
    const authority = requireMutationAuthority(env);
    if (!isStrictMutationAuthorizationEnvelope(journal.authorization, OPERATION_JOURNAL_DOMAIN)) {
      return false;
    }
    return authority.verify(
      operationJournalAuthorityRequest(env, storeRoot, journal),
      journal.authorization,
    );
  } catch {
    return false;
  }
}

function operationJournalAuthorityRequest(
  env: Env,
  storeRoot: string,
  journal: Omit<OperationJournal, "authorization"> | OperationJournal,
) {
  const { authorization: _authorization, ...canonicalPayload } = journal as OperationJournal;
  return {
    schemaVersion: MUTATION_AUTHORIZATION_SCHEMA_VERSION,
    domain: OPERATION_JOURNAL_DOMAIN,
    normalizedStoreRoot: resolve(env.cwd(), storeRoot),
    operation: journal.plan.operation,
    baseRevision: journal.plan.baseRevision,
    canonicalPayload: canonicalJson(canonicalPayload),
  } as const;
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
  const keys = ["actionId", "after", "before", "outcome", "recordedAt", "target"];
  if (typeof value === "object" && value !== null && "error" in value) keys.push("error");
  if (
    !hasExactKeys(value, keys) ||
    typeof value.actionId !== "string" ||
    typeof value.target !== "string" ||
    !["applied", "unchanged", "compensated", "failed"].includes(value.outcome) ||
    !isTargetStateReceipt(value.before) ||
    !isTargetStateReceipt(value.after) ||
    Number.isNaN(Date.parse(value.recordedAt))
  ) {
    throw new Error("invalid operation action receipt");
  }
  if (
    value.error !== undefined &&
    (!hasExactKeys(value.error, ["code", "message"]) ||
      typeof value.error.code !== "string" ||
      typeof value.error.message !== "string")
  ) {
    throw new Error("invalid operation action receipt");
  }
}

function isTargetStateReceipt(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as {
    state?: unknown;
    fingerprint?: unknown;
    recoverySnapshot?: unknown;
    recoverySnapshotDigest?: unknown;
    recoverySnapshotMode?: unknown;
  };
  if (state.state === "absent") return hasExactKeys(value, ["state"]);
  const hasSnapshot = state.recoverySnapshot !== undefined;
  const valid =
    state.state === "present" &&
    typeof state.fingerprint === "string" &&
    (hasSnapshot
      ? typeof state.recoverySnapshot === "string" &&
        typeof state.recoverySnapshotDigest === "string" &&
        Number.isInteger(state.recoverySnapshotMode)
      : state.recoverySnapshotDigest === undefined && state.recoverySnapshotMode === undefined);
  if (!valid) return false;
  return hasExactKeys(
    value,
    hasSnapshot
      ? [
          "fingerprint",
          "recoverySnapshot",
          "recoverySnapshotDigest",
          "recoverySnapshotMode",
          "state",
        ]
      : ["fingerprint", "state"],
  );
}

function assertOperationReceipt(value: unknown): asserts value is OperationReceipt {
  if (
    !hasExactKeys(value, [
      "actionReceipts",
      "baseRevision",
      "completedAt",
      "operation",
      "operationId",
      "outcome",
      "planDigest",
      "planId",
      "resultingRevision",
      "schemaVersion",
      "startedAt",
    ]) ||
    (value as OperationReceipt).schemaVersion !== 1 ||
    typeof (value as OperationReceipt).operationId !== "string" ||
    typeof (value as OperationReceipt).planId !== "string" ||
    typeof (value as OperationReceipt).planDigest !== "string" ||
    !MUTATION_OPERATIONS.includes((value as OperationReceipt).operation) ||
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

function hasExactKeys(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
