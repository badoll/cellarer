// Revert is plan-first: inspect every selected physical target, expose exact preconditions, then
// mutate eligible targets once. Ownership is removed only after that target was restored/removed.
import { dirname, join, normalize, relative, sep } from "node:path";
import { appendActivity } from "../activity.js";
import type { Env, MutationAuthorityLease } from "../env.js";
import { lstatOrNull } from "../fs/probe.js";
import { isPathInside } from "../fs/safety.js";
import type {
  AppliedReceipt,
  Ledger,
  LedgerEntry,
  TargetAcknowledgement,
  TargetConflict,
  TargetOwnershipEvidence,
} from "../model/index.js";
import {
  acquireCurrentMutationAuthorityLease,
  canonicalJson,
  createAuthorizedMutationPlan,
  requireMutationAuthority,
  withCurrentMutationAuthorityLease,
} from "../protocol/canonical.js";
import {
  type AuthorizeOperationAction,
  invalidPlanResult,
  type RecordOperationAction,
  targetState,
} from "../protocol/execute.js";
import type {
  ActionPrecondition,
  CanonicalJsonObject,
  MutationPlan,
  MutationPlanAction,
  OperationActionReceipt,
  TargetStateReceipt,
} from "../protocol/models.js";
import { resolveAuthorizedMutationOperationAdapter } from "../protocol/operation-adapter.js";
import { executePreparedMutationOperation } from "../protocol/operation-execution.js";
import { mutationPresentation } from "../protocol/presentation.js";
import { PublicationPostconditionError } from "../protocol/publication.js";
import { observeAtStableStoreRevision } from "../protocol/store-revision.js";
import { sha256 } from "../store/checksum.js";
import {
  duplicateTargetOwnerKeys,
  entryKey,
  loadLedgerForPlanning,
  makeLedger,
  matchesFilter,
  prepareLedgerAfterSelectiveRevert,
  serializeLedger,
} from "../store/ledger.js";
import { fingerprintTarget, inspectTargetOwnership } from "../target-ownership.js";
import {
  decryptTargetSnapshot,
  fingerprintTargetSnapshotNodeState,
  inspectEncryptedTargetSnapshot,
  readAuthorizedEncryptedTargetSnapshot,
  restoreTargetSnapshot,
} from "../target-snapshot.js";
import {
  assertExecutableGitignoreMutation,
  assertGitignoreMutationMatchesLedger,
  executeGitignoreMutation,
  planGitignoreMutation,
  projectTargetsUnder,
} from "./gitignore-sync.js";
import type {
  MutationPlanOptions,
  PlannedRevertMutation,
  RevertCallResult,
  RevertFailure,
  RevertMutationContext,
  RevertMutationResult,
  RevertOptions,
  RevertPlan,
  RevertPlanTarget,
  RevertProposedAction,
  RevertResult,
  RevertSnapshotAvailability,
} from "./types.js";

interface BuiltRevertPlan {
  ledger: Ledger;
  plan: RevertPlan;
  duplicateOwnerKeys: string[];
}

class SnapshotPassphraseRequiredError extends Error {
  constructor(target: string) {
    super(`encrypted snapshot restoration for "${target}" requires a snapshot passphrase`);
    this.name = "SnapshotPassphraseRequiredError";
  }
}

export async function planRevert(env: Env, opts: RevertOptions): Promise<RevertPlan> {
  return (await buildRevertPlan(env, opts)).plan;
}

export async function revert(env: Env, opts: RevertOptions): Promise<RevertCallResult> {
  return withCurrentMutationAuthorityLease(env, async (authorityLease) => {
    const prepared = await planRevertMutation(env, opts, {}, { authorityLease });
    const eligible = prepared.plan.targets.filter((target) => !target.blocked);
    if (opts.dryRun) {
      return {
        plan: prepared.plan,
        reverted: eligible.flatMap((target) => target.owners),
        failures: [],
        warnings: [...prepared.plan.warnings],
        mutation: mutationPresentation(prepared.mutationPlan),
      };
    }
    const { operation: _operation, ...result } = await applyRevertMutationPlan(
      env,
      prepared.mutationPlan,
      {
        storeRoot: opts.storeRoot,
        options: opts,
        snapshotPassphrase: opts.snapshotPassphrase,
        keepBackups: opts.keepBackups,
      },
      { authorityLease },
    );
    return result;
  });
}

export async function planRevertMutation(
  env: Env,
  opts: RevertOptions,
  planOptions: MutationPlanOptions = {},
  execution: { authorityLease?: MutationAuthorityLease } = {},
): Promise<PlannedRevertMutation> {
  requireMutationAuthority(env);
  const suppliedLease = execution.authorityLease;
  const authorityLease =
    suppliedLease ?? (await acquireCurrentMutationAuthorityLease(env).catch(() => null));
  if (!authorityLease || !(await authorityLease.isCurrent().catch(() => false))) {
    if (authorityLease && !suppliedLease) await authorityLease.release().catch(() => undefined);
    throw new TypeError("mutation authority is not current");
  }
  try {
    return await planRevertMutationWithAuthorityLease(env, opts, planOptions);
  } finally {
    if (!suppliedLease) await authorityLease.release();
  }
}

async function planRevertMutationWithAuthorityLease(
  env: Env,
  opts: RevertOptions,
  planOptions: MutationPlanOptions,
): Promise<PlannedRevertMutation> {
  requireMutationAuthority(env);
  const observed = await observeAtStableStoreRevision(env, opts.storeRoot, async () => {
    const built = await buildRevertPlan(env, opts);
    const eligible = built.plan.targets.filter((target) => !target.blocked);
    const reverted = eligible.flatMap((target) => target.owners);
    const revertedKeys = new Set(reverted.map(entryKey));
    const remaining: Ledger = {
      version: built.ledger.version,
      owners: built.ledger.owners.filter((owner) => !revertedKeys.has(entryKey(owner))),
    };
    const gitignores = await Promise.all(
      affectedGitignoreDirs(reverted).map((dir) =>
        planGitignoreMutation(env, dir, projectTargetsUnder(remaining, dir)),
      ),
    );
    return { built, gitignores };
  });
  const { plan } = observed.value.built;
  const eligible = plan.targets.filter((target) => !target.blocked);
  const actions: MutationPlanAction[] = eligible.map((target, index) => {
    const actionId = revertMutationActionId(target, index);
    return {
      actionId,
      kind: target.proposedAction,
      target: target.target,
      payload: { revertTarget: jsonObject(target) },
    };
  });
  const targetPreconditions: ActionPrecondition[] = eligible.map((target, index) => ({
    actionId: revertMutationActionId(target, index),
    target: target.target,
    expected:
      target.ownership.currentFingerprint === null
        ? ({ state: "absent" } as const)
        : ({
            state: "present",
            fingerprint: target.ownership.currentFingerprint,
          } as const),
  }));
  for (const gitignore of observed.value.gitignores) {
    actions.push(gitignore.action);
    targetPreconditions.push(gitignore.precondition);
  }
  const normalizedInputs = jsonObject({
    storeRoot: opts.storeRoot,
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.dir ? { dir: opts.dir } : {}),
    ...(opts.agents ? { agents: opts.agents } : {}),
    ...(opts.artifactIds ? { artifactIds: opts.artifactIds } : {}),
    ...(opts.acknowledgements ? { acknowledgements: opts.acknowledgements } : {}),
    ...(opts.keepBackups !== undefined ? { keepBackups: opts.keepBackups } : {}),
    revertPlan: plan,
  });
  const prepared = {
    plan,
    mutationPlan: createAuthorizedMutationPlan(env, opts.storeRoot, {
      schemaVersion: 1,
      planId: planOptions.planId ?? `plan-${env.randomId()}`,
      operation: "revert",
      baseRevision: observed.revision,
      normalizedInputs,
      targetPreconditions,
      actions,
      expires: planOptions.expires ?? { policy: "none" },
    }),
  };
  return prepared;
}

export async function applyRevertMutationPlan(
  env: Env,
  mutationPlan: MutationPlan,
  context: RevertMutationContext,
  execution: { readonly authorityLease?: MutationAuthorityLease } = {},
): Promise<RevertMutationResult> {
  if (!resolveAuthorizedMutationOperationAdapter(env, context.storeRoot, mutationPlan, "revert")) {
    return invalidRevertMutationResult();
  }
  const suppliedLease = execution.authorityLease;
  const authorityLease =
    suppliedLease ?? (await acquireCurrentMutationAuthorityLease(env).catch(() => null));
  if (!authorityLease) return invalidRevertMutationResult();
  if (!(await authorityLease.isCurrent().catch(() => false))) {
    if (!suppliedLease) await authorityLease.release().catch(() => undefined);
    return invalidRevertMutationResult();
  }
  try {
    return await applyRevertMutationPlanWithAuthorityLease(
      env,
      mutationPlan,
      context,
      authorityLease,
    );
  } finally {
    if (!suppliedLease) await authorityLease.release();
  }
}

async function applyRevertMutationPlanWithAuthorityLease(
  env: Env,
  mutationPlan: MutationPlan,
  context: RevertMutationContext,
  authorityLease: MutationAuthorityLease,
): Promise<RevertMutationResult> {
  let plan: RevertPlan = { targets: [], conflicts: [], warnings: [] };
  let revertedResult: RevertResult | undefined;
  let decoded: ReturnType<typeof decodeRevertMutation>;
  let ledger: Ledger;
  let currentExecutionPlan: RevertPlan;
  let trustedOptions: RevertOptions;
  try {
    trustedOptions = assertTrustedRevertOptions(context);
    decoded = decodeRevertMutation(mutationPlan);
    assertRevertOptionsMatchTrustedContext(decoded.opts, trustedOptions);
    const reconstructed = await planRevertMutation(
      env,
      trustedOptions,
      {
        planId: mutationPlan.planId,
        expires: mutationPlan.expires,
      },
      { authorityLease },
    );
    if (canonicalJson(reconstructed.mutationPlan) !== canonicalJson(mutationPlan)) {
      throw new TypeError("revert mutation plan does not match canonical reconstruction");
    }
    ledger = await loadLedgerForPlanning(env, context.storeRoot);
    currentExecutionPlan = bindRevertOwnersToCurrentLedger(decoded.executionPlan, ledger);
    assertRevertExecutionAuthorization(env, mutationPlan, decoded, currentExecutionPlan, ledger);
  } catch {
    return invalidRevertMutationResult();
  }
  plan = decoded.plan;
  const operation = await executePreparedMutationOperation(
    env,
    context.storeRoot,
    mutationPlan,
    async (_operationId, recordAction, authorizeAction) => {
      const executed = await executeRevertPlan(
        env,
        {
          ledger,
          plan: currentExecutionPlan,
          duplicateOwnerKeys: duplicateTargetOwnerKeys(ledger.owners),
        },
        {
          ...decoded.opts,
          snapshotPassphrase: context.snapshotPassphrase ?? trustedOptions.snapshotPassphrase,
          keepBackups:
            context.keepBackups ?? trustedOptions.keepBackups ?? decoded.opts.keepBackups,
        },
        mutationPlan,
        recordAction,
        authorizeAction,
      );
      revertedResult = executed.result;
      return {
        actionReceipts: executed.actionReceipts,
        failedActionIds: executed.failedActionIds,
        ...(executed.statePublications ? { statePublications: executed.statePublications } : {}),
        ...(executed.afterCommit ? { afterCommit: executed.afterCommit } : {}),
      };
    },
    { authorityLease },
  );
  return {
    ...(revertedResult ?? { plan, reverted: [], failures: [], warnings: [...plan.warnings] }),
    plan,
    operation,
    mutation: mutationPresentation(mutationPlan, operation),
  };
}

function assertRevertOptionsMatchTrustedContext(
  supplied: RevertOptions,
  trusted: RevertOptions,
): void {
  const trustedSignedOptions: RevertOptions = {
    storeRoot: trusted.storeRoot,
    ...(trusted.scope ? { scope: trusted.scope } : {}),
    ...(trusted.dir ? { dir: trusted.dir } : {}),
    ...(trusted.agents ? { agents: trusted.agents } : {}),
    ...(trusted.artifactIds ? { artifactIds: trusted.artifactIds } : {}),
    ...(trusted.acknowledgements ? { acknowledgements: trusted.acknowledgements } : {}),
    ...(trusted.keepBackups !== undefined ? { keepBackups: trusted.keepBackups } : {}),
  };
  if (canonicalJson(jsonObject(supplied)) !== canonicalJson(jsonObject(trustedSignedOptions))) {
    throw new TypeError("revert mutation options do not match the trusted execution context");
  }
}

function assertTrustedRevertOptions(context: RevertMutationContext): RevertOptions {
  const options = context.options;
  if (
    !options ||
    options.storeRoot !== context.storeRoot ||
    options.dryRun === true ||
    (context.keepBackups !== undefined &&
      options.keepBackups !== undefined &&
      context.keepBackups !== options.keepBackups)
  ) {
    throw new TypeError("revert mutation context does not contain trusted canonical options");
  }
  return options;
}

function invalidRevertMutationResult(): RevertMutationResult {
  const operation = invalidPlanResult();
  const plan: RevertPlan = { targets: [], conflicts: [], warnings: [] };
  return {
    plan,
    reverted: [],
    failures: [],
    warnings: [],
    operation,
    mutation: {
      planId: "untrusted",
      planDigest: "untrusted",
      operation: "revert",
      baseRevision: 0,
      result: operation,
    },
  };
}

function bindRevertOwnersToCurrentLedger(plan: RevertPlan, ledger: Ledger): RevertPlan {
  return {
    ...plan,
    targets: plan.targets.map((target) => ({
      ...target,
      owners: target.owners.map((plannedOwner) => {
        const current = ledger.owners.find(
          (owner) =>
            entryKey(owner) === entryKey(plannedOwner) &&
            canonicalJson(JSON.parse(JSON.stringify(owner))) ===
              canonicalJson(JSON.parse(JSON.stringify(plannedOwner))),
        );
        if (!current) {
          throw new Error(
            `ownership state changed after revert planning for ${entryKey(plannedOwner)}`,
          );
        }
        return current;
      }),
    })),
  };
}

async function executeRevertPlan(
  env: Env,
  built: BuiltRevertPlan,
  opts: RevertOptions,
  mutationPlan: MutationPlan,
  recordAction: RecordOperationAction,
  authorizeAction: AuthorizeOperationAction,
): Promise<{
  result: RevertResult;
  actionReceipts: OperationActionReceipt[];
  failedActionIds: string[];
  statePublications?: { path: string; data: string; mode: number }[];
  afterCommit?: () => Promise<void>;
}> {
  const { ledger, plan, duplicateOwnerKeys } = built;
  const warnings = [...plan.warnings];
  const eligible = plan.targets.filter((target) => !target.blocked);

  const reverted: LedgerEntry[] = [];
  const failures: RevertFailure[] = [];
  const actionReceipts: OperationActionReceipt[] = [];
  const failedActionIds: string[] = [];
  const retainedBackups = new Set<string>();
  const successfulKeys = new Set<string>();

  for (const [index, target] of eligible.entries()) {
    const mutationAction = mutationPlan.actions[index];
    const precondition = mutationPlan.targetPreconditions.find(
      (candidate) => candidate.actionId === mutationAction?.actionId,
    );
    if (!mutationAction || !precondition || mutationAction.target !== target.target) {
      throw new Error(`revert target ${target.target} is not aligned with its mutation receipt`);
    }
    const authorized = await authorizeAction(mutationAction.actionId);
    if (!authorized.ok) {
      const failure: RevertFailure = {
        code: "REVERT_FAILED",
        target: target.target,
        message:
          authorized.receipt.error?.message ??
          "target changed after the operation journal started executing",
      };
      actionReceipts.push(authorized.receipt);
      failedActionIds.push(mutationAction.actionId);
      failures.push(failure);
      break;
    }
    let effect: {
      backup: string | null;
      expectedAfter:
        | { kind: "target-state"; receipt: TargetStateReceipt }
        | { kind: "snapshot-node"; fingerprint: string };
    };
    try {
      effect = await revertOne(env, opts.storeRoot, target, opts.snapshotPassphrase);
    } catch (error) {
      const failure: RevertFailure = {
        code:
          error instanceof SnapshotPassphraseRequiredError
            ? "SNAPSHOT_PASSPHRASE_REQUIRED"
            : "REVERT_FAILED",
        target: target.target,
        message: error instanceof Error ? error.message : String(error),
      };
      const receipt: OperationActionReceipt = {
        actionId: mutationAction.actionId,
        target: target.target,
        outcome: "failed",
        before: precondition.expected,
        after: await targetState(env, target.target),
        recordedAt: env.now().toISOString(),
        error: {
          code: error instanceof PublicationPostconditionError ? error.code : failure.code,
          message: failure.message,
        },
      };
      await recordAction(receipt);
      actionReceipts.push(receipt);
      failedActionIds.push(mutationAction.actionId);
      failures.push(failure);
      continue;
    }
    const after = await targetState(env, target.target);
    const afterMatches =
      effect.expectedAfter.kind === "target-state"
        ? sameTargetReceipt(effect.expectedAfter.receipt, after)
        : (await fingerprintTargetSnapshotNodeState(env, target.target)) ===
          effect.expectedAfter.fingerprint;
    if (!afterMatches) {
      const error = new PublicationPostconditionError(target.target, "revert after-state");
      const failure: RevertFailure = {
        code: "REVERT_FAILED",
        target: target.target,
        message: error.message,
      };
      const receipt: OperationActionReceipt = {
        actionId: mutationAction.actionId,
        target: target.target,
        outcome: "failed",
        before: precondition.expected,
        after,
        recordedAt: env.now().toISOString(),
        error: { code: error.code, message: error.message },
      };
      await recordAction(receipt);
      actionReceipts.push(receipt);
      failedActionIds.push(mutationAction.actionId);
      failures.push(failure);
      continue;
    }
    const receipt: OperationActionReceipt = {
      actionId: mutationAction.actionId,
      target: target.target,
      outcome: sameTargetReceipt(precondition.expected, after) ? "unchanged" : "applied",
      before: precondition.expected,
      after,
      recordedAt: env.now().toISOString(),
    };
    await recordAction(receipt);
    actionReceipts.push(receipt);
    for (const owner of target.owners) {
      const key = entryKey(owner);
      if (successfulKeys.has(key)) continue;
      successfulKeys.add(key);
      reverted.push(owner);
    }
    if (effect.backup) retainedBackups.add(effect.backup);
  }

  let remaining = ledger;
  let serializedRemaining: string | undefined;
  if (failures.length === 0 && reverted.length > 0) {
    if (duplicateOwnerKeys.length > 0) {
      const prepared = await prepareLedgerAfterSelectiveRevert(
        env,
        opts.storeRoot,
        ledger,
        reverted,
      );
      remaining = prepared.ledger;
      serializedRemaining = prepared.serialized;
    } else {
      remaining = makeLedger(
        ledger.owners.filter((owner) => !successfulKeys.has(entryKey(owner))),
        ledger.version,
      );
      serializedRemaining = serializeLedger(remaining);
    }
  }

  const gitignoreActions = mutationPlan.actions.slice(eligible.length);
  if (failures.length === 0) {
    for (const action of gitignoreActions) {
      const precondition = mutationPlan.targetPreconditions.find(
        (candidate) => candidate.actionId === action.actionId,
      );
      if (!precondition || action.kind !== "sync-gitignore") {
        throw new Error(
          `revert gitignore action ${action.actionId} is not aligned with its receipt`,
        );
      }
      const authorized = await authorizeAction(action.actionId);
      if (!authorized.ok) {
        const failure: RevertFailure = {
          code: "REVERT_FAILED",
          target: action.target,
          message:
            authorized.receipt.error?.message ??
            "target changed after the operation journal started executing",
        };
        actionReceipts.push(authorized.receipt);
        failedActionIds.push(action.actionId);
        failures.push(failure);
        break;
      }
      assertGitignoreMutationMatchesLedger(action, remaining);
      try {
        await executeGitignoreMutation(env, action);
      } catch (error) {
        if (!isControlledActionIoFailure(error)) throw error;
        const errorCode = actionIoFailureCode(error);
        const failure: RevertFailure = {
          code: "REVERT_FAILED",
          target: action.target,
          message: `filesystem action failed (${errorCode})`,
        };
        const receipt: OperationActionReceipt = {
          actionId: action.actionId,
          target: action.target,
          outcome: "failed",
          before: precondition.expected,
          after: await targetState(env, action.target),
          recordedAt: env.now().toISOString(),
          error: { code: errorCode, message: failure.message },
        };
        await recordAction(receipt);
        actionReceipts.push(receipt);
        failedActionIds.push(action.actionId);
        failures.push(failure);
        continue;
      }
      const after = await targetState(env, action.target);
      const receipt: OperationActionReceipt = {
        actionId: action.actionId,
        target: action.target,
        outcome: sameTargetReceipt(precondition.expected, after) ? "unchanged" : "applied",
        before: precondition.expected,
        after,
        recordedAt: env.now().toISOString(),
      };
      await recordAction(receipt);
      actionReceipts.push(receipt);
    }
  }

  const afterCommit =
    failures.length === 0
      ? async () => {
          if (reverted.length > 0) {
            if (opts.keepBackups === false) {
              for (const backup of retainedBackups) {
                warnings.push(
                  `retained encrypted recovery snapshot "${backup}" because automatic snapshot deletion is unsupported`,
                );
              }
            }
          }

          // Preserve the existing activity contract for an explicit non-dry revert, including safe no-ops.
          await recordRevertActivity(env, opts, reverted, warnings);
        }
      : undefined;

  return {
    result: { plan, reverted, failures, warnings },
    actionReceipts,
    failedActionIds,
    ...(failures.length === 0 && reverted.length > 0
      ? {
          statePublications: [
            {
              path: join(opts.storeRoot, "state.json"),
              data: serializedRemaining ?? serializeLedger(remaining),
              mode: 0o600,
            },
          ],
          afterCommit,
        }
      : failures.length === 0
        ? { afterCommit }
        : {}),
  };
}

function revertMutationActionId(target: RevertPlanTarget, index: number): string {
  return sha256(JSON.stringify({ index, action: target.proposedAction, target: target.target }));
}

function jsonObject(value: unknown): CanonicalJsonObject {
  return JSON.parse(JSON.stringify(value)) as CanonicalJsonObject;
}

function decodeRevertMutation(planReceipt: MutationPlan): {
  opts: RevertOptions;
  plan: RevertPlan;
  executionPlan: RevertPlan;
} {
  const input = planReceipt.normalizedInputs as Record<string, unknown>;
  const inputKeys = ["revertPlan", "storeRoot"];
  for (const key of ["scope", "dir", "agents", "artifactIds", "acknowledgements", "keepBackups"]) {
    if (key in input) inputKeys.push(key);
  }
  if (
    !hasExactKeys(input, inputKeys) ||
    typeof input.storeRoot !== "string" ||
    typeof input.revertPlan !== "object" ||
    input.revertPlan === null ||
    !hasExactKeys(input.revertPlan, ["conflicts", "targets", "warnings"]) ||
    !Array.isArray(input.revertPlan.targets) ||
    !Array.isArray(input.revertPlan.conflicts) ||
    !Array.isArray(input.revertPlan.warnings) ||
    !input.revertPlan.warnings.every((warning) => typeof warning === "string")
  ) {
    throw new TypeError("revert mutation plan has invalid normalized inputs");
  }
  const plan = input.revertPlan as unknown as RevertPlan;
  const targets: RevertPlanTarget[] = [];
  let reachedGitignore = false;
  for (const mutationAction of planReceipt.actions) {
    if (mutationAction.kind === "sync-gitignore") {
      reachedGitignore = true;
      if (
        !hasExactKeys(mutationAction, ["actionId", "kind", "payload", "target"]) ||
        !hasExactKeys(mutationAction.payload, [
          "digest",
          "effect",
          "mode",
          "path",
          "projectDir",
          "targets",
        ])
      ) {
        throw new TypeError("revert mutation plan has an invalid action payload");
      }
      assertExecutableGitignoreMutation(mutationAction);
      continue;
    }
    if (reachedGitignore) throw new TypeError("revert mutation plan has invalid action ordering");
    if (
      !hasExactKeys(mutationAction, ["actionId", "kind", "payload", "target"]) ||
      !hasExactKeys(mutationAction.payload, ["revertTarget"])
    ) {
      throw new TypeError("revert mutation plan has an invalid action payload");
    }
    const target = mutationAction.payload.revertTarget as unknown;
    const targetKeys = [
      "blocked",
      "driftOverridden",
      "expectedReceipt",
      "owners",
      "ownership",
      "proposedAction",
      "snapshot",
      "target",
    ];
    if (typeof target === "object" && target !== null) {
      if ("consumerSet" in target) targetKeys.push("consumerSet");
      if ("blockReason" in target) targetKeys.push("blockReason");
      if ("acknowledgement" in target) targetKeys.push("acknowledgement");
    }
    const candidate = target as unknown as RevertPlanTarget;
    if (
      !hasExactKeys(target, targetKeys) ||
      typeof candidate.target !== "string" ||
      !["detach-consumer", "remove-target", "restore-snapshot"].includes(
        candidate.proposedAction,
      ) ||
      candidate.blocked !== false ||
      !Array.isArray(candidate.owners) ||
      candidate.owners.length === 0 ||
      candidate.target !== mutationAction.target ||
      candidate.proposedAction !== mutationAction.kind
    ) {
      throw new TypeError("revert mutation plan has an invalid action payload");
    }
    targets.push(candidate);
  }
  const opts: RevertOptions = {
    storeRoot: input.storeRoot,
    ...(input.scope === "global" || input.scope === "project" ? { scope: input.scope } : {}),
    ...(typeof input.dir === "string" ? { dir: input.dir } : {}),
    ...(Array.isArray(input.agents) && input.agents.every((agent) => typeof agent === "string")
      ? { agents: input.agents as string[] }
      : {}),
    ...(Array.isArray(input.artifactIds) &&
    input.artifactIds.every((artifact) => typeof artifact === "string")
      ? { artifactIds: input.artifactIds as string[] }
      : {}),
    ...(Array.isArray(input.acknowledgements) &&
    input.acknowledgements.every((token) => typeof token === "string")
      ? { acknowledgements: input.acknowledgements as string[] }
      : {}),
    ...(typeof input.keepBackups === "boolean" ? { keepBackups: input.keepBackups } : {}),
  };
  if (
    ("scope" in input && opts.scope === undefined) ||
    ("dir" in input && opts.dir === undefined) ||
    ("agents" in input && opts.agents === undefined) ||
    ("artifactIds" in input && opts.artifactIds === undefined) ||
    ("acknowledgements" in input && opts.acknowledgements === undefined) ||
    ("keepBackups" in input && opts.keepBackups === undefined) ||
    new Set(opts.agents ?? []).size !== (opts.agents?.length ?? 0) ||
    new Set(opts.artifactIds ?? []).size !== (opts.artifactIds?.length ?? 0) ||
    new Set(opts.acknowledgements ?? []).size !== (opts.acknowledgements?.length ?? 0)
  ) {
    throw new TypeError("revert mutation plan has invalid normalized inputs");
  }
  return {
    opts,
    plan,
    executionPlan: { ...plan, targets },
  };
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertRevertExecutionAuthorization(
  env: Env,
  mutationPlan: MutationPlan,
  decoded: ReturnType<typeof decodeRevertMutation>,
  executionPlan: RevertPlan,
  ledger: Ledger,
): void {
  const eligible = decoded.plan.targets.filter((target) => !target.blocked);
  const productActions = mutationPlan.actions.filter((action) => action.kind !== "sync-gitignore");
  if (
    eligible.length !== executionPlan.targets.length ||
    productActions.length !== executionPlan.targets.length
  ) {
    throw new TypeError("revert mutation plan does not match its executable target set");
  }
  const roots = allowedRevertRoots(env, decoded.opts);
  for (const [index, target] of executionPlan.targets.entries()) {
    const action = productActions[index];
    const normalizedTarget = eligible[index];
    const primaryOwner = target.owners[0];
    const precondition = mutationPlan.targetPreconditions.find(
      (candidate) => candidate.actionId === action?.actionId,
    );
    if (
      !action ||
      !normalizedTarget ||
      canonicalJson(jsonObject(target)) !== canonicalJson(jsonObject(normalizedTarget)) ||
      action.actionId !== revertMutationActionId(target, index) ||
      !precondition ||
      !roots.some((root) => isPathInside(target.target, root)) ||
      target.ownership.target !== target.target ||
      !primaryOwner ||
      target.ownership.key !== entryKey(primaryOwner) ||
      target.owners.some(
        (owner) =>
          owner.target !== target.target ||
          canonicalJson(jsonObject(owner.receipt)) !==
            canonicalJson(jsonObject(target.expectedReceipt)),
      ) ||
      (target.ownership.currentFingerprint === null
        ? precondition.expected.state !== "absent"
        : precondition.expected.state !== "present" ||
          precondition.expected.fingerprint !== target.ownership.currentFingerprint)
    ) {
      throw new TypeError("revert mutation target authorization is invalid");
    }
    const currentConsumers = ledger.owners.filter((owner) => owner.target === target.target);
    if (ledger.version === 3) {
      const exactKeys = currentConsumers.map(entryKey).sort();
      if (
        canonicalJson(target.consumerSet ?? []) !== canonicalJson(exactKeys) ||
        (target.proposedAction === "detach-consumer") !==
          currentConsumers.length > target.owners.length
      ) {
        throw new TypeError("revert consumer set changed after planning");
      }
    } else throw new TypeError("explicit deployment upgrade required before revert");
    if (
      target.proposedAction === "detach-consumer" ||
      normalizedTarget.ownership.classification !== "owned-drifted"
    ) {
      if (target.acknowledgement !== undefined || target.driftOverridden) {
        throw new TypeError("revert mutation acknowledgement is unexpected");
      }
    } else {
      if (!target.driftOverridden || target.acknowledgement?.kind !== "revert-drift") {
        throw new TypeError("revert mutation acknowledgement was not authorized");
      }
      if (!decoded.opts.acknowledgements?.includes(target.acknowledgement.token)) {
        throw new TypeError("revert mutation acknowledgement token was not supplied");
      }
    }
  }

  const reverted = executionPlan.targets.flatMap((target) => target.owners);
  const revertedKeys = new Set(reverted.map(entryKey));
  const remaining: Ledger = {
    version: ledger.version,
    owners: ledger.owners.filter((owner) => !revertedKeys.has(entryKey(owner))),
  };
  const helpers = mutationPlan.actions.slice(productActions.length);
  const expectedDirs = affectedGitignoreDirs(reverted);
  const helperDirs = helpers.map((action) => action.payload.projectDir);
  if (
    helpers.length !== expectedDirs.length ||
    expectedDirs.some((dir, index) => helperDirs[index] !== dir)
  ) {
    throw new TypeError("revert gitignore actions do not match the affected project set");
  }
  for (const helper of helpers) {
    assertExecutableGitignoreMutation(helper);
    assertGitignoreMutationMatchesLedger(helper, remaining);
  }
}

function sameTargetReceipt(
  before: { state: "absent" } | { state: "present"; fingerprint: string },
  after: { state: "absent" } | { state: "present"; fingerprint: string },
): boolean {
  return (
    before.state === after.state &&
    (before.state === "absent" ||
      (after.state === "present" && before.fingerprint === after.fingerprint))
  );
}

async function buildRevertPlan(env: Env, opts: RevertOptions): Promise<BuiltRevertPlan> {
  const ledger = await loadLedgerForPlanning(env, opts.storeRoot);
  const duplicateOwnerKeys = duplicateTargetOwnerKeys(ledger.owners);
  const selected = ledger.owners.filter(
    (owner) =>
      matchesFilter(owner, opts) &&
      (!opts.artifactIds ||
        opts.artifactIds.length === 0 ||
        owner.artifactIds.some((id) => opts.artifactIds?.includes(id))),
  );
  const allByPhysicalTarget = groupByPhysicalTarget(ledger.owners);
  const selectedByPhysicalTarget = groupByPhysicalTarget(selected);
  const roots = allowedRevertRoots(env, opts);
  const warnings: string[] = [];
  const conflicts: TargetConflict[] = [];
  const targets: RevertPlanTarget[] = [];

  for (const [target, owners] of selectedByPhysicalTarget) {
    const primary = owners[0];
    if (!primary) continue;
    const allOwners = allByPhysicalTarget.get(target) ?? owners;
    let invalidReason: string | undefined;
    const detach = ledger.version === 3 && allOwners.length > owners.length;
    if (ledger.version === 2) {
      invalidReason = "explicit deployment upgrade required before revert";
    } else if (allOwners.length !== owners.length && !detach) {
      invalidReason = "the physical target also has an owner outside the revert selection";
    } else if (!owners.every((owner) => sameReceipt(primary.receipt, owner.receipt))) {
      invalidReason = "the physical target has owners with conflicting applied receipts";
    }

    let ownership: TargetOwnershipEvidence;
    if (target === "" || !roots.some((root) => isPathInside(target, root))) {
      invalidReason =
        invalidReason ??
        `target is outside managed roots [${roots.join(", ")}]. Pass --dir to include a project outside your home directory.`;
      ownership = ownershipEvidence(primary, "invalid-owner", null);
      warnings.push(
        `refusing to revert "${primary.agent}" target "${target}" — outside managed roots [${roots.join(", ")}]. Pass --dir to include a project outside your home directory.`,
      );
    } else if (invalidReason) {
      ownership = ownershipEvidence(primary, "invalid-owner", null);
    } else {
      const inspected = await inspectTargetOwnership(env, {
        agent: primary.agent,
        scope: primary.scope,
        capability: primary.capability,
        target,
        dir: primary.scope === "project" ? primary.projectRoot : opts.dir,
        owners: ledger.owners,
      });
      ownership = {
        key: entryKey(primary),
        classification: inspected.classification,
        target: inspected.target,
        currentFingerprint: inspected.fingerprint,
        expectedReceipt: primary.receipt,
      };
      invalidReason = inspected.reason;
    }

    const snapshot = await snapshotAvailability(
      env,
      opts.storeRoot,
      detach ? null : primary.receipt.backup,
    );
    const proposedAction: RevertProposedAction = detach
      ? "detach-consumer"
      : snapshot.status === "none"
        ? "remove-target"
        : "restore-snapshot";
    const acknowledgement =
      !detach && ownership.classification === "owned-drifted"
        ? revertAcknowledgement(owners, ownership, proposedAction)
        : undefined;
    const driftOverridden =
      acknowledgement !== undefined &&
      opts.acknowledgements?.includes(acknowledgement.token) === true;

    let blocked = false;
    let blockReason: string | undefined;
    if (!detach && ownership.classification === "owned-drifted" && !driftOverridden) {
      blocked = true;
      blockReason = "owned target has drifted; exact revert acknowledgement required";
    } else if (
      ownership.classification === "invalid-owner" ||
      ownership.classification === "unowned-existing"
    ) {
      blocked = true;
      blockReason = invalidReason ?? "target ownership is invalid";
    } else if (snapshot.status === "missing" || snapshot.status === "invalid") {
      blocked = true;
      blockReason =
        snapshot.status === "missing"
          ? "recorded recovery snapshot is missing"
          : "recorded recovery snapshot is outside the snapshot store or has an invalid type";
    }

    const item: RevertPlanTarget = {
      ...(ledger.version === 3 ? { consumerSet: allOwners.map(entryKey).sort() } : {}),
      target,
      owners,
      expectedReceipt: primary.receipt,
      ownership,
      snapshot,
      proposedAction,
      blocked,
      ...(blockReason ? { blockReason } : {}),
      ...(acknowledgement ? { acknowledgement } : {}),
      driftOverridden,
    };
    targets.push(item);

    if (blocked && ownership.classification === "owned-drifted") {
      conflicts.push({
        code: "REVERT_TARGET_DRIFTED",
        target,
        message: blockReason ?? "owned target has drifted",
        ownership,
        acknowledgement,
      });
    } else if (blocked && ownership.classification === "invalid-owner") {
      conflicts.push({
        code: "INVALID_TARGET_OWNER",
        target,
        message: blockReason ?? "target ownership is invalid",
        ownership,
      });
    } else if (blocked) {
      conflicts.push({
        code: "REVERT_SNAPSHOT_UNAVAILABLE",
        target,
        message: blockReason ?? "recovery snapshot is unavailable",
        ownership,
      });
    }
  }

  return { ledger, plan: { targets, conflicts, warnings }, duplicateOwnerKeys };
}

function groupByPhysicalTarget(owners: readonly LedgerEntry[]): Map<string, LedgerEntry[]> {
  const groups = new Map<string, LedgerEntry[]>();
  for (const owner of owners) {
    const target = normalize(owner.target);
    const group = groups.get(target) ?? [];
    group.push(owner);
    groups.set(target, group);
  }
  return groups;
}

function sameReceipt(left: AppliedReceipt, right: AppliedReceipt): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ownershipEvidence(
  owner: LedgerEntry,
  classification: TargetOwnershipEvidence["classification"],
  currentFingerprint: string | null,
): TargetOwnershipEvidence {
  return {
    key: entryKey(owner),
    classification,
    target: normalize(owner.target),
    currentFingerprint,
    expectedReceipt: owner.receipt,
  };
}

async function snapshotAvailability(
  env: Env,
  storeRoot: string,
  path: string | null,
): Promise<RevertSnapshotAvailability> {
  if (!path) return { path: null, status: "none", encrypted: false };
  const encrypted = path.endsWith(".age");
  const snapshotsRoot = join(storeRoot, "snapshots");
  if (!encrypted || !isPathInside(path, snapshotsRoot)) {
    return { path, status: "invalid", encrypted };
  }
  const rootStat = await lstatOrNull(env, snapshotsRoot);
  if (!rootStat) return { path, status: "missing", encrypted };
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { path, status: "invalid", encrypted };
  }
  const relParent = relative(snapshotsRoot, dirname(path));
  let ancestor = snapshotsRoot;
  for (const segment of relParent.length === 0 ? [] : relParent.split(sep)) {
    ancestor = join(ancestor, segment);
    const ancestorStat = await lstatOrNull(env, ancestor);
    if (!ancestorStat) return { path, status: "missing", encrypted };
    if (ancestorStat.isSymbolicLink() || !ancestorStat.isDirectory()) {
      return { path, status: "invalid", encrypted };
    }
  }
  const stat = await lstatOrNull(env, path);
  if (!stat) return { path, status: "missing", encrypted };
  if (!stat.isFile() || stat.isSymbolicLink()) return { path, status: "invalid", encrypted };
  try {
    const evidence = await inspectEncryptedTargetSnapshot(env, storeRoot, path);
    return {
      path,
      status: "available",
      encrypted,
      digest: evidence.digest,
      mode: evidence.mode,
    };
  } catch {
    return { path, status: "invalid", encrypted };
  }
}

function revertAcknowledgement(
  owners: LedgerEntry[],
  ownership: TargetOwnershipEvidence,
  proposedAction: RevertProposedAction,
): TargetAcknowledgement {
  const kind = "revert-drift" as const;
  return {
    kind,
    token: sha256(
      JSON.stringify({
        version: 1,
        kind,
        ownerKeys: owners.map(entryKey).sort(),
        classification: ownership.classification,
        currentFingerprint: ownership.currentFingerprint,
        expectedReceipt: ownership.expectedReceipt,
        proposedAction,
      }),
    ),
  };
}

async function revertOne(
  env: Env,
  storeRoot: string,
  target: RevertPlanTarget,
  snapshotPassphrase: string | undefined,
): Promise<{
  backup: string | null;
  expectedAfter:
    | { kind: "target-state"; receipt: TargetStateReceipt }
    | { kind: "snapshot-node"; fingerprint: string };
}> {
  // Re-check the exact disk receipt consumed by the plan before the first destructive effect.
  const currentFingerprint = await fingerprintTarget(env, target.target);
  if (currentFingerprint !== target.ownership.currentFingerprint) {
    throw new Error(`target "${target.target}" changed after revert planning`);
  }

  if (target.proposedAction === "detach-consumer") {
    return {
      backup: null,
      expectedAfter: {
        kind: "target-state",
        receipt:
          currentFingerprint === null
            ? { state: "absent" }
            : { state: "present", fingerprint: currentFingerprint },
      },
    };
  }
  if (target.snapshot.status === "none") {
    await env.fs.rm(target.target, { recursive: true, force: true });
    return {
      backup: null,
      expectedAfter: { kind: "target-state", receipt: { state: "absent" } },
    };
  }
  if (target.snapshot.status !== "available" || !target.snapshot.path) {
    throw new Error(`recorded recovery snapshot for "${target.target}" is unavailable`);
  }

  if (!snapshotPassphrase) throw new SnapshotPassphraseRequiredError(target.target);
  if (!target.snapshot.digest || target.snapshot.mode === undefined) {
    throw new Error(`recorded recovery snapshot for "${target.target}" lacks signed evidence`);
  }
  // The plan only permits managed .age snapshots. Decrypt and fully validate before mutation.
  const encrypted = await readAuthorizedEncryptedTargetSnapshot(env, storeRoot, {
    path: target.snapshot.path,
    digest: target.snapshot.digest,
    mode: target.snapshot.mode,
  });
  const snapshot = await decryptTargetSnapshot(encrypted, snapshotPassphrase);
  await restoreTargetSnapshot(env, target.target, snapshot, target.ownership.currentFingerprint);
  return {
    backup: target.snapshot.path,
    expectedAfter: { kind: "snapshot-node", fingerprint: snapshot.nodeFingerprint },
  };
}

function allowedRevertRoots(env: Env, opts: RevertOptions): string[] {
  const roots = [env.homedir(), env.cwd()];
  if (opts.dir) roots.push(opts.dir);
  return roots.map(normalize);
}

function affectedGitignoreDirs(reverted: LedgerEntry[]): string[] {
  const dirs = new Set<string>();
  for (const entry of reverted) {
    if (entry.scope !== "project") continue;
    if (!entry.projectRoot) {
      throw new Error(`project owner for ${entry.target} is missing its canonical projectRoot`);
    }
    dirs.add(entry.projectRoot);
  }
  return [...dirs].sort();
}

const CONTROLLED_ACTION_IO_CODES = new Set([
  "EACCES",
  "EDQUOT",
  "EFBIG",
  "EIO",
  "ENOSPC",
  "EPERM",
  "EROFS",
  "PUBLICATION_POSTCONDITION_FAILED",
]);

function actionIoFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN_IO_ERROR";
}

function isControlledActionIoFailure(error: unknown): boolean {
  return CONTROLLED_ACTION_IO_CODES.has(actionIoFailureCode(error));
}

async function recordRevertActivity(
  env: Env,
  opts: RevertOptions,
  reverted: LedgerEntry[],
  warnings: string[],
): Promise<void> {
  try {
    await appendActivity(env, opts.storeRoot, {
      action: "revert",
      scope: opts.scope,
      projectDir: opts.dir,
      agents: opts.agents ?? [...new Set(reverted.map((entry) => entry.agent))],
      capabilities: [...new Set(reverted.map((entry) => entry.capability))],
      affectedCount: reverted.length,
      warningsCount: warnings.length,
      summary: `Reverted ${reverted.length} ${reverted.length === 1 ? "target" : "targets"}`,
      resources: {
        ledgerEntryKeys: reverted.map(entryKey),
        artifactIds: reverted.flatMap((entry) => entry.artifactIds),
      },
      secretRefs: reverted.flatMap((entry) => entry.secretRefs ?? []),
    });
  } catch (error) {
    warnings.push(`activity log failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
