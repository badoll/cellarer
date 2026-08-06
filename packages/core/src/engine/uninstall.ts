import { isAbsolute, join, normalize } from "node:path";
import type { Env } from "../env.js";
import type {
  SyncProfileTargetEvidence,
  TargetAcknowledgement,
  TargetClassification,
  TargetOwner,
} from "../model/index.js";
import {
  assertCurrentMutationAuthorityScope,
  assertStrictMutationPlanRuntime,
  type CurrentMutationAuthorityScope,
  canonicalJson,
  createAuthorizedMutationPlan,
  verifyMutationPlanAuthorization,
  verifyMutationPlanDigest,
  withCurrentMutationAuthorityScope,
} from "../protocol/canonical.js";
import {
  assertMutationPlanActionAlignment,
  executeMutationPlan,
  invalidPlanResult,
  targetState,
} from "../protocol/execute.js";
import type {
  CanonicalJsonObject,
  MutationPlan,
  OperationActionReceipt,
  OperationResult,
  PlanExpiry,
  TargetStateReceipt,
} from "../protocol/models.js";
import { observeAtStableStoreRevision } from "../protocol/store-revision.js";
import { sha256 } from "../store/checksum.js";
import {
  duplicateTargetOwnerKeys,
  entryKey,
  loadLedgerForPlanning,
  makeLedger,
  serializeLedger,
} from "../store/ledger.js";
import { inspectTargetOwnership } from "../target-ownership.js";
import {
  assertExecutableGitignoreMutation,
  assertGitignoreMutationMatchesLedger,
  executeGitignoreMutation,
  planGitignoreMutation,
  projectTargetsUnder,
} from "./gitignore-sync.js";

export interface SyncTargetUninstallOptions {
  readonly storeRoot: string;
  readonly targetKeys: readonly string[];
  readonly acknowledgements?: readonly string[];
  readonly syncProfile?: SyncProfileTargetEvidence;
}

export interface SyncTargetUninstallTarget {
  readonly key: string;
  readonly target: string;
  readonly agent: string;
  readonly scope: TargetOwner["scope"];
  readonly capability: TargetOwner["capability"];
  readonly artifactIds: readonly string[];
  readonly classification: TargetClassification;
  readonly currentFingerprint: string | null;
  readonly expectedReceiptFingerprint: string;
  readonly blocked: boolean;
  readonly blockReason?: string;
  readonly acknowledgement?: TargetAcknowledgement;
  readonly driftOverridden: boolean;
  readonly ownerSyncProfile?: SyncProfileTargetEvidence;
}

export interface SyncTargetUninstallConflict {
  readonly code:
    | "UNINSTALL_TARGET_DRIFTED"
    | "UNINSTALL_TARGET_INVALID_OWNER"
    | "UNINSTALL_TARGET_NOT_FOUND"
    | "UNINSTALL_PROFILE_OWNER_MISMATCH";
  readonly key: string;
  readonly target: string;
  readonly message: string;
  readonly acknowledgement?: TargetAcknowledgement;
}

export interface PlannedSyncTargetUninstall {
  readonly targets: readonly SyncTargetUninstallTarget[];
  readonly conflicts: readonly SyncTargetUninstallConflict[];
  readonly mutationPlan: MutationPlan;
}

export interface AppliedSyncTargetUninstall extends PlannedSyncTargetUninstall {
  readonly uninstalled: readonly TargetOwner[];
  readonly operation: OperationResult;
}

interface BuildOptions {
  readonly planId?: string;
  readonly expires?: PlanExpiry;
}

interface BuiltUninstall {
  readonly targets: readonly SyncTargetUninstallTarget[];
  readonly conflicts: readonly SyncTargetUninstallConflict[];
  readonly selectedOwners: readonly TargetOwner[];
  readonly remainingOwners: readonly TargetOwner[];
  readonly productActionCount: number;
  readonly mutationPlan: MutationPlan;
}

export class SyncTargetUninstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SyncTargetUninstallError";
  }
}

export async function planSyncTargetUninstall(
  env: Env,
  opts: SyncTargetUninstallOptions,
): Promise<PlannedSyncTargetUninstall> {
  return withCurrentMutationAuthorityScope(env, (authorityScope) =>
    planSyncTargetUninstallWithinAuthorityScope(env, opts, authorityScope),
  );
}

export async function planSyncTargetUninstallWithinAuthorityScope(
  env: Env,
  opts: SyncTargetUninstallOptions,
  authorityScope: CurrentMutationAuthorityScope,
): Promise<PlannedSyncTargetUninstall> {
  await assertCurrentMutationAuthorityScope(env, authorityScope);
  const options = normalizeOptions(opts);
  const built = await buildUninstall(env, options);
  return projectPlan(built);
}

export async function applySyncTargetUninstallPlan(
  env: Env,
  mutationPlan: MutationPlan,
  context: { readonly storeRoot: string; readonly options: SyncTargetUninstallOptions },
): Promise<AppliedSyncTargetUninstall> {
  try {
    return await withCurrentMutationAuthorityScope(env, (authorityScope) =>
      applySyncTargetUninstallPlanWithinAuthorityScope(env, mutationPlan, context, authorityScope),
    );
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyncTargetUninstallError) {
      return invalidApplied(mutationPlan);
    }
    throw error;
  }
}

export async function applySyncTargetUninstallPlanWithinAuthorityScope(
  env: Env,
  mutationPlan: MutationPlan,
  context: { readonly storeRoot: string; readonly options: SyncTargetUninstallOptions },
  authorityScope: CurrentMutationAuthorityScope,
  validateCanonicalEvidenceUnderLock?: () => Promise<boolean>,
): Promise<AppliedSyncTargetUninstall> {
  const lease = await assertCurrentMutationAuthorityScope(env, authorityScope);
  let options: SyncTargetUninstallOptions;
  try {
    options = normalizeOptions(context.options);
    assertStrictMutationPlanRuntime(mutationPlan, "sync-uninstall");
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyncTargetUninstallError) {
      return invalidApplied(mutationPlan);
    }
    throw error;
  }
  if (
    context.storeRoot !== options.storeRoot ||
    !verifyMutationPlanAuthorization(env, options.storeRoot, mutationPlan) ||
    !verifyMutationPlanDigest(mutationPlan)
  ) {
    return invalidApplied(mutationPlan);
  }

  try {
    await assertCurrentMutationAuthorityScope(env, authorityScope);
    assertMutationPlanActionAlignment(mutationPlan);
    let expected = await buildUninstall(env, options, {
      planId: mutationPlan.planId,
      expires: mutationPlan.expires,
    });
    if (
      expected.targets.some((target) => target.blocked) ||
      canonicalJson(expected.mutationPlan) !== canonicalJson(mutationPlan)
    ) {
      return invalidApplied(mutationPlan);
    }

    let uninstalled: TargetOwner[] = [];
    const operation = await executeMutationPlan(
      env,
      options.storeRoot,
      mutationPlan,
      async (_operationId, record, authorize) => {
        const actionReceipts: OperationActionReceipt[] = [];
        const failedActionIds: string[] = [];
        const successfulOwnerKeys = new Set<string>();
        for (const [index, owner] of expected.selectedOwners.entries()) {
          const action = mutationPlan.actions[index];
          if (!action || action.target !== owner.target || action.kind !== "remove-target") {
            throw new TypeError("sync uninstall action is not bound to its owner");
          }
          const authorized = await authorize(action.actionId);
          if (!authorized.ok) {
            actionReceipts.push(authorized.receipt);
            failedActionIds.push(action.actionId);
            break;
          }
          let failure: { code: string; message: string } | undefined;
          try {
            await env.fs.rm(owner.target, { recursive: true, force: true });
            const after = await targetState(env, owner.target);
            if (after.state !== "absent") {
              throw Object.assign(new Error("sync uninstall postcondition failed"), {
                code: "ACTION_POSTCONDITION_FAILED",
              });
            }
          } catch (error) {
            const code = controlledIoCode(error);
            if (!code) throw error;
            failure = { code, message: `filesystem action failed (${code})` };
            failedActionIds.push(action.actionId);
          }
          const after = await targetState(env, owner.target);
          const receipt: OperationActionReceipt = {
            actionId: action.actionId,
            target: owner.target,
            outcome: failure
              ? "failed"
              : sameTargetReceipt(authorized.before, after)
                ? "unchanged"
                : "applied",
            before: authorized.before,
            after,
            recordedAt: env.now().toISOString(),
            ...(failure ? { error: failure } : {}),
          };
          await record(receipt);
          actionReceipts.push(receipt);
          if (failure) break;
          successfulOwnerKeys.add(entryKey(owner));
        }
        if (failedActionIds.length === 0) {
          for (const action of mutationPlan.actions.slice(expected.productActionCount)) {
            assertExecutableGitignoreMutation(action);
            assertGitignoreMutationMatchesLedger(action, makeLedger([...expected.remainingOwners]));
            const authorized = await authorize(action.actionId);
            if (!authorized.ok) {
              actionReceipts.push(authorized.receipt);
              failedActionIds.push(action.actionId);
              break;
            }
            let failure: { code: string; message: string } | undefined;
            try {
              await executeGitignoreMutation(env, action);
            } catch (error) {
              const code = controlledIoCode(error);
              if (!code) throw error;
              failure = { code, message: `filesystem action failed (${code})` };
              failedActionIds.push(action.actionId);
            }
            const after = await targetState(env, action.target);
            const receipt: OperationActionReceipt = {
              actionId: action.actionId,
              target: action.target,
              outcome: failure
                ? "failed"
                : sameTargetReceipt(authorized.before, after)
                  ? "unchanged"
                  : "applied",
              before: authorized.before,
              after,
              recordedAt: env.now().toISOString(),
              ...(failure ? { error: failure } : {}),
            };
            await record(receipt);
            actionReceipts.push(receipt);
            if (failure) break;
          }
        }
        const allSucceeded =
          failedActionIds.length === 0 &&
          successfulOwnerKeys.size === expected.selectedOwners.length;
        if (allSucceeded) uninstalled = [...expected.selectedOwners];
        return {
          actionReceipts,
          ...(failedActionIds.length > 0 ? { failedActionIds } : {}),
          ...(allSucceeded
            ? {
                statePublications: [
                  {
                    path: join(options.storeRoot, "state.json"),
                    data: serializeLedger(makeLedger([...expected.remainingOwners])),
                    mode: 0o600,
                  },
                ],
              }
            : {}),
        };
      },
      {
        authorityLease: lease,
        validateBeforeObservationUnderLock: async () => {
          await assertCurrentMutationAuthorityScope(env, authorityScope);
          const lockedExpected = await buildUninstall(env, options, {
            planId: mutationPlan.planId,
            expires: mutationPlan.expires,
          });
          if (
            lockedExpected.targets.some((target) => target.blocked) ||
            canonicalJson(lockedExpected.mutationPlan) !== canonicalJson(mutationPlan) ||
            (validateCanonicalEvidenceUnderLock && !(await validateCanonicalEvidenceUnderLock()))
          ) {
            return invalidPlanResult();
          }
          expected = lockedExpected;
          return null;
        },
      },
    );
    return { ...projectPlan(expected), uninstalled, operation };
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyncTargetUninstallError) {
      return invalidApplied(mutationPlan);
    }
    throw error;
  }
}

async function buildUninstall(
  env: Env,
  opts: SyncTargetUninstallOptions,
  buildOptions: BuildOptions = {},
): Promise<BuiltUninstall> {
  const observed = await observeAtStableStoreRevision(env, opts.storeRoot, async () => {
    const ledger = await loadLedgerForPlanning(env, opts.storeRoot);
    const duplicateKeys = new Set(duplicateTargetOwnerKeys(ledger.owners));
    const selectedOwners: TargetOwner[] = [];
    const targets: SyncTargetUninstallTarget[] = [];
    const conflicts: SyncTargetUninstallConflict[] = [];

    for (const key of opts.targetKeys) {
      const owners = ledger.owners.filter((owner) => entryKey(owner) === key);
      if (owners.length !== 1 || duplicateKeys.has(key)) {
        targets.push({
          key,
          target: owners[0]?.target ?? "unresolved",
          agent: owners[0]?.agent ?? "unresolved",
          scope: owners[0]?.scope ?? "global",
          capability: owners[0]?.capability ?? "skills",
          artifactIds: owners[0]?.artifactIds ?? [],
          classification: "invalid-owner",
          currentFingerprint: null,
          expectedReceiptFingerprint: owners[0]?.receipt.fingerprint ?? "unresolved",
          blocked: true,
          blockReason:
            owners.length === 0
              ? "owned target key was not found"
              : "owned target key is ambiguous",
          driftOverridden: false,
        });
        conflicts.push({
          code:
            owners.length === 0 ? "UNINSTALL_TARGET_NOT_FOUND" : "UNINSTALL_TARGET_INVALID_OWNER",
          key,
          target: owners[0]?.target ?? "unresolved",
          message:
            owners.length === 0
              ? "owned target key was not found"
              : "owned target key is ambiguous",
        });
        continue;
      }
      const owner = owners[0];
      if (!owner) continue;
      const inspection = await inspectTargetOwnership(env, {
        agent: owner.agent,
        scope: owner.scope,
        capability: owner.capability,
        target: owner.target,
        ...(owner.scope === "project" ? { dir: owner.projectRoot } : {}),
        owners: ledger.owners,
      });
      const classification: TargetClassification =
        inspection.classification === "absent" && inspection.owner
          ? "owned-drifted"
          : inspection.classification;
      const acknowledgement =
        classification === "owned-drifted"
          ? uninstallAcknowledgement(owner, classification, inspection.fingerprint)
          : undefined;
      const driftOverridden =
        acknowledgement !== undefined &&
        opts.acknowledgements?.includes(acknowledgement.token) === true;
      let blocked = false;
      let blockReason: string | undefined;
      if (
        opts.syncProfile &&
        canonicalJson(owner.syncProfile ?? null) !== canonicalJson(opts.syncProfile)
      ) {
        blocked = true;
        blockReason = "owned target belongs to a different sync profile selection";
        conflicts.push({
          code: "UNINSTALL_PROFILE_OWNER_MISMATCH",
          key,
          target: owner.target,
          message: blockReason,
        });
      } else if (classification === "owned-drifted" && !driftOverridden) {
        blocked = true;
        blockReason = "owned target has drifted; exact uninstall acknowledgement required";
        conflicts.push({
          code: "UNINSTALL_TARGET_DRIFTED",
          key,
          target: owner.target,
          message: blockReason,
          acknowledgement,
        });
      } else if (classification !== "owned-current" && !driftOverridden) {
        blocked = true;
        blockReason = inspection.reason ?? "target ownership is invalid";
        conflicts.push({
          code: "UNINSTALL_TARGET_INVALID_OWNER",
          key,
          target: owner.target,
          message: blockReason,
        });
      }
      targets.push({
        key,
        target: owner.target,
        agent: owner.agent,
        scope: owner.scope,
        capability: owner.capability,
        artifactIds: [...owner.artifactIds].sort((left, right) => left.localeCompare(right)),
        classification,
        currentFingerprint: inspection.fingerprint,
        expectedReceiptFingerprint: owner.receipt.fingerprint,
        blocked,
        ...(blockReason ? { blockReason } : {}),
        ...(acknowledgement ? { acknowledgement } : {}),
        driftOverridden,
        ...(owner.syncProfile ? { ownerSyncProfile: owner.syncProfile } : {}),
      });
      if (!blocked) selectedOwners.push(owner);
    }
    const selectedKeys = new Set(selectedOwners.map(entryKey));
    return {
      targets,
      conflicts,
      selectedOwners,
      remainingOwners: ledger.owners.filter((owner) => !selectedKeys.has(entryKey(owner))),
    };
  });

  const productActions = observed.value.selectedOwners.map((owner, index) => ({
    actionId: uninstallActionId(owner, index),
    kind: "remove-target",
    target: owner.target,
    payload: jsonObject({
      ownerKey: entryKey(owner),
      artifactIds: [...owner.artifactIds].sort((left, right) => left.localeCompare(right)),
      receiptFingerprint: owner.receipt.fingerprint,
      ...(owner.syncProfile ? { syncProfile: owner.syncProfile } : {}),
    }),
    postcondition: { state: "absent" as const },
  }));
  const remainingLedger = makeLedger([...observed.value.remainingOwners]);
  const projectDirs = [
    ...new Set(
      observed.value.selectedOwners.flatMap((owner) =>
        owner.scope === "project" && owner.projectRoot ? [owner.projectRoot] : [],
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const helpers = await Promise.all(
    projectDirs.map((projectDir) =>
      planGitignoreMutation(env, projectDir, projectTargetsUnder(remainingLedger, projectDir)),
    ),
  );
  const actions = [...productActions, ...helpers.map((helper) => helper.action)];
  const targetPreconditions = [
    ...(await Promise.all(
      productActions.map(async (action) => ({
        actionId: action.actionId,
        target: action.target,
        expected: await targetState(env, action.target),
      })),
    )),
    ...helpers.map((helper) => helper.precondition),
  ];
  const mutationPlan = createAuthorizedMutationPlan(env, opts.storeRoot, {
    schemaVersion: 1,
    planId: buildOptions.planId ?? `plan-${env.randomId()}`,
    operation: "sync-uninstall",
    baseRevision: observed.revision,
    normalizedInputs: jsonObject({
      mutationKind: "sync-target-uninstall",
      businessInput: {
        targetKeys: opts.targetKeys,
        acknowledgements: opts.acknowledgements ?? [],
        ...(opts.syncProfile ? { syncProfile: opts.syncProfile } : {}),
      },
      capabilitySnapshot: observed.value.targets.map((target) => ({
        key: target.key,
        agent: target.agent,
        scope: target.scope,
        capability: target.capability,
        target: target.target,
        expectedReceiptFingerprint: target.expectedReceiptFingerprint,
      })),
      targets: observed.value.targets,
    }),
    targetPreconditions,
    actions,
    expires: buildOptions.expires ?? { policy: "none" },
  });
  return {
    ...observed.value,
    productActionCount: productActions.length,
    mutationPlan,
  };
}

function uninstallAcknowledgement(
  owner: TargetOwner,
  classification: TargetClassification,
  currentFingerprint: string | null,
): TargetAcknowledgement {
  const kind = "uninstall-drift" as const;
  return {
    kind,
    token: sha256(
      JSON.stringify({
        version: 1,
        kind,
        ownerKey: entryKey(owner),
        classification,
        currentFingerprint,
        expectedReceipt: owner.receipt,
        artifactIds: [...owner.artifactIds].sort((left, right) => left.localeCompare(right)),
        proposedAction: "remove-target",
      }),
    ),
  };
}

function uninstallActionId(owner: TargetOwner, index: number): string {
  return sha256(
    JSON.stringify({
      mutationKind: "sync-target-uninstall",
      index,
      ownerKey: entryKey(owner),
      target: owner.target,
      receiptFingerprint: owner.receipt.fingerprint,
    }),
  );
}

function normalizeOptions(opts: SyncTargetUninstallOptions): SyncTargetUninstallOptions {
  if (typeof opts.storeRoot !== "string" || !isAbsolute(opts.storeRoot)) {
    throw new SyncTargetUninstallError("INVALID_INPUT", "storeRoot must be absolute");
  }
  if (
    !Array.isArray(opts.targetKeys) ||
    opts.targetKeys.length === 0 ||
    !opts.targetKeys.every((key) => typeof key === "string" && key.length > 0)
  ) {
    throw new SyncTargetUninstallError(
      "INVALID_INPUT",
      "sync target uninstall requires exact owned target keys",
    );
  }
  const targetKeys = [...new Set(opts.targetKeys)].sort((left, right) => left.localeCompare(right));
  if (targetKeys.length !== opts.targetKeys.length) {
    throw new SyncTargetUninstallError("INVALID_INPUT", "owned target keys must be unique");
  }
  const acknowledgements = opts.acknowledgements
    ? [...new Set(opts.acknowledgements)].sort((left, right) => left.localeCompare(right))
    : undefined;
  if (
    acknowledgements &&
    (acknowledgements.length !== opts.acknowledgements?.length ||
      !acknowledgements.every((token) => /^sha256:[0-9a-f]{64}$/.test(token)))
  ) {
    throw new SyncTargetUninstallError(
      "INVALID_INPUT",
      "uninstall acknowledgements must be unique exact tokens",
    );
  }
  return {
    storeRoot: normalize(opts.storeRoot),
    targetKeys,
    ...(acknowledgements ? { acknowledgements } : {}),
    ...(opts.syncProfile ? { syncProfile: normalizeSyncProfile(opts.syncProfile) } : {}),
  };
}

function normalizeSyncProfile(evidence: SyncProfileTargetEvidence): SyncProfileTargetEvidence {
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    !/^[A-Za-z0-9._-]+$/.test(evidence.profileId) ||
    !/^sha256:[0-9a-f]{64}$/.test(evidence.profileRevision) ||
    !Array.isArray(evidence.resolvedResources) ||
    evidence.resolvedResources.some(
      (resource) =>
        !/^(rules|mcp|skills)\/[A-Za-z0-9._-]+$/.test(resource.resourceId) ||
        !/^sha256:[0-9a-f]{64}$/.test(resource.revision) ||
        !["rules", "mcp", "skills"].includes(resource.capability),
    )
  ) {
    throw new SyncTargetUninstallError("INVALID_INPUT", "sync profile evidence is invalid");
  }
  const resolvedResources = evidence.resolvedResources
    .map((resource) => ({ ...resource }))
    .sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  if (
    new Set(resolvedResources.map((resource) => resource.resourceId)).size !==
    resolvedResources.length
  ) {
    throw new SyncTargetUninstallError("INVALID_INPUT", "sync profile resources must be unique");
  }
  return {
    profileId: evidence.profileId,
    profileRevision: evidence.profileRevision,
    resolvedResources,
  };
}

function projectPlan(built: BuiltUninstall): PlannedSyncTargetUninstall {
  return {
    targets: built.targets,
    conflicts: built.conflicts,
    mutationPlan: built.mutationPlan,
  };
}

function invalidApplied(mutationPlan: MutationPlan): AppliedSyncTargetUninstall {
  return {
    targets: [],
    conflicts: [],
    mutationPlan,
    uninstalled: [],
    operation: invalidPlanResult(),
  };
}

function sameTargetReceipt(left: TargetStateReceipt, right: TargetStateReceipt): boolean {
  return (
    left.state === right.state &&
    (left.state === "absent" ||
      (right.state === "present" && left.fingerprint === right.fingerprint))
  );
}

function controlledIoCode(error: unknown): string | null {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" &&
    [
      "EACCES",
      "EDQUOT",
      "EFBIG",
      "EIO",
      "ENOSPC",
      "EPERM",
      "EROFS",
      "ESTALE",
      "ACTION_POSTCONDITION_FAILED",
      "PUBLICATION_POSTCONDITION_FAILED",
    ].includes(code)
    ? code
    : null;
}

function jsonObject(value: unknown): CanonicalJsonObject {
  return JSON.parse(JSON.stringify(value)) as CanonicalJsonObject;
}
