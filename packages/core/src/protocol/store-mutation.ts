import { resolve } from "node:path";
import type { Env, MutationAuthorityLease } from "../env.js";
import { assertSafeAtomicPublicationPath } from "../fs/safety.js";
import { assertFinalSerializedSecretBytes } from "../secrets/final-bytes.js";
import type { SecretValue } from "../secrets/observable.js";
import type { StorePublicationSecretGuard } from "../secrets/provider-ports.js";
import { captureAnchoredSafeRecursiveSource } from "../secrets/safe-tree.js";
import { sha256 } from "../store/checksum.js";
import {
  acquireCurrentMutationAuthorityLease,
  createAuthorizedMutationPlan,
  requireMutationAuthority,
} from "./canonical.js";
import { invalidPlanResult, targetState } from "./execute.js";
import type {
  CanonicalJsonObject,
  CanonicalJsonValue,
  MutationConflict,
  MutationOperation,
  MutationPlan,
  MutationPlanAction,
  OperationActionReceipt,
  OperationResult,
  TargetStateReceipt,
} from "./models.js";
import { resolveAuthorizedMutationOperationAdapter } from "./operation-adapter.js";
import { executePreparedMutationOperation } from "./operation-execution.js";
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
  readonly plan: MutationPlan;
  readonly operation: OperationResult;
}

export interface StorePublicationMutationPlan<T> {
  readonly value: T;
  readonly plan: MutationPlan;
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

export interface StoreMutationPlanBindings {
  /** Store paths whose observed bytes/existence influenced planning decisions. */
  readonly provenancePaths?: readonly string[];
  /** Domain-safe inputs to bind into the canonical plan in addition to mutationKind. */
  readonly normalizedInputs?: CanonicalJsonObject;
  /** Include final guarded publication bytes so the exact serialized plan is executable. */
  readonly selfContainedPublications?: boolean;
  /** Domain validation for the final bytes, run while planning and again before/under apply lock. */
  readonly validatePublications?: (publications: readonly StorePublicationInput[]) => void;
  /** Read-only provider observation used by final serialized-byte guards. */
  readonly secretPublicationGuard?: StorePublicationSecretGuard;
  /** Domain-aware final-byte validation after the publication's closed schema has passed. */
  readonly validateFinalPublicationBytes?: (
    publication: StorePublicationInput,
    knownValues: readonly SecretValue[],
  ) => void;
}

export interface AppliedStorePublicationPlan {
  readonly plan: MutationPlan;
  readonly changedFields: readonly string[];
  readonly operation: OperationResult;
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
  bindings: StoreMutationPlanBindings = {},
): Promise<StorePublicationMutationResult<T>> {
  return executeStoreActionMutation(
    env,
    storeRoot,
    operation,
    mutationKind,
    async () => {
      const prepared = await prepare();
      return {
        value: prepared.value,
        actions: [],
        publications: prepared.publications,
      };
    },
    bindings,
  );
}

export async function planStorePublicationMutation<T>(
  env: Env,
  storeRoot: string,
  operation: MutationOperation,
  mutationKind: string,
  prepare: () => Promise<PreparedStorePublicationMutation<T>>,
  bindings: StoreMutationPlanBindings = {},
  execution: { readonly authorityLease?: MutationAuthorityLease } = {},
): Promise<StorePublicationMutationPlan<T>> {
  return planStoreActionMutation(
    env,
    storeRoot,
    operation,
    mutationKind,
    async () => {
      const prepared = await prepare();
      return { value: prepared.value, actions: [], publications: prepared.publications };
    },
    bindings,
    execution,
  );
}

export async function planStoreActionMutation<T>(
  env: Env,
  storeRoot: string,
  operation: MutationOperation,
  mutationKind: string,
  prepare: () => Promise<PreparedStoreActionMutation<T>>,
  bindings: StoreMutationPlanBindings = {},
  execution: { readonly authorityLease?: MutationAuthorityLease } = {},
): Promise<StorePublicationMutationPlan<T>> {
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
    const prepared = await prepareStoreActionMutationPlan(
      env,
      storeRoot,
      operation,
      mutationKind,
      prepare,
      bindings,
    );
    return { value: prepared.prepared.value, plan: prepared.plan };
  } finally {
    if (!suppliedLease) await authorityLease.release();
  }
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
  execution: { readonly authorityLease?: MutationAuthorityLease } & StoreMutationPlanBindings = {},
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
      execution,
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
  bindings: StoreMutationPlanBindings,
): Promise<StorePublicationMutationResult<T>> {
  requireMutationAuthority(env);
  const planned = await prepareStoreActionMutationPlan(
    env,
    storeRoot,
    operation,
    mutationKind,
    prepare,
    bindings,
  );
  const { operationEnv, plan, prepared, preconditions, publications, publicationActions } = planned;
  const result = await executePreparedMutationOperation(
    operationEnv,
    storeRoot,
    plan,
    async (_operationId, record, authorizeAction) => {
      const actionReceipts: OperationActionReceipt[] = [];
      const failedActionIds: string[] = [];
      const rawPublicationData = new Map(
        publications.map((publication) => [publication.digest, publication.data]),
      );
      const executableActions = [
        ...prepared.actions,
        ...publicationActions.map((action, publicationIndex) => {
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
        const before = preconditions[index]?.expected;
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
    {
      authorityLease,
      ...(bindings.provenancePaths || bindings.validatePublications
        ? {
            validatePreflightBeforeObservation: async () => {
              bindings.validatePublications?.(publications);
              return bindings.provenancePaths
                ? validateStoreProvenance(operationEnv, storeRoot, plan)
                : null;
            },
            validateBeforeObservationUnderLock: async () => {
              bindings.validatePublications?.(publications);
              return bindings.provenancePaths
                ? validateStoreProvenance(operationEnv, storeRoot, plan)
                : null;
            },
            validateUnderLock: async () => {
              const provenance = bindings.provenancePaths
                ? await validateStoreProvenance(operationEnv, storeRoot, plan)
                : null;
              if (provenance) return provenance;
              bindings.validatePublications?.(publications);
              return null;
            },
          }
        : {}),
    },
  );
  return { value: prepared.value, plan, operation: result };
}

interface PreparedStoreActionMutationPlan<T> {
  readonly operationEnv: Env;
  readonly prepared: PreparedStoreActionMutation<T>;
  readonly preconditions: readonly {
    readonly actionId: string;
    readonly target: string;
    readonly expected: TargetStateReceipt;
  }[];
  readonly publications: readonly NormalizedPublication[];
  readonly publicationActions: readonly MutationPlanAction[];
  readonly plan: MutationPlan;
}

export interface StoreProvenanceDescriptor {
  readonly path: string;
  readonly expected: TargetStateReceipt;
}

async function prepareStoreActionMutationPlan<T>(
  env: Env,
  storeRoot: string,
  operation: MutationOperation,
  mutationKind: string,
  prepare: () => Promise<PreparedStoreActionMutation<T>>,
  bindings: StoreMutationPlanBindings,
): Promise<PreparedStoreActionMutationPlan<T>> {
  let operationEnv = env;
  const initialProvenance = await captureStoreProvenance(
    env,
    storeRoot,
    bindings.provenancePaths ?? [],
  );
  const observed = await observeAtStableStoreRevision(env, storeRoot, async () => {
    const provenanceBefore = await captureStoreProvenance(
      env,
      storeRoot,
      bindings.provenancePaths ?? [],
    );
    if (canonicalProvenance(initialProvenance) !== canonicalProvenance(provenanceBefore)) {
      throw new TypeError("Store mutation provenance changed while planning");
    }
    const prepared = await prepare();
    const publications = normalizePublications(prepared.publications ?? []);
    bindings.validatePublications?.(publications);
    if (publications.length > 0 && operation !== "secret-metadata") {
      const guarded = await prepareFinalStorePublicationEnv(
        bindings.secretPublicationGuard,
        env,
        storeRoot,
      );
      operationEnv = guarded.env;
      for (const publication of publications) {
        validateFinalPublicationBytes(bindings, publication, guarded.knownValues);
      }
    }
    const publicationActions: MutationPlanAction[] = publications.map((publication, index) => ({
      actionId: publicationActionId(mutationKind, publication, index),
      kind: "publish-file",
      target: publication.path,
      payload: {
        path: publication.path,
        digest: publication.digest,
        mode: publication.mode,
        ...(bindings.selfContainedPublications ? { data: publication.data } : {}),
        ...(publication.currentUserOnly ? { currentUserOnly: true } : {}),
      },
      postcondition: { state: "present", fingerprint: publication.digest },
    }));
    const plannedActions = [...prepared.actions, ...publicationActions];
    const preconditions = await Promise.all(
      plannedActions.map(async (action) => ({
        actionId: action.actionId,
        target: action.target,
        expected: await targetState(operationEnv, action.target),
      })),
    );
    const provenanceAfter = await captureStoreProvenance(
      env,
      storeRoot,
      bindings.provenancePaths ?? [],
    );
    if (JSON.stringify(provenanceBefore) !== JSON.stringify(provenanceAfter)) {
      throw new TypeError("Store mutation provenance changed while planning");
    }
    return {
      prepared,
      preconditions,
      publications,
      publicationActions,
      plannedActions,
      provenance: provenanceBefore,
    };
  });
  const actionIds = new Set(observed.value.plannedActions.map((action) => action.actionId));
  if (actionIds.size !== observed.value.plannedActions.length) {
    throw new TypeError("store mutation action ids must be unique");
  }
  const plan = createAuthorizedMutationPlan(operationEnv, storeRoot, {
    schemaVersion: 1,
    planId: `plan-${env.randomId()}`,
    operation,
    baseRevision: observed.revision,
    normalizedInputs: {
      mutationKind,
      ...(bindings.normalizedInputs ?? {}),
      ...(bindings.provenancePaths
        ? {
            storeProvenance: observed.value.provenance as unknown as CanonicalJsonValue,
          }
        : {}),
    },
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
  return {
    operationEnv,
    prepared: observed.value.prepared,
    preconditions: observed.value.preconditions,
    publications: observed.value.publications,
    publicationActions: observed.value.publicationActions,
    plan,
  };
}

export async function applyStorePublicationPlan(
  env: Env,
  storeRoot: string,
  plan: MutationPlan,
  options: {
    readonly operation: MutationOperation;
    readonly allowedMutationKinds: readonly string[];
    readonly requiredTarget: string;
    readonly requiredProvenancePathsByMutationKind?: Readonly<Record<string, readonly string[]>>;
    readonly requiredNormalizedInputKeys?: readonly string[];
    readonly validatePublicationData?: (data: string) => void;
    readonly validateFinalPublicationBytes?: StoreMutationPlanBindings["validateFinalPublicationBytes"];
    readonly validatePlanUnderLock?: (
      plan: MutationPlan,
      publication: StorePublicationInput,
    ) => Promise<OperationResult | null>;
    readonly authorityLease?: MutationAuthorityLease;
    readonly secretPublicationGuard: StorePublicationSecretGuard;
  },
): Promise<AppliedStorePublicationPlan> {
  if (!resolveAuthorizedMutationOperationAdapter(env, storeRoot, plan, options.operation)) {
    return { plan, changedFields: [], operation: invalidPlanResult() };
  }
  const decoded = decodeSelfContainedPublicationPlan(plan, options);
  if (!decoded) return { plan, changedFields: [], operation: invalidPlanResult() };
  options.validatePublicationData?.(decoded.data);

  const suppliedLease = options.authorityLease;
  const authorityLease =
    suppliedLease ?? (await acquireCurrentMutationAuthorityLease(env).catch(() => null));
  if (!authorityLease || !(await authorityLease.isCurrent().catch(() => false))) {
    if (authorityLease && !suppliedLease) await authorityLease.release().catch(() => undefined);
    return { plan, changedFields: [], operation: invalidPlanResult() };
  }
  try {
    let guarded = await options.secretPublicationGuard.prepare(env, storeRoot);
    let operationEnv = guarded.env;
    validateFinalPublicationBytes(
      options,
      { path: decoded.action.target, data: decoded.data, mode: decoded.mode },
      guarded.knownValues,
    );
    const operation = await executePreparedMutationOperation(
      operationEnv,
      storeRoot,
      plan,
      async (_operationId, record, authorizeAction) => {
        const authorized = await authorizeAction(decoded.action.actionId);
        if (!authorized.ok)
          return {
            actionReceipts: [authorized.receipt],
            failedActionIds: [decoded.action.actionId],
          };
        await assertSafeAtomicPublicationPath(
          operationEnv,
          decoded.action.target,
          storeRoot,
          "store publication",
        );
        await operationEnv.fs.publishFileAtomically(decoded.action.target, decoded.data, {
          mode: decoded.mode,
        });
        await verifySignedFilePublication(operationEnv, decoded.action);
        const after = await targetState(operationEnv, decoded.action.target);
        const receipt: OperationActionReceipt = {
          actionId: decoded.action.actionId,
          target: decoded.action.target,
          outcome: sameTargetState(authorized.before, after) ? "unchanged" : "applied",
          before: authorized.before,
          after,
          recordedAt: operationEnv.now().toISOString(),
        };
        await record(receipt);
        return { actionReceipts: [receipt] };
      },
      {
        authorityLease,
        validateUnderLock: async () => {
          const provenance = await validateStoreProvenance(operationEnv, storeRoot, plan);
          if (provenance) return provenance;
          options.validatePublicationData?.(decoded.data);
          const domainValidation = await options.validatePlanUnderLock?.(plan, {
            path: decoded.action.target,
            data: decoded.data,
            mode: decoded.mode,
          });
          if (domainValidation) return domainValidation;
          const finalProvenance = await validateStoreProvenance(operationEnv, storeRoot, plan);
          if (finalProvenance) return finalProvenance;
          guarded = await options.secretPublicationGuard.prepare(operationEnv, storeRoot);
          operationEnv = guarded.env;
          validateFinalPublicationBytes(
            options,
            { path: decoded.action.target, data: decoded.data, mode: decoded.mode },
            guarded.knownValues,
          );
          return null;
        },
      },
    );
    return { plan, changedFields: decoded.changedFields, operation };
  } finally {
    if (!suppliedLease) await authorityLease.release();
  }
}

function validateFinalPublicationBytes(
  options: Pick<StoreMutationPlanBindings, "validateFinalPublicationBytes">,
  publication: StorePublicationInput,
  knownValues: readonly SecretValue[],
): void {
  if (options.validateFinalPublicationBytes) {
    options.validateFinalPublicationBytes(publication, knownValues);
    return;
  }
  assertFinalSerializedSecretBytes(publication.data, knownValues, publication.path);
}

function decodeSelfContainedPublicationPlan(
  plan: MutationPlan,
  options: {
    readonly allowedMutationKinds: readonly string[];
    readonly requiredTarget: string;
    readonly requiredProvenancePathsByMutationKind?: Readonly<Record<string, readonly string[]>>;
    readonly requiredNormalizedInputKeys?: readonly string[];
  },
): {
  readonly action: MutationPlanAction;
  readonly data: string;
  readonly mode: number;
  readonly changedFields: readonly string[];
} | null {
  const inputs = plan.normalizedInputs;
  if (
    !hasExactKeys(inputs, [
      "changedFields",
      "mutationKind",
      "storeProvenance",
      ...(options.requiredNormalizedInputKeys ?? []),
    ])
  ) {
    return null;
  }
  const mutationKind = inputs.mutationKind;
  const changedFields = inputs.changedFields;
  const provenance = decodeStoreProvenance(plan);
  if (
    typeof mutationKind !== "string" ||
    !options.allowedMutationKinds.includes(mutationKind) ||
    !Array.isArray(changedFields) ||
    !changedFields.every((field) => typeof field === "string" && field.length > 0) ||
    new Set(changedFields).size !== changedFields.length ||
    !provenance
  ) {
    return null;
  }
  const requiredProvenance = options.requiredProvenancePathsByMutationKind?.[mutationKind];
  if (
    requiredProvenance &&
    provenance
      .map(({ path }) => path)
      .sort()
      .join("\0") !== [...requiredProvenance].sort().join("\0")
  ) {
    return null;
  }
  const action = plan.actions[0];
  const precondition = plan.targetPreconditions[0];
  if (
    plan.actions.length !== 1 ||
    plan.targetPreconditions.length !== 1 ||
    !action ||
    !precondition ||
    action.kind !== "publish-file" ||
    action.target !== options.requiredTarget ||
    precondition.actionId !== action.actionId ||
    precondition.target !== action.target ||
    !action.postcondition ||
    action.postcondition.state !== "present" ||
    !hasExactKeys(action.payload, ["data", "digest", "mode", "path"])
  ) {
    return null;
  }
  const { data, digest, mode, path } = action.payload;
  if (
    typeof data !== "string" ||
    typeof digest !== "string" ||
    typeof mode !== "number" ||
    mode !== 0o600 ||
    path !== action.target ||
    sha256(data) !== digest ||
    action.postcondition.fingerprint !== digest ||
    action.actionId !==
      publicationActionId(mutationKind, { path: action.target, data, digest, mode }, 0)
  ) {
    return null;
  }
  return { action, data, mode, changedFields };
}

export async function captureStoreProvenance(
  env: Env,
  storeRoot: string,
  paths: readonly string[],
): Promise<readonly StoreProvenanceDescriptor[]> {
  const normalizedRoot = resolve(env.cwd(), storeRoot);
  const normalized = paths
    .map((path) => resolve(env.cwd(), path))
    .sort((a, b) => a.localeCompare(b));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError("Store mutation provenance paths must be unique");
  }
  const provenance: StoreProvenanceDescriptor[] = [];
  // Each real snapshot worker has an explicit total-byte/output budget. Keep the path set
  // sequential so several individually bounded large snapshots cannot multiply peak IPC memory.
  for (const path of normalized) {
    const snapshot = await captureAnchoredSafeRecursiveSource(env, normalizedRoot, path);
    provenance.push(
      snapshot
        ? {
            path,
            expected: { state: "present" as const, fingerprint: snapshot.fingerprint },
          }
        : { path, expected: { state: "absent" as const } },
    );
  }
  return provenance;
}

export function decodeStoreProvenance(
  plan: MutationPlan,
): readonly StoreProvenanceDescriptor[] | null {
  const value = plan.normalizedInputs.storeProvenance;
  if (!Array.isArray(value)) return null;
  const decoded: StoreProvenanceDescriptor[] = [];
  for (const descriptor of value) {
    if (
      !hasExactKeys(descriptor, ["expected", "path"]) ||
      typeof descriptor.path !== "string" ||
      descriptor.path.length === 0 ||
      !isTargetStateReceipt(descriptor.expected)
    ) {
      return null;
    }
    decoded.push({ path: descriptor.path, expected: descriptor.expected });
  }
  if (new Set(decoded.map(({ path }) => path)).size !== decoded.length) return null;
  return decoded;
}

export async function validateStoreProvenance(
  env: Env,
  storeRoot: string,
  plan: MutationPlan,
): Promise<OperationResult | null> {
  const provenance = decodeStoreProvenance(plan);
  if (!provenance) return invalidPlanResult();
  let current: readonly StoreProvenanceDescriptor[];
  try {
    current = await captureStoreProvenance(
      env,
      storeRoot,
      provenance.map(({ path }) => path),
    );
  } catch {
    return invalidPlanResult();
  }
  if (canonicalProvenance(provenance) !== canonicalProvenance(current)) return invalidPlanResult();
  return null;
}

function canonicalProvenance(provenance: readonly StoreProvenanceDescriptor[]): string {
  return JSON.stringify(
    provenance.map(({ path, expected }) =>
      expected.state === "absent"
        ? { path, expected: { state: "absent" } }
        : { path, expected: { state: "present", fingerprint: expected.fingerprint } },
    ),
  );
}

function isTargetStateReceipt(value: unknown): value is TargetStateReceipt {
  if (!isPlainRecord(value)) return false;
  if (value.state === "absent") return hasExactKeys(value, ["state"]);
  if (value.state !== "present" || typeof value.fingerprint !== "string") return false;
  return hasExactKeys(value, ["fingerprint", "state"]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isPlainRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

async function prepareFinalStorePublicationEnv(
  guard: StorePublicationSecretGuard | undefined,
  env: Env,
  storeRoot: string,
) {
  if (!guard) throw new TypeError("final Store publication has no secret observation port");
  return guard.prepare(env, storeRoot);
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
