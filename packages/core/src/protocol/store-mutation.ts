import type { Env, MutationAuthorityLease } from "../env.js";
import { assertSafeAtomicPublicationPath } from "../fs/safety.js";
import {
  createProviderScope,
  inventoryActiveSecretValues,
  providerScopeForEnv,
  withProviderScope,
} from "../secrets/active-values.js";
import { assertFinalSerializedSecretBytes } from "../secrets/final-bytes.js";
import { sha256 } from "../store/checksum.js";
import { loadConfig } from "../store/config.js";
import {
  acquireCurrentMutationAuthorityLease,
  createAuthorizedMutationPlan,
  requireMutationAuthority,
} from "./canonical.js";
import { executeMutationPlan, targetState } from "./execute.js";
import type {
  CanonicalJsonObject,
  MutationConflict,
  MutationOperation,
  MutationPlanAction,
  OperationActionReceipt,
  OperationResult,
  TargetStateReceipt,
} from "./models.js";
import { observeAtStableStoreRevision } from "./store-revision.js";

export interface StorePublicationInput {
  readonly path: string;
  readonly data: string;
  readonly mode: number;
  readonly currentUserOnly?: boolean;
}

export interface PreparedStorePublicationMutation<T> {
  readonly value: T;
  readonly publications: readonly StorePublicationInput[];
}

export interface StorePublicationMutationResult<T> {
  readonly value: T;
  readonly operation: OperationResult;
}

export interface PreparedStoreMutationAction {
  readonly actionId: string;
  readonly kind: string;
  readonly target: string;
  readonly payload: CanonicalJsonObject;
  readonly postcondition: TargetStateReceipt;
  readonly execute: () => Promise<void>;
}

export interface PreparedStoreActionMutation<T> {
  readonly value: T;
  readonly actions: readonly PreparedStoreMutationAction[];
  readonly publications?: readonly StorePublicationInput[];
  readonly afterCommit?: () => Promise<void>;
}

export class StoreMutationConflictError extends Error {
  readonly code: MutationConflict["code"];

  constructor(readonly conflict: MutationConflict) {
    super(conflict.message);
    this.name = "StoreMutationConflictError";
    this.code = conflict.code;
  }
}

export async function executeStorePublicationMutation<T>(
  env: Env,
  storeRoot: string,
  operation: MutationOperation,
  mutationKind: string,
  prepare: () => Promise<PreparedStorePublicationMutation<T>>,
): Promise<StorePublicationMutationResult<T>> {
  return executeStoreActionMutation(env, storeRoot, operation, mutationKind, async () => {
    const prepared = await prepare();
    return {
      value: prepared.value,
      actions: [],
      publications: prepared.publications,
    };
  });
}

export function unwrapStorePublicationMutation<T>(result: StorePublicationMutationResult<T>): T {
  if (!result.operation.ok) throw new StoreMutationConflictError(result.operation.conflict);
  return result.value;
}

export async function executeStoreActionMutation<T>(
  env: Env,
  storeRoot: string,
  operation: MutationOperation,
  mutationKind: string,
  prepare: () => Promise<PreparedStoreActionMutation<T>>,
  execution: { readonly authorityLease?: MutationAuthorityLease } = {},
): Promise<StorePublicationMutationResult<T>> {
  requireMutationAuthority(env);
  const suppliedLease = execution.authorityLease;
  const authorityLease =
    suppliedLease ?? (await acquireCurrentMutationAuthorityLease(env).catch(() => null));
  if (!authorityLease) throw new TypeError("mutation authority is not current");
  if (!(await authorityLease.isCurrent().catch(() => false))) {
    if (!suppliedLease) await authorityLease.release().catch(() => undefined);
    throw new TypeError("mutation authority is not current");
  }
  try {
    return await executeStoreActionMutationWithAuthorityLease(
      env,
      storeRoot,
      operation,
      mutationKind,
      prepare,
      authorityLease,
    );
  } finally {
    if (!suppliedLease) await authorityLease.release();
  }
}

async function executeStoreActionMutationWithAuthorityLease<T>(
  env: Env,
  storeRoot: string,
  operation: MutationOperation,
  mutationKind: string,
  prepare: () => Promise<PreparedStoreActionMutation<T>>,
  authorityLease: MutationAuthorityLease,
): Promise<StorePublicationMutationResult<T>> {
  requireMutationAuthority(env);
  let operationEnv = env;
  const observed = await observeAtStableStoreRevision(env, storeRoot, async () => {
    const prepared = await prepare();
    const publications = normalizePublications(prepared.publications ?? []);
    if (publications.length > 0 && operation !== "secret-metadata") {
      operationEnv = await finalStorePublicationEnv(env, storeRoot);
      const scope = providerScopeForEnv(operationEnv);
      if (!scope) throw new TypeError("final Store publication has no provider inventory");
      for (const publication of publications) {
        assertFinalSerializedSecretBytes(publication.data, scope.knownValues, publication.path);
      }
    }
    const publicationActions = publications.map((publication, index) => ({
      actionId: publicationActionId(mutationKind, publication, index),
      kind: "publish-file",
      target: publication.path,
      payload: {
        path: publication.path,
        digest: publication.digest,
        mode: publication.mode,
        ...(publication.currentUserOnly ? { currentUserOnly: true } : {}),
      },
      postcondition: { state: "present" as const, fingerprint: publication.digest },
    }));
    const plannedActions = [...prepared.actions, ...publicationActions];
    const preconditions = await Promise.all(
      plannedActions.map(async (action) => ({
        actionId: action.actionId,
        target: action.target,
        expected: await targetState(operationEnv, action.target),
      })),
    );
    return { prepared, preconditions, publications, publicationActions, plannedActions };
  });
  const prepared = observed.value.prepared;
  const actionIds = new Set(observed.value.plannedActions.map((action) => action.actionId));
  if (actionIds.size !== observed.value.plannedActions.length) {
    throw new TypeError("store mutation action ids must be unique");
  }
  const plan = createAuthorizedMutationPlan(operationEnv, storeRoot, {
    schemaVersion: 1,
    planId: `plan-${env.randomId()}`,
    operation,
    baseRevision: observed.revision,
    normalizedInputs: { mutationKind },
    targetPreconditions: observed.value.preconditions,
    actions: observed.value.plannedActions.map(
      ({ actionId, kind, target, payload, postcondition }) => ({
        actionId,
        kind,
        target,
        payload,
        postcondition,
      }),
    ),
    expires: { policy: "none" },
  });
  const result = await executeMutationPlan(
    operationEnv,
    storeRoot,
    plan,
    async (_operationId, record, authorizeAction) => {
      const actionReceipts: OperationActionReceipt[] = [];
      const failedActionIds: string[] = [];
      const rawPublicationData = new Map(
        observed.value.publications.map((publication) => [publication.digest, publication.data]),
      );
      const executableActions = [
        ...prepared.actions,
        ...observed.value.publicationActions.map((action, publicationIndex) => {
          const signedAction = plan.actions[prepared.actions.length + publicationIndex];
          if (
            !signedAction ||
            signedAction.actionId !== action.actionId ||
            signedAction.kind !== "publish-file"
          ) {
            throw new Error(
              `publication action ${action.actionId} is not bound to its signed plan`,
            );
          }
          return {
            ...action,
            execute: async () => {
              await assertSafeAtomicPublicationPath(
                operationEnv,
                signedAction.target,
                storeRoot,
                "store publication",
              );
              const digest = signedAction.payload.digest;
              if (typeof digest !== "string") throw new TypeError("publication digest is invalid");
              const data = rawPublicationData.get(digest);
              if (data === undefined || sha256(data) !== digest) {
                throw new Error(`publication data is unavailable for signed digest ${digest}`);
              }
              const mode = signedAction.payload.mode;
              if (typeof mode !== "number") {
                throw new TypeError("publication mode is invalid");
              }
              await operationEnv.fs.publishFileAtomically(signedAction.target, data, { mode });
              if (
                signedAction.payload.currentUserOnly === true &&
                operationEnv.platform === "win32"
              ) {
                const permissions = operationEnv.currentUserOnlyPermissions;
                if (!permissions?.supported(operationEnv.platform)) {
                  throw insecurePermissionsError();
                }
                await permissions.set(signedAction.target);
                if (!(await permissions.verify(signedAction.target))) {
                  throw insecurePermissionsError();
                }
              }
            },
          };
        }),
      ];
      for (const [index, action] of executableActions.entries()) {
        const signedAction = plan.actions[index];
        if (
          !signedAction ||
          signedAction.actionId !== action.actionId ||
          signedAction.target !== action.target ||
          signedAction.kind !== action.kind
        ) {
          throw new Error(
            `store mutation action ${action.actionId} is not bound to its signed plan`,
          );
        }
        const authorized = await authorizeAction(action.actionId);
        if (!authorized.ok) {
          actionReceipts.push(authorized.receipt);
          failedActionIds.push(action.actionId);
          break;
        }
        const before = observed.value.preconditions[index]?.expected;
        if (!before) throw new Error(`missing store mutation precondition for ${action.actionId}`);
        let failure: { code: string; message: string } | undefined;
        try {
          await action.execute();
          if (action.kind === "publish-file") {
            await verifySignedFilePublication(operationEnv, signedAction);
          } else {
            await verifySignedActionPostcondition(operationEnv, signedAction);
          }
        } catch (error) {
          const code = actionIoFailureCode(error);
          if (!CONTROLLED_ACTION_IO_CODES.has(code)) throw error;
          failure = { code, message: `filesystem action failed (${code})` };
          failedActionIds.push(action.actionId);
        }
        const after = await targetState(operationEnv, action.target);
        const receipt: OperationActionReceipt = {
          actionId: action.actionId,
          target: action.target,
          outcome: failure ? "failed" : sameTargetState(before, after) ? "unchanged" : "applied",
          before,
          after,
          recordedAt: operationEnv.now().toISOString(),
          ...(failure ? { error: failure } : {}),
        };
        await record(receipt);
        actionReceipts.push(receipt);
        if (failure) break;
      }
      return {
        actionReceipts,
        ...(failedActionIds.length > 0 ? { failedActionIds } : {}),
        ...(prepared.afterCommit ? { afterCommit: prepared.afterCommit } : {}),
      };
    },
    { authorityLease },
  );
  return { value: prepared.value, operation: result };
}

async function finalStorePublicationEnv(env: Env, storeRoot: string): Promise<Env> {
  const existing = providerScopeForEnv(env);
  const config = existing ? undefined : await loadConfig(env, storeRoot);
  const scope =
    existing ??
    createProviderScope({
      secretMode: config?.defaults.secretMode ?? "env",
    });
  const operationEnv = existing ? env : withProviderScope(env, scope);
  await inventoryActiveSecretValues(operationEnv, storeRoot, {
    secretMode: scope.mode,
    keychainService: scope.service,
    requireAvailable: true,
  });
  return operationEnv;
}

interface NormalizedPublication extends StorePublicationInput {
  readonly digest: string;
}

function normalizePublications(
  publications: readonly StorePublicationInput[],
): NormalizedPublication[] {
  const seen = new Set<string>();
  return publications.map(({ path, data, mode, currentUserOnly }) => {
    if (seen.has(path)) throw new TypeError(`duplicate store publication target: ${path}`);
    if (!Number.isInteger(mode) || mode < 0) {
      throw new TypeError(`invalid store publication mode for ${path}: ${mode}`);
    }
    seen.add(path);
    return {
      path,
      data,
      digest: sha256(data),
      mode,
      ...(currentUserOnly ? { currentUserOnly: true } : {}),
    };
  });
}

function publicationActionId(
  mutationKind: string,
  publication: NormalizedPublication,
  index: number,
): string {
  return sha256(
    JSON.stringify({
      mutationKind,
      index,
      kind: "publish-file",
      path: publication.path,
      digest: publication.digest,
      mode: publication.mode,
      currentUserOnly: publication.currentUserOnly === true,
    }),
  );
}

const CONTROLLED_ACTION_IO_CODES = new Set([
  "EACCES",
  "EDQUOT",
  "EFBIG",
  "EIO",
  "ENOSPC",
  "EPERM",
  "EROFS",
  "ESTALE",
  "PUBLICATION_POSTCONDITION_FAILED",
  "ACTION_POSTCONDITION_FAILED",
  "INSECURE_VAULT_PERMISSIONS",
]);

async function verifySignedActionPostcondition(
  env: Env,
  action: MutationPlanAction,
): Promise<void> {
  if (!action.postcondition) {
    throw new TypeError(`action ${action.actionId} is missing its signed postcondition`);
  }
  const actual = await targetState(env, action.target);
  if (sameTargetState(action.postcondition, actual)) return;
  const error = new Error(
    `action ${action.actionId} target ${action.target} does not match its signed postcondition`,
  ) as Error & { code: string };
  error.code = "ACTION_POSTCONDITION_FAILED";
  throw error;
}

async function verifySignedFilePublication(env: Env, action: MutationPlanAction): Promise<void> {
  const digest = action.payload.digest;
  const mode = action.payload.mode;
  if (typeof digest !== "string" || typeof mode !== "number") {
    throw new TypeError(`publication action ${action.actionId} has invalid signed postconditions`);
  }
  const stat = await env.fs.lstat(action.target).catch(() => null);
  const actualDigest = await env.fs
    .readFileBytes(action.target)
    .then(sha256)
    .catch(() => null);
  const modeMatches =
    env.platform === "win32" || (stat !== null && (stat.mode & 0o777) === (mode & 0o777));
  if (!stat?.isFile() || actualDigest !== digest || !modeMatches) {
    const error = new Error(
      `published file ${action.target} does not match its signed digest or mode`,
    ) as Error & { code: string };
    error.code = "PUBLICATION_POSTCONDITION_FAILED";
    throw error;
  }
  if (action.payload.currentUserOnly === true && env.platform === "win32") {
    const permissions = env.currentUserOnlyPermissions;
    if (!permissions?.supported(env.platform) || !(await permissions.verify(action.target))) {
      throw insecurePermissionsError();
    }
  }
}

function insecurePermissionsError(): Error & { code: string } {
  const error = new Error("current-user-only file permissions are required") as Error & {
    code: string;
  };
  error.code = "INSECURE_VAULT_PERMISSIONS";
  return error;
}

function actionIoFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN_IO_ERROR";
}

function sameTargetState(
  left: OperationActionReceipt["before"],
  right: OperationActionReceipt["after"],
): boolean {
  return (
    left.state === right.state &&
    (left.state === "absent" ||
      (right.state === "present" && left.fingerprint === right.fingerprint))
  );
}
