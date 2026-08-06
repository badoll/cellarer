// apply = plan + 执行 + 写台账(不变量 3/5)。dryRun 只返回 plan,不落地。
// 分派结构(M2 重构):按 PlanAction.op 查 handler 表,引擎不散写 if (cap === "rules" && op === "write")。
// 每个 op handler 负责一种落地动作(write/merge/overwrite/symlink/copy),返回写入台账的条目。
// op 未登记 handler → 显式抛错(防「plan 产出了某 op,apply 却静默忽略」),新增能力必须在此登记。
//
// 幂等关键:重复 apply 必须产出与磁盘一致的台账,且不丢失首次备份指针 ——
//   故复用既有台账条目的 backup;内容未变时保留 appliedAt 并跳过重写(避免 mtime 抖动)。

import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { z } from "zod";
import { appendActivity } from "../activity.js";
import type { Env, MutationAuthorityLease } from "../env.js";
import { atomicWrite } from "../fs/atomicWrite.js";
import { hashDir } from "../fs/hashDir.js";
import { linkOrCopy } from "../fs/linkOrCopy.js";
import { lstatOrNull } from "../fs/probe.js";
import { assertNotSymbolicLink, isWithinRoot } from "../fs/safety.js";
import type {
  Capability,
  DistributePlan,
  Ledger,
  LedgerEntry,
  PlanAction,
} from "../model/index.js";
import {
  acquireCurrentMutationAuthorityLease,
  assertStrictMutationPlanRuntime,
  canonicalJson,
  createAuthorizedMutationPlan,
  requireMutationAuthority,
  verifyMutationPlanAuthorization,
  verifyMutationPlanDigest,
  withCurrentMutationAuthorityLease,
} from "../protocol/canonical.js";
import {
  type AuthorizeOperationAction,
  assertMutationPlanActionAlignment,
  executeMutationPlan,
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
  OperationResult,
  TargetStateReceipt,
} from "../protocol/models.js";
import { mutationPresentation } from "../protocol/presentation.js";
import { PublicationPostconditionError } from "../protocol/publication.js";
import { captureStoreProvenance, validateStoreProvenance } from "../protocol/store-mutation.js";
import { observeAtStableStoreRevision } from "../protocol/store-revision.js";
import {
  attachProviderScope,
  configureProviderScope,
  createProviderScope,
  discoverSecretReferences,
  type ProviderScope,
  providerScopeForEnv,
  withProviderScope,
} from "../secrets/active-values.js";
import {
  attachObservableKnownValues,
  containsObservableKnownValue,
  observableKnownValues,
} from "../secrets/observable.js";
import {
  assertSafeRecursiveSnapshotCurrent,
  installSafeRecursiveSnapshot,
  type SafeRecursiveSnapshot,
  sliceSafeRecursiveSnapshot,
  UnsafeRecursiveSourceError,
} from "../secrets/safe-tree.js";
import { sha256 } from "../store/checksum.js";
import { loadConfig } from "../store/config.js";
import {
  addEntries,
  entryKey,
  loadLedger,
  loadLedgerForPlanning,
  serializeLedger,
} from "../store/ledger.js";
import { fingerprintTarget } from "../target-ownership.js";
import {
  createEncryptedTargetSnapshot,
  type EncryptedTargetSnapshot,
  SnapshotCreationError,
} from "../target-snapshot.js";
import {
  type CapabilityRootCapture,
  type CapabilityRootProvenanceDescriptor,
  captureCapabilityRootSnapshots,
} from "./capability-snapshot.js";
import {
  assertExecutableGitignoreMutation,
  assertGitignoreMutationMatchesLedger,
  executeGitignoreMutation,
  planGitignoreMutation,
  projectTargetsUnder,
} from "./gitignore-sync.js";
import {
  assertRecursiveSecretGuard,
  discoverActiveSecretValuesForActions,
} from "./plan/secret-guard.js";
import { plan } from "./plan.js";
import type {
  ApplyCallResult,
  ApplyFailure,
  ApplyMutationContext,
  ApplyMutationPlanPreflight,
  ApplyMutationResult,
  ApplyResult,
  DistributeOptions,
  MutationPlanOptions,
  PlannedApplyMutation,
} from "./types.js";

// op handler:执行一种落地动作并返回台账条目。prior 是同键既有条目(供幂等复用 backup/appliedAt)。
type OpHandler = (
  env: Env,
  action: PlanAction,
  prior: LedgerEntry | undefined,
  snapshotPath: string | undefined,
  projectRoot: string | undefined,
  sourceSnapshot: SafeRecursiveSnapshot | undefined,
) => Promise<LedgerEntry>;

interface ApplyContext {
  storeRoot: string;
  snapshotPassphrase?: string;
  projectRoot?: string;
}

interface AppliedAction {
  entry: LedgerEntry;
  snapshot?: EncryptedTargetSnapshot;
  transientSnapshotPath?: string;
}

// op → handler 分派表。新增 op 必须在此登记,否则 applyAction 抛错(避免「成功却什么都没写」)。
const OP_HANDLERS: Partial<Record<PlanAction["op"], OpHandler>> = {
  write: applyContentWrite, // rules:渲染整文件写入
  merge: applyContentWrite, // mcp:已在 plan 合并好,落地同为内容写入(generated:false,merge 进既有)
  overwrite: applyContentWrite,
  symlink: applyLink, // skills:目录级软链
  copy: applyLink, // skills:目录级拷贝(或软链回退)
};

const signedFingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const artifactIdSchema = z.string().regex(/^(rules|mcp|skills)\/[^/*,\s]+$/);
const artifactIdsSchema = z
  .array(artifactIdSchema)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length);
const secretRefsSchema = z
  .array(
    z
      .string()
      .min(1)
      .refine((name) => name.trim() === name && !/[{}\r\n]/.test(name)),
  )
  .refine((names) => new Set(names).size === names.length);
const appliedReceiptSchema = z
  .object({
    method: z.enum(["write", "symlink", "junction", "copy"]),
    fingerprint: signedFingerprintSchema,
    contentFingerprint: signedFingerprintSchema.optional(),
    sourceFingerprint: signedFingerprintSchema.optional(),
    backup: z.string().nullable(),
    generated: z.boolean(),
    appliedAt: z.string(),
  })
  .strict();
const ownershipSchema = z
  .object({
    key: z.string().min(1),
    classification: z.enum(["absent", "owned-current", "owned-drifted", "unowned-existing"]),
    target: z.string().refine(isAbsolute),
    currentFingerprint: signedFingerprintSchema.nullable(),
    expectedReceipt: appliedReceiptSchema.nullable(),
  })
  .strict();
const replacementSchema = z
  .object({
    acknowledgement: z
      .object({
        kind: z.enum(["replace-unowned", "override-drift"]),
        token: signedFingerprintSchema,
      })
      .strict(),
    snapshotRequired: z.literal(true),
  })
  .strict();
const generatedPreviewSchema = z
  .object({ before: z.string().optional(), after: z.string() })
  .strict();
const writeEvidenceSchema = z
  .object({
    method: z.literal("write"),
    contentFingerprint: signedFingerprintSchema,
    sourceFingerprint: z.never().optional(),
    sourceIdentity: z.never().optional(),
  })
  .strict();
const recursiveSourceEvidenceSchema = (method: "symlink" | "copy") =>
  z
    .object({
      method: z.literal(method),
      contentFingerprint: z.never().optional(),
      sourceFingerprint: signedFingerprintSchema,
      sourceIdentity: signedFingerprintSchema,
    })
    .strict();
const executableActionBase = {
  artifact: z.string().min(1),
  artifactIds: artifactIdsSchema,
  agent: z.string().min(1),
  scope: z.enum(["global", "project"]),
  target: z.string().refine(isAbsolute),
  reason: z.string().min(1),
  ownership: ownershipSchema,
  storeInputs: z
    .array(
      z
        .object({
          artifactId: z.string().min(1),
          path: z.string().refine(isAbsolute),
          fingerprint: signedFingerprintSchema,
        })
        .strict(),
    )
    .optional(),
  replacement: replacementSchema.optional(),
};
const executableApplyActionSchema = z.discriminatedUnion("op", [
  z
    .object({
      ...executableActionBase,
      artifact: z.literal("rules/*"),
      capability: z.literal("rules"),
      source: z.never().optional(),
      method: z.enum(["symlink", "copy"]),
      op: z.literal("write"),
      preview: generatedPreviewSchema,
      secretRefs: z.never().optional(),
      accidentalPlaintext: z.never().optional(),
      desiredEvidence: writeEvidenceSchema,
    })
    .strict(),
  ...(["merge", "overwrite"] as const).map((op) =>
    z
      .object({
        ...executableActionBase,
        capability: z.literal("mcp"),
        source: z.never().optional(),
        method: z.literal("copy"),
        op: z.literal(op),
        preview: generatedPreviewSchema,
        secretRefs: secretRefsSchema,
        accidentalPlaintext: z.literal(false),
        desiredEvidence: writeEvidenceSchema,
      })
      .strict(),
  ),
  ...(["symlink", "copy"] as const).map((op) =>
    z
      .object({
        ...executableActionBase,
        capability: z.literal("skills"),
        source: z.string().refine(isAbsolute),
        method: z.literal(op),
        op: z.literal(op),
        preview: z.never().optional(),
        secretRefs: z.never().optional(),
        accidentalPlaintext: z.never().optional(),
        desiredEvidence: recursiveSourceEvidenceSchema(op),
      })
      .strict(),
  ),
]);

export async function apply(env: Env, opts: DistributeOptions): Promise<ApplyCallResult> {
  return withCurrentMutationAuthorityLease(env, async (authorityLease) => {
    const config = await loadConfig(env, opts.storeRoot);
    const scope = createProviderScope({
      secretMode: opts.secretMode ?? config.defaults.secretMode,
      vaultPassphrase: opts.vaultPassphrase,
      keychainService: opts.keychainService,
    });
    const operationEnv = withProviderScope(env, scope);
    const prepared = await planApplyMutation(operationEnv, opts, {}, { authorityLease });
    const distributePlan = prepared.plan;

    // Duplicate physical owners make the ledger globally unsafe to update. Planning already exposes
    // the target-keyed conflict, so non-dry apply returns the same blocked result without reopening
    // the ledger through the strict mutation path or performing any effect.
    if (
      opts.dryRun ||
      distributePlan.invalidLedger ||
      distributePlan.secretFindings?.length ||
      distributePlan.secretReferenceFindings?.length
    ) {
      return attachProviderScope(
        {
          plan: distributePlan,
          entries: [],
          failures: [],
          mutation: mutationPresentation(prepared.mutationPlan),
        },
        scope,
      );
    }

    const { operation: _operation, ...result } = await applyMutationPlan(
      operationEnv,
      prepared.mutationPlan,
      {
        storeRoot: opts.storeRoot,
        options: opts,
        snapshotPassphrase: opts.snapshotPassphrase,
        secretMode: opts.secretMode,
        vaultPassphrase: opts.vaultPassphrase,
        keychainService: opts.keychainService,
      },
      { authorityLease },
    );
    return attachProviderScope(result, scope);
  });
}

export async function planApplyMutation(
  env: Env,
  opts: DistributeOptions,
  planOptions: MutationPlanOptions = {},
  execution: {
    providerAccess?: "allowed" | "forbidden";
    authorityLease?: MutationAuthorityLease;
  } = {},
): Promise<PlannedApplyMutation> {
  requireMutationAuthority(env);
  const suppliedLease = execution.authorityLease;
  const authorityLease =
    suppliedLease ?? (await acquireCurrentMutationAuthorityLease(env).catch(() => null));
  if (!authorityLease || !(await authorityLease.isCurrent().catch(() => false))) {
    if (authorityLease && !suppliedLease) await authorityLease.release().catch(() => undefined);
    throw new TypeError("mutation authority is not current");
  }
  try {
    return await planApplyMutationWithAuthorityLease(env, opts, planOptions, execution);
  } finally {
    if (!suppliedLease) await authorityLease.release();
  }
}

async function planApplyMutationWithAuthorityLease(
  env: Env,
  opts: DistributeOptions,
  planOptions: MutationPlanOptions,
  execution: { providerAccess?: "allowed" | "forbidden" },
): Promise<PlannedApplyMutation> {
  requireMutationAuthority(env);
  const requestedCapabilities = opts.capabilities ?? ["rules"];
  const initialCapabilityRoots = await captureCapabilityRootSnapshots(
    env,
    opts.storeRoot,
    requestedCapabilities,
  );
  const provenancePaths = distributionStoreProvenancePaths(env, opts);
  const initialProvenance = await captureStoreProvenance(env, opts.storeRoot, provenancePaths);
  const config = await loadConfig(env, opts.storeRoot);
  const scope =
    providerScopeForEnv(env) ??
    createProviderScope({
      secretMode: opts.secretMode ?? config.defaults.secretMode,
      vaultPassphrase: opts.vaultPassphrase,
      keychainService: opts.keychainService,
    });
  const operationEnv = providerScopeForEnv(env) ? env : withProviderScope(env, scope);
  const observed = await observeAtStableStoreRevision(operationEnv, opts.storeRoot, async () => {
    const provenanceBefore = await captureStoreProvenance(
      operationEnv,
      opts.storeRoot,
      provenancePaths,
    );
    if (canonicalJson(initialProvenance) !== canonicalJson(provenanceBefore)) {
      throw new TypeError("distribution Store provenance changed while planning");
    }
    const capabilityRootsBefore = await captureCapabilityRootSnapshots(
      operationEnv,
      opts.storeRoot,
      requestedCapabilities,
    );
    if (!sameCapabilityRootDescriptors(initialCapabilityRoots, capabilityRootsBefore)) {
      throw new TypeError("distribution capability roots changed while planning");
    }
    const distributePlan = await plan(operationEnv, opts, {
      ...execution,
      capabilityRootCapture: capabilityRootsBefore,
    });
    const executable = distributePlan.actions.filter((action) => action.op !== "skip");
    const gitignore =
      opts.scope === "project" && opts.dir
        ? await planGitignoreMutation(operationEnv, opts.dir, [
            ...projectTargetsUnder(
              await loadLedgerForPlanning(operationEnv, opts.storeRoot),
              opts.dir,
            ),
            ...executable.map((action) => action.target),
          ])
        : undefined;
    const provenanceAfter = await captureStoreProvenance(
      operationEnv,
      opts.storeRoot,
      provenancePaths,
    );
    if (canonicalJson(provenanceBefore) !== canonicalJson(provenanceAfter)) {
      throw new TypeError("distribution Store provenance changed while planning");
    }
    const capabilityRootsAfter = await captureCapabilityRootSnapshots(
      operationEnv,
      opts.storeRoot,
      requestedCapabilities,
    );
    if (!sameCapabilityRootDescriptors(capabilityRootsBefore, capabilityRootsAfter)) {
      throw new TypeError("distribution capability roots changed while planning");
    }
    return {
      distributePlan,
      gitignore,
      storeProvenance: provenanceBefore,
      capabilityRootProvenance: capabilityRootsBefore.descriptors,
    };
  });
  const { distributePlan, gitignore, storeProvenance, capabilityRootProvenance } = observed.value;
  const effectiveSecretMode = opts.secretMode ?? config.defaults.secretMode;
  const effectiveKeychainService = opts.keychainService ?? "cellarer";
  const executable = distributePlan.actions.filter((action) => action.op !== "skip");
  const actions: MutationPlanAction[] = executable.map((action, index) => {
    const actionId = mutationActionId(action, index);
    return {
      actionId,
      kind: action.op,
      target: action.target,
      payload: { planAction: jsonObject(action) },
    };
  });
  const targetPreconditions: ActionPrecondition[] = executable.map((action, index) => ({
    actionId: mutationActionId(action, index),
    target: action.target,
    expected:
      action.ownership?.currentFingerprint === null || !action.ownership
        ? ({ state: "absent" } as const)
        : ({ state: "present", fingerprint: action.ownership.currentFingerprint } as const),
  }));
  if (gitignore) {
    actions.push(gitignore.action);
    targetPreconditions.push(gitignore.precondition);
  }
  const normalizedInputs = jsonObject({
    storeRoot: opts.storeRoot,
    scope: opts.scope,
    agents: opts.agents,
    configFingerprint: sha256(canonicalJson(config)),
    storeProvenance,
    capabilityRootProvenance,
    ...(opts.dir ? { dir: opts.dir } : {}),
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    distributePlan,
  });
  const prepared = {
    plan: distributePlan,
    mutationPlan: createAuthorizedMutationPlan(operationEnv, opts.storeRoot, {
      schemaVersion: 1,
      planId: planOptions.planId ?? `plan-${operationEnv.randomId()}`,
      operation: "apply",
      baseRevision: observed.revision,
      normalizedInputs,
      targetPreconditions,
      actions,
      expires: planOptions.expires ?? { policy: "none" },
    }),
  };
  const activeValues =
    execution.providerAccess === "forbidden"
      ? []
      : await discoverActiveSecretValuesForActions(operationEnv, distributePlan.actions, {
          storeRoot: opts.storeRoot,
          config,
          secretMode: effectiveSecretMode,
          vaultPassphrase: opts.vaultPassphrase,
          keychainService: effectiveKeychainService,
        });
  const knownValues = activeValues.map((active) => active.value);
  attachObservableKnownValues(distributePlan, knownValues);
  attachProviderScope(distributePlan, scope);
  return attachProviderScope(attachObservableKnownValues(prepared, knownValues), scope);
}

export async function applyMutationPlan(
  env: Env,
  mutationPlan: MutationPlan,
  context: ApplyMutationContext,
  execution: { readonly authorityLease?: MutationAuthorityLease } = {},
): Promise<ApplyMutationResult> {
  const scope =
    providerScopeForEnv(env) ??
    createProviderScope({
      secretMode: context.secretMode ?? "env",
      vaultPassphrase: context.vaultPassphrase,
      keychainService: context.keychainService,
    });
  const operationEnv = providerScopeForEnv(env) ? env : withProviderScope(env, scope);
  try {
    let distributePlan: DistributePlan = { actions: [], warnings: [], conflicts: [] };
    let applied: ApplyResult | undefined;
    let stagedSources = new Map<string, SafeRecursiveSnapshot>();
    let decoded: ReturnType<typeof decodeApplyMutation>;
    let trustedOptions: DistributeOptions;
    try {
      assertStrictMutationPlanRuntime(mutationPlan, "apply");
    } catch {
      return invalidApplyMutationResult(scope);
    }
    if (!verifyMutationPlanAuthorization(operationEnv, context.storeRoot, mutationPlan)) {
      return invalidApplyMutationResult(scope);
    }
    if (!verifyMutationPlanDigest(mutationPlan)) return invalidApplyDigestMutationResult(scope);
    const suppliedLease = execution.authorityLease;
    const authorityLease =
      suppliedLease ?? (await acquireCurrentMutationAuthorityLease(operationEnv).catch(() => null));
    if (!authorityLease) return invalidApplyMutationResult(scope);
    if (!(await authorityLease.isCurrent().catch(() => false))) {
      if (!suppliedLease) await authorityLease.release().catch(() => undefined);
      return invalidApplyMutationResult(scope);
    }
    try {
      try {
        assertMutationPlanActionAlignment(mutationPlan);
        decoded = decodeApplyMutation(operationEnv, mutationPlan);
        if (context.options) {
          trustedOptions = assertTrustedApplyOptions(context);
          assertApplyOptionsMatchTrustedContext(decoded.opts, trustedOptions);
        } else {
          trustedOptions = decoded.opts;
          if (trustedOptions.storeRoot !== context.storeRoot) {
            throw new TypeError("apply mutation plan does not match the trusted store context");
          }
        }
      } catch {
        return invalidApplyMutationResult(scope);
      }
      let secretMode = context.secretMode ?? trustedOptions.secretMode ?? "env";
      let keychainService = context.keychainService ?? trustedOptions.keychainService ?? "cellarer";
      let lockedCapabilityRoots: CapabilityRootCapture | undefined;
      const validateApplyProvenance = async (
        retainLockedSnapshot: boolean,
      ): Promise<OperationResult | null> => {
        const current = await captureCapabilityRootSnapshots(
          operationEnv,
          context.storeRoot,
          decoded.opts.capabilities ?? ["rules"],
        ).catch(() => null);
        if (
          !current ||
          canonicalJson(current.descriptors) !== canonicalJson(decoded.capabilityRootProvenance)
        ) {
          return invalidPlanResult();
        }
        const provenance = await validateStoreProvenance(
          operationEnv,
          context.storeRoot,
          mutationPlan,
        );
        if (provenance) return provenance;
        if (retainLockedSnapshot) lockedCapabilityRoots = current;
        return null;
      };
      const operation = await executeMutationPlan(
        operationEnv,
        context.storeRoot,
        mutationPlan,
        async (_operationId, recordAction, authorizeAction) => {
          if (mutationPlan.operation !== "apply") {
            throw new TypeError("apply mutation requires an apply plan");
          }
          distributePlan = decoded.distributePlan;
          const executed = await executeApplyPlan(
            operationEnv,
            decoded.opts,
            decoded.executionPlan,
            context.snapshotPassphrase ?? trustedOptions.snapshotPassphrase,
            mutationPlan,
            recordAction,
            authorizeAction,
            stagedSources,
          );
          applied = executed.result;
          return {
            actionReceipts: executed.actionReceipts,
            failedActionIds: executed.failedActionIds,
            ...(executed.statePublications
              ? { statePublications: executed.statePublications }
              : {}),
            ...(executed.afterCommit ? { afterCommit: executed.afterCommit } : {}),
          };
        },
        {
          authorityLease,
          validatePreflightBeforeObservation: async () => validateApplyProvenance(false),
          validateBeforeObservationUnderLock: async () => validateApplyProvenance(true),
          validateUnderLock: async () => {
            const currentConfig = await loadConfig(operationEnv, context.storeRoot);
            if (sha256(canonicalJson(currentConfig)) !== decoded.configFingerprint) {
              return invalidPlanResult();
            }
            if (!lockedCapabilityRoots) return invalidPlanResult();
            try {
              stagedSources = captureSignedApplySources(
                lockedCapabilityRoots,
                decoded.executionPlan.actions,
              );
            } catch {
              return invalidPlanResult();
            }
            secretMode =
              context.secretMode ?? trustedOptions.secretMode ?? currentConfig.defaults.secretMode;
            keychainService =
              context.keychainService ?? trustedOptions.keychainService ?? "cellarer";
            configureProviderScope(scope, {
              secretMode,
              vaultPassphrase: context.vaultPassphrase ?? trustedOptions.vaultPassphrase,
              keychainService,
            });
            await discoverActiveSecretValuesForActions(
              operationEnv,
              decoded.executionPlan.actions,
              {
                storeRoot: context.storeRoot,
                config: currentConfig,
                secretMode,
                vaultPassphrase: context.vaultPassphrase ?? trustedOptions.vaultPassphrase,
                keychainService,
                requireAvailableReferences: true,
              },
            );
            if (
              containsObservableKnownValue(
                JSON.stringify(mutationPlan),
                observableKnownValues(operationEnv),
              )
            ) {
              throw new TypeError("active secret value is not allowed in signed mutation metadata");
            }
            await assertRecursiveSecretGuard(operationEnv, decoded.executionPlan.actions, {
              storeRoot: context.storeRoot,
              config: currentConfig,
              secretMode,
              vaultPassphrase: context.vaultPassphrase ?? trustedOptions.vaultPassphrase,
              keychainService,
              requireAvailableReferences: true,
              stagedSources,
            });
            return null;
          },
        },
      );
      const returnedPlan = applied
        ? { ...distributePlan, warnings: [...applied.plan.warnings] }
        : distributePlan;
      return attachProviderScope(
        {
          ...(applied ?? { plan: distributePlan, entries: [], failures: [] }),
          plan: returnedPlan,
          operation,
          mutation: mutationPresentation(mutationPlan, operation),
        },
        scope,
      );
    } finally {
      if (!suppliedLease) await authorityLease.release();
    }
  } catch (error) {
    throw typeof error === "object" && error !== null ? attachProviderScope(error, scope) : error;
  }
}

export function preflightApplyMutationPlan(
  env: Env,
  mutationPlan: unknown,
  storeRoot: string,
): ApplyMutationPlanPreflight {
  try {
    assertStrictMutationPlanRuntime(mutationPlan, "apply");
  } catch {
    return invalidApplyPlanPreflight();
  }
  if (!verifyMutationPlanAuthorization(env, storeRoot, mutationPlan)) {
    return invalidApplyPlanPreflight();
  }
  if (!verifyMutationPlanDigest(mutationPlan)) return invalidApplyDigestPreflight();
  try {
    assertMutationPlanActionAlignment(mutationPlan);
    const decoded = decodeApplyMutation(env, mutationPlan);
    if (decoded.opts.storeRoot !== storeRoot) return invalidApplyPlanPreflight();
    return {
      ok: true,
      requiresCellarerSecretResolution: discoverSecretReferences(
        decoded.executionPlan.actions.flatMap((action) =>
          action.preview?.after ? [action.preview.after] : [],
        ),
      ).some((reference) => reference.kind === "cellarer"),
      requiresSnapshotPassphrase: decoded.executionPlan.actions.some(
        (action) => action.replacement?.snapshotRequired === true,
      ),
    };
  } catch {
    return invalidApplyPlanPreflight();
  }
}

function invalidApplyPlanPreflight(): Extract<ApplyMutationPlanPreflight, { readonly ok: false }> {
  const operation = invalidPlanResult();
  if (operation.ok) throw new TypeError("invalid plan result unexpectedly succeeded");
  return operation;
}

function invalidApplyDigestPreflight(): Extract<
  ApplyMutationPlanPreflight,
  { readonly ok: false }
> {
  const operation = invalidApplyPlanDigestResult();
  if (operation.ok) throw new TypeError("invalid plan digest result unexpectedly succeeded");
  return operation;
}

function assertApplyOptionsMatchTrustedContext(
  supplied: DistributeOptions,
  trusted: DistributeOptions,
): void {
  const trustedSignedOptions: DistributeOptions = {
    storeRoot: trusted.storeRoot,
    scope: trusted.scope,
    agents: trusted.agents,
    ...(trusted.dir ? { dir: trusted.dir } : {}),
    ...(trusted.capabilities ? { capabilities: trusted.capabilities } : {}),
  };
  if (canonicalJson(jsonObject(supplied)) !== canonicalJson(jsonObject(trustedSignedOptions))) {
    throw new TypeError("apply mutation options do not match the trusted execution context");
  }
}

function assertTrustedApplyOptions(context: ApplyMutationContext): DistributeOptions {
  const options = context.options;
  if (
    !options ||
    options.storeRoot !== context.storeRoot ||
    options.dryRun === true ||
    (context.secretMode !== undefined &&
      options.secretMode !== undefined &&
      context.secretMode !== options.secretMode) ||
    (context.keychainService !== undefined &&
      options.keychainService !== undefined &&
      context.keychainService !== options.keychainService)
  ) {
    throw new TypeError("apply mutation context does not contain trusted canonical options");
  }
  return options;
}

function invalidApplyPlanDigestResult(): OperationResult {
  return {
    ok: false,
    conflict: {
      code: "INVALID_PLAN_DIGEST",
      message: "plan digest does not match its contents",
      planId: "untrusted",
      expectedDigest: "untrusted",
      actualDigest: "invalid",
    },
  };
}

function invalidApplyMutationResult(scope: ProviderScope): ApplyMutationResult {
  const operation = invalidPlanResult();
  return attachProviderScope(
    {
      plan: { actions: [], warnings: [], conflicts: [] },
      entries: [],
      failures: [],
      operation,
      mutation: {
        planId: "untrusted",
        planDigest: "untrusted",
        operation: "apply",
        baseRevision: 0,
        result: operation,
      },
    },
    scope,
  );
}

function invalidApplyDigestMutationResult(scope: ProviderScope): ApplyMutationResult {
  const operation = invalidApplyPlanDigestResult();
  return attachProviderScope(
    {
      plan: { actions: [], warnings: [], conflicts: [] },
      entries: [],
      failures: [],
      operation,
      mutation: {
        planId: "untrusted",
        planDigest: "untrusted",
        operation: "apply",
        baseRevision: 0,
        result: operation,
      },
    },
    scope,
  );
}

function captureSignedApplySources(
  roots: CapabilityRootCapture,
  actions: readonly PlanAction[],
): Map<string, SafeRecursiveSnapshot> {
  const snapshots = new Map<string, SafeRecursiveSnapshot>();
  for (const action of actions) {
    for (const input of action.storeInputs ?? []) {
      const snapshot = snapshotForCapabilityDescendant(roots, action.capability, input.path);
      if (snapshot.fingerprint !== input.fingerprint) {
        throw staleApplySource(input.path);
      }
      snapshots.set(input.path, snapshot);
    }
    if (action.op === "skip" || !action.source) continue;
    const snapshot = snapshotForCapabilityDescendant(roots, action.capability, action.source);
    const expected = action.desiredEvidence?.sourceFingerprint;
    const expectedIdentity = action.desiredEvidence?.sourceIdentity;
    if (
      snapshot.kind !== "directory" ||
      !expected ||
      snapshot.fingerprint !== expected ||
      !expectedIdentity ||
      snapshot.identity !== expectedIdentity
    ) {
      throw staleApplySource(action.source);
    }
    snapshots.set(action.source, snapshot);
  }
  return snapshots;
}

function snapshotForCapabilityDescendant(
  roots: CapabilityRootCapture,
  capability: Capability,
  path: string,
): SafeRecursiveSnapshot {
  const root = roots.snapshots.get(capability);
  if (!root) throw staleApplySource(path);
  const child = relative(root.rootPath, path);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw staleApplySource(path);
  }
  return sliceSafeRecursiveSnapshot(root, child.split(sep).join("/"));
}

function staleApplySource(path: string): Error {
  return Object.assign(new Error(`apply source changed after planning: ${path}`), {
    code: "ESTALE",
  });
}

async function executeApplyPlan(
  env: Env,
  opts: DistributeOptions,
  distributePlan: DistributePlan,
  snapshotPassphrase: string | undefined,
  mutationPlan: MutationPlan,
  recordAction: RecordOperationAction,
  authorizeAction: AuthorizeOperationAction,
  stagedSources: ReadonlyMap<string, SafeRecursiveSnapshot>,
): Promise<{
  result: ApplyResult;
  actionReceipts: OperationActionReceipt[];
  failedActionIds: string[];
  statePublications?: { path: string; data: string; mode: number }[];
  afterCommit?: () => Promise<void>;
}> {
  // Receipt-backed plans are deeply frozen. Runtime-only warnings belong to a mutable result copy,
  // never to the signed receipt snapshot.
  const resultPlan: DistributePlan = {
    ...distributePlan,
    warnings: [...distributePlan.warnings],
  };
  const ledger = await loadLedger(env, opts.storeRoot);
  const entries: LedgerEntry[] = [];
  const failures: ApplyFailure[] = [];
  const actionReceipts: OperationActionReceipt[] = [];
  const failedActionIds: string[] = [];
  const transientSnapshots = new Set<string>();
  let mutationActionIndex = 0;
  const projectRoot =
    opts.scope === "project" ? canonicalProjectRoot(env, opts.dir ?? env.cwd()) : undefined;

  for (const action of distributePlan.actions) {
    if (action.op === "skip") continue;
    const mutationAction = mutationPlan.actions[mutationActionIndex];
    const precondition = mutationPlan.targetPreconditions.find(
      (candidate) => candidate.actionId === mutationAction?.actionId,
    );
    mutationActionIndex += 1;
    if (!mutationAction || !precondition || mutationAction.target !== action.target) {
      throw new Error(`apply action ${action.target} is not aligned with its mutation receipt`);
    }
    const authorized = await authorizeAction(mutationAction.actionId);
    if (!authorized.ok) {
      const failure: ApplyFailure = {
        code: "ACTION_IO_FAILED",
        target: action.target,
        message:
          authorized.receipt.error?.message ??
          "target changed after the operation journal started executing",
      };
      actionReceipts.push(authorized.receipt);
      failedActionIds.push(mutationAction.actionId);
      failures.push(failure);
      break;
    }
    const prior = findEntry(ledger, action);
    let appliedAction: AppliedAction;
    try {
      appliedAction = await applyAction(
        env,
        action,
        prior,
        {
          storeRoot: opts.storeRoot,
          snapshotPassphrase,
          projectRoot,
        },
        action.source ? stagedSources.get(action.source) : undefined,
      );
    } catch (error) {
      if (!(error instanceof SnapshotCreationError) && !isControlledActionIoFailure(error)) {
        throw error;
      }
      const failure: ApplyFailure =
        error instanceof SnapshotCreationError
          ? {
              code: "SNAPSHOT_FAILED",
              target: action.target,
              message: error.message,
            }
          : {
              code: "ACTION_IO_FAILED",
              target: action.target,
              message: `filesystem action failed (${actionIoFailureCode(error)})`,
            };
      const receipt: OperationActionReceipt = {
        actionId: mutationAction.actionId,
        target: action.target,
        outcome: "failed",
        before: precondition.expected,
        after: await targetState(env, action.target),
        recordedAt: env.now().toISOString(),
        error: { code: failure.code, message: failure.message },
      };
      await recordAction(receipt);
      actionReceipts.push(receipt);
      failedActionIds.push(mutationAction.actionId);
      failures.push(failure);
      continue;
    }
    let before = precondition.expected;
    if (before.state === "present" && action.replacement && appliedAction.snapshot) {
      before = {
        ...before,
        recoverySnapshot: appliedAction.snapshot.path,
        recoverySnapshotDigest: appliedAction.snapshot.digest,
        recoverySnapshotMode: appliedAction.snapshot.mode,
      };
    }
    const after = await targetState(env, action.target);
    try {
      await assertApplyPostcondition(env, action, appliedAction.entry, after);
    } catch (error) {
      if (!(error instanceof PublicationPostconditionError)) throw error;
      const failure: ApplyFailure = {
        code: "ACTION_IO_FAILED",
        target: action.target,
        message: error.message,
      };
      const receipt: OperationActionReceipt = {
        actionId: mutationAction.actionId,
        target: action.target,
        outcome: "failed",
        before,
        after,
        recordedAt: env.now().toISOString(),
        error: { code: error.code, message: error.message },
      };
      await recordAction(receipt);
      actionReceipts.push(receipt);
      failedActionIds.push(mutationAction.actionId);
      failures.push(failure);
      if (appliedAction.transientSnapshotPath) {
        transientSnapshots.add(appliedAction.transientSnapshotPath);
      }
      continue;
    }
    const receipt: OperationActionReceipt = {
      actionId: mutationAction.actionId,
      target: action.target,
      outcome: sameTargetReceipt(before, after) ? "unchanged" : "applied",
      before,
      after,
      recordedAt: env.now().toISOString(),
    };
    await recordAction(receipt);
    actionReceipts.push(receipt);
    entries.push(appliedAction.entry);
    if (appliedAction.transientSnapshotPath) {
      transientSnapshots.add(appliedAction.transientSnapshotPath);
    }
  }

  const nextLedger = addEntries(ledger, entries);
  const gitignoreActions = mutationPlan.actions.slice(mutationActionIndex);
  if (failures.length === 0) {
    for (const action of gitignoreActions) {
      const precondition = mutationPlan.targetPreconditions.find(
        (candidate) => candidate.actionId === action.actionId,
      );
      if (!precondition || action.kind !== "sync-gitignore") {
        throw new Error(
          `apply gitignore action ${action.actionId} is not aligned with its receipt`,
        );
      }
      const authorized = await authorizeAction(action.actionId);
      if (!authorized.ok) {
        const failure: ApplyFailure = {
          code: "ACTION_IO_FAILED",
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
      assertGitignoreMutationMatchesLedger(action, nextLedger);
      try {
        await executeGitignoreMutation(env, action);
      } catch (error) {
        if (!isControlledActionIoFailure(error)) throw error;
        const errorCode = actionIoFailureCode(error);
        const failure: ApplyFailure = {
          code: "ACTION_IO_FAILED",
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
          for (const snapshotPath of transientSnapshots) {
            resultPlan.warnings.push(
              `retained encrypted recovery snapshot "${snapshotPath}" because automatic snapshot deletion is unsupported`,
            );
          }

          try {
            await appendActivity(env, opts.storeRoot, {
              action: "apply",
              scope: opts.scope,
              projectDir: opts.dir,
              agents: opts.agents,
              capabilities: opts.capabilities ?? [
                ...new Set(entries.map((entry) => entry.capability)),
              ],
              affectedCount: entries.length,
              warningsCount: resultPlan.warnings.length,
              summary: `Applied ${entries.length} ${entries.length === 1 ? "target" : "targets"}`,
              resources: {
                ledgerEntryKeys: entries.map(entryKey),
                artifactIds: entries.flatMap((entry) => entry.artifactIds),
              },
              secretRefs: entries.flatMap((entry) => entry.secretRefs ?? []),
            });
          } catch (err) {
            resultPlan.warnings.push(
              `activity log failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      : undefined;

  return {
    result: { plan: resultPlan, entries, failures },
    actionReceipts,
    failedActionIds,
    ...(failures.length === 0
      ? {
          statePublications: [
            {
              path: join(opts.storeRoot, "state.json"),
              data: serializeLedger(nextLedger, observableKnownValues(env)),
              mode: 0o600,
            },
          ],
          afterCommit,
        }
      : {}),
  };
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
]);

function actionIoFailureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN_IO_ERROR";
}

function isControlledActionIoFailure(error: unknown): boolean {
  return CONTROLLED_ACTION_IO_CODES.has(actionIoFailureCode(error));
}

function mutationActionId(action: PlanAction, index: number): string {
  return sha256(JSON.stringify({ index, op: action.op, target: action.target }));
}

function jsonObject(value: unknown): CanonicalJsonObject {
  return JSON.parse(JSON.stringify(value)) as CanonicalJsonObject;
}

function decodeApplyMutation(
  env: Env,
  planReceipt: MutationPlan,
): {
  opts: DistributeOptions;
  distributePlan: DistributePlan;
  executionPlan: DistributePlan;
  configFingerprint: string;
  capabilityRootProvenance: readonly CapabilityRootProvenanceDescriptor[];
} {
  if (planReceipt.operation !== "apply") {
    throw new TypeError("apply mutation requires an apply plan");
  }
  const input = planReceipt.normalizedInputs as Record<string, unknown>;
  const inputKeys = [
    "agents",
    "configFingerprint",
    "capabilityRootProvenance",
    "distributePlan",
    "scope",
    "storeProvenance",
    "storeRoot",
  ];
  if ("dir" in input) inputKeys.push("dir");
  if ("capabilities" in input) inputKeys.push("capabilities");
  if (
    !hasExactKeys(input, inputKeys) ||
    typeof input.storeRoot !== "string" ||
    (input.scope !== "global" && input.scope !== "project") ||
    !Array.isArray(input.agents) ||
    !input.agents.every((agent) => typeof agent === "string") ||
    typeof input.configFingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(input.configFingerprint) ||
    !Array.isArray(input.storeProvenance) ||
    !Array.isArray(input.capabilityRootProvenance) ||
    typeof input.distributePlan !== "object" ||
    input.distributePlan === null ||
    !Array.isArray((input.distributePlan as DistributePlan).actions) ||
    !Array.isArray((input.distributePlan as DistributePlan).warnings) ||
    !Array.isArray((input.distributePlan as DistributePlan).conflicts)
  ) {
    throw new TypeError("apply mutation plan has invalid normalized inputs");
  }
  const opts: DistributeOptions = {
    storeRoot: input.storeRoot,
    scope: input.scope,
    agents: input.agents as string[],
    ...(typeof input.dir === "string" ? { dir: input.dir } : {}),
    ...(Array.isArray(input.capabilities)
      ? { capabilities: input.capabilities as DistributeOptions["capabilities"] }
      : {}),
  };
  if (
    new Set(opts.agents).size !== opts.agents.length ||
    opts.agents.some((agent) => agent.length === 0) ||
    (opts.capabilities &&
      !opts.capabilities.every((capability) => ["rules", "mcp", "skills"].includes(capability)))
  ) {
    throw new TypeError("apply mutation plan has invalid normalized inputs");
  }
  const expectedProvenancePaths = distributionStoreProvenancePaths(env, opts);
  const actualProvenancePaths = input.storeProvenance.flatMap((descriptor) =>
    typeof descriptor === "object" &&
    descriptor !== null &&
    !Array.isArray(descriptor) &&
    typeof (descriptor as { path?: unknown }).path === "string"
      ? [(descriptor as { path: string }).path]
      : [],
  );
  if (
    actualProvenancePaths.length !== input.storeProvenance.length ||
    canonicalJson(actualProvenancePaths) !== canonicalJson(expectedProvenancePaths)
  ) {
    throw new TypeError("apply mutation plan has invalid Store provenance");
  }
  const capabilityRootProvenance = decodeCapabilityRootProvenance(
    env,
    opts,
    input.capabilityRootProvenance,
  );
  const distributePlan = input.distributePlan as unknown as DistributePlan;
  const actions: PlanAction[] = [];
  const gitignoreActions: MutationPlanAction[] = [];
  let reachedGitignoreActions = false;
  for (const mutationAction of planReceipt.actions) {
    if (mutationAction.kind === "sync-gitignore") {
      reachedGitignoreActions = true;
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
        throw new TypeError("apply mutation plan has an invalid action payload");
      }
      assertExecutableGitignoreMutation(mutationAction);
      gitignoreActions.push(mutationAction);
      continue;
    }
    if (reachedGitignoreActions) {
      throw new TypeError("apply mutation plan has invalid action ordering");
    }
    if (
      !hasExactKeys(mutationAction, ["actionId", "kind", "payload", "target"]) ||
      typeof mutationAction.actionId !== "string" ||
      mutationAction.actionId.length === 0 ||
      !hasExactKeys(mutationAction.payload, ["planAction"])
    ) {
      throw new TypeError("apply mutation plan has an invalid action payload");
    }
    const parsed = executableApplyActionSchema.safeParse(mutationAction.payload.planAction);
    if (!parsed.success) {
      throw new TypeError("apply mutation plan has an invalid action payload");
    }
    const action = parsed.data as PlanAction;
    const precondition = planReceipt.targetPreconditions.find(
      (candidate) => candidate.actionId === mutationAction.actionId,
    );
    if (
      action.target !== mutationAction.target ||
      action.op !== mutationAction.kind ||
      !OP_HANDLERS[action.op] ||
      !precondition ||
      !isExecutableApplyActionSemanticallyValid(env, action, opts, precondition.expected)
    ) {
      throw new TypeError("apply mutation plan has an invalid action payload");
    }
    actions.push(action);
  }
  const plannedExecutable = distributePlan.actions.filter((action) => action.op !== "skip");
  const projectRoot =
    opts.scope === "project" && opts.dir ? canonicalProjectRoot(env, opts.dir) : null;
  const helper = gitignoreActions[0];
  if (
    plannedExecutable.length !== actions.length ||
    plannedExecutable.some(
      (action, index) => canonicalJson(action) !== canonicalJson(actions[index]),
    ) ||
    (opts.scope === "global" && gitignoreActions.length !== 0) ||
    (opts.scope === "project" &&
      (!projectRoot ||
        gitignoreActions.length !== 1 ||
        helper?.payload.projectDir !== projectRoot ||
        actions.some(
          (action) => !(helper?.payload.targets as unknown[] | undefined)?.includes(action.target),
        )))
  ) {
    throw new TypeError("apply mutation plan is not bound to its canonical execution context");
  }
  return {
    opts,
    distributePlan,
    executionPlan: { ...distributePlan, actions },
    configFingerprint: input.configFingerprint,
    capabilityRootProvenance,
  };
}

function decodeCapabilityRootProvenance(
  env: Env,
  opts: DistributeOptions,
  value: unknown,
): readonly CapabilityRootProvenanceDescriptor[] {
  if (!Array.isArray(value)) throw new TypeError("invalid capability root provenance");
  const expectedCapabilities = [...new Set(opts.capabilities ?? ["rules"])].sort((left, right) =>
    left.localeCompare(right),
  );
  const expectedPaths = distributionCapabilityRootPaths(env, opts);
  if (value.length !== expectedCapabilities.length) {
    throw new TypeError("invalid capability root provenance");
  }
  const parsed = value.map((entry, index) => {
    if (
      !hasExactKeys(entry, ["capability", "expected", "path"]) ||
      entry.capability !== expectedCapabilities[index] ||
      entry.path !== expectedPaths[index] ||
      !hasExactKeys(entry.expected, ["state"])
    ) {
      if (
        !hasExactKeys(entry, ["capability", "expected", "path"]) ||
        entry.capability !== expectedCapabilities[index] ||
        entry.path !== expectedPaths[index] ||
        !hasExactKeys(entry.expected, ["fingerprint", "identity", "mode", "state"]) ||
        entry.expected.state !== "present" ||
        typeof entry.expected.fingerprint !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(entry.expected.fingerprint) ||
        typeof entry.expected.identity !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(entry.expected.identity) ||
        !Number.isSafeInteger(entry.expected.mode) ||
        (entry.expected.mode as number) < 0
      ) {
        throw new TypeError("invalid capability root provenance");
      }
    } else if (entry.expected.state !== "absent") {
      throw new TypeError("invalid capability root provenance");
    }
    return entry as unknown as CapabilityRootProvenanceDescriptor;
  });
  return parsed;
}

function distributionStoreProvenancePaths(env: Env, opts: DistributeOptions): string[] {
  return [join(opts.storeRoot, "config.json"), join(opts.storeRoot, "state.json")]
    .map((path) => normalize(isAbsolute(path) ? path : join(env.cwd(), path)))
    .sort((left, right) => left.localeCompare(right));
}

function distributionCapabilityRootPaths(env: Env, opts: DistributeOptions): string[] {
  const storeRoot = normalize(
    isAbsolute(opts.storeRoot) ? opts.storeRoot : join(env.cwd(), opts.storeRoot),
  );
  return [...new Set(opts.capabilities ?? ["rules"])]
    .sort((left, right) => left.localeCompare(right))
    .map((capability) => join(storeRoot, "store", capability));
}

function sameCapabilityRootDescriptors(
  left: CapabilityRootCapture,
  right: CapabilityRootCapture,
): boolean {
  return canonicalJson(left.descriptors) === canonicalJson(right.descriptors);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isExecutableApplyActionSemanticallyValid(
  env: Env,
  action: PlanAction,
  opts: DistributeOptions,
  expected: TargetStateReceipt,
): boolean {
  const requestedCapabilities = opts.capabilities ?? ["rules"];
  const rawManagedRoot = opts.scope === "global" ? env.homedir() : (opts.dir ?? env.cwd());
  const managedRoot = normalize(
    isAbsolute(rawManagedRoot) ? rawManagedRoot : join(env.cwd(), rawManagedRoot),
  );
  if (
    !isAbsolute(managedRoot) ||
    !opts.agents.includes(action.agent) ||
    action.scope !== opts.scope ||
    !requestedCapabilities.includes(action.capability) ||
    normalize(action.target) !== action.target ||
    !isWithinRoot(managedRoot, action.target) ||
    action.artifactIds?.some((id) => !id.startsWith(`${action.capability}/`)) ||
    action.ownership?.target !== action.target ||
    action.ownership.key !== entryKey(action)
  ) {
    return false;
  }
  const artifactIds = action.artifactIds ?? [];
  const storeInputs = action.storeInputs ?? [];
  if (
    (action.capability === "rules" && action.reason !== artifactIds.join(", ")) ||
    (action.capability === "mcp" &&
      (action.artifact !== artifactIds.join(", ") || action.reason !== action.artifact)) ||
    (action.capability === "skills" &&
      (artifactIds.length !== 1 ||
        action.artifact !== artifactIds[0] ||
        action.reason !== artifactIds[0] ||
        normalize(action.source ?? "") !== action.source ||
        action.source !== join(opts.storeRoot, "store", artifactIds[0] ?? "")))
  ) {
    return false;
  }
  if (
    action.capability !== "skills" &&
    (storeInputs.length !== artifactIds.length ||
      new Set(storeInputs.map((input) => input.artifactId)).size !== storeInputs.length ||
      storeInputs.some(
        (input) =>
          !artifactIds.includes(input.artifactId) ||
          normalize(input.path) !== input.path ||
          !isWithinRoot(join(opts.storeRoot, "store", action.capability), input.path),
      ))
  ) {
    return false;
  }
  if (action.capability === "skills" && storeInputs.length > 0) return false;
  if (
    action.op === "write" &&
    action.desiredEvidence?.contentFingerprint !== sha256(action.preview?.after ?? "")
  ) {
    return false;
  }
  const ownership = action.ownership;
  if (!ownership) return false;
  if (
    (ownership.classification === "absent" && ownership.currentFingerprint !== null) ||
    (ownership.classification === "unowned-existing" && ownership.expectedReceipt !== null) ||
    (ownership.classification === "owned-current" &&
      (!ownership.expectedReceipt ||
        ownership.currentFingerprint !== ownership.expectedReceipt.fingerprint)) ||
    (ownership.classification === "owned-drifted" &&
      (!ownership.expectedReceipt ||
        ownership.currentFingerprint === ownership.expectedReceipt.fingerprint))
  ) {
    return false;
  }
  const expectedFromOwnership: TargetStateReceipt = ownership.currentFingerprint
    ? { state: "present", fingerprint: ownership.currentFingerprint }
    : { state: "absent" };
  if (!sameTargetReceipt(expectedFromOwnership, expected)) return false;

  const replacementKind =
    ownership.classification === "unowned-existing"
      ? "replace-unowned"
      : ownership.classification === "owned-drifted"
        ? "override-drift"
        : undefined;
  if (!replacementKind) return action.replacement === undefined;
  if (action.replacement?.acknowledgement.kind !== replacementKind) return false;
  return (
    action.replacement.acknowledgement.token ===
    sha256(
      JSON.stringify({
        version: 1,
        kind: replacementKind,
        key: ownership.key,
        classification: ownership.classification,
        currentFingerprint: ownership.currentFingerprint,
        expectedReceipt: ownership.expectedReceipt,
        artifactIds,
      }),
    )
  );
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

// 按 op 分派到 handler;未登记的 op 显式失败(M2 新增能力必须在 OP_HANDLERS 登记)。
async function applyAction(
  env: Env,
  action: PlanAction,
  prior: LedgerEntry | undefined,
  context: ApplyContext,
  sourceSnapshot: SafeRecursiveSnapshot | undefined,
): Promise<AppliedAction> {
  const handler = OP_HANDLERS[action.op];
  if (!handler) {
    throw new Error(
      `apply: no handler for op "${action.op}" (${action.capability}, agent "${action.agent}")`,
    );
  }
  let snapshotPath: string | undefined;
  let snapshotEvidence: EncryptedTargetSnapshot | undefined;
  if (action.replacement) {
    if (!context.snapshotPassphrase) {
      throw new SnapshotCreationError(action.target, new Error("snapshot passphrase is missing"));
    }
    const snapshot = await createEncryptedTargetSnapshot(
      env,
      context.storeRoot,
      action.target,
      context.snapshotPassphrase,
      action.ownership?.currentFingerprint ?? null,
    );
    snapshotPath = snapshot.path;
    snapshotEvidence = snapshot;
  }
  const entry = await handler(
    env,
    action,
    prior,
    snapshotPath,
    context.projectRoot,
    sourceSnapshot,
  );
  return {
    entry,
    ...(snapshotEvidence ? { snapshot: snapshotEvidence } : {}),
    ...(snapshotPath && prior ? { transientSnapshotPath: snapshotPath } : {}),
  };
}

async function assertApplyPostcondition(
  env: Env,
  action: PlanAction,
  entry: LedgerEntry,
  actual: TargetStateReceipt,
): Promise<void> {
  if (actual.state !== "present") {
    throw new PublicationPostconditionError(action.target, "after-state");
  }
  if (action.op === "write" || action.op === "merge" || action.op === "overwrite") {
    const expectedFingerprint = sha256(action.preview?.after ?? "");
    if (
      entry.receipt.method !== "write" ||
      entry.receipt.fingerprint !== expectedFingerprint ||
      actual.fingerprint !== expectedFingerprint
    ) {
      throw new PublicationPostconditionError(action.target, "after-state");
    }
    return;
  }

  const sourceFingerprint = action.desiredEvidence?.sourceFingerprint;
  if (
    !action.source ||
    !sourceFingerprint ||
    entry.receipt.sourceFingerprint !== sourceFingerprint
  ) {
    throw new PublicationPostconditionError(action.target, "source-bound after-state");
  }
  if (entry.receipt.method === "copy") {
    if (actual.fingerprint !== sourceFingerprint) {
      throw new PublicationPostconditionError(action.target, "copied after-state");
    }
    return;
  }
  if (entry.receipt.method !== "symlink" && entry.receipt.method !== "junction") {
    throw new PublicationPostconditionError(action.target, "placement method");
  }
  const stat = await env.fs.lstat(action.target).catch(() => null);
  if (!stat?.isSymbolicLink()) {
    throw new PublicationPostconditionError(action.target, "symlink after-state");
  }
  const linkTarget = await env.fs.readlink(action.target);
  const resolvedSource = normalize(
    isAbsolute(linkTarget) ? linkTarget : join(dirname(action.target), linkTarget),
  );
  if (resolvedSource !== normalize(action.source)) {
    throw new PublicationPostconditionError(action.target, "signed source path");
  }
  const expectedFingerprint = sha256(
    JSON.stringify({
      version: 1,
      root: { kind: "symlink", mode: stat.mode & 0o7777, target: linkTarget },
      contentFingerprint: sourceFingerprint,
    }),
  );
  if (
    entry.receipt.fingerprint !== expectedFingerprint ||
    actual.fingerprint !== expectedFingerprint
  ) {
    throw new PublicationPostconditionError(action.target, "source-bound after-state");
  }
}

// 按台账唯一键查既有条目(供幂等复用 backup/appliedAt)。复用 entryKey,与 addEntries 合并口径一致。
function findEntry(ledger: Ledger, action: PlanAction): LedgerEntry | undefined {
  const key = entryKey(action);
  return ledger.owners.find((owner) => entryKey(owner) === key);
}

// 内容写入(rules render / mcp merge|overwrite):plan 已算好最终文本,这里只做备份 + 原子写。
// generated:write(rules 整文件由 cellarer 生成)→ true;merge/overwrite(并入用户既有文件)→ false。
async function applyContentWrite(
  env: Env,
  action: PlanAction,
  prior: LedgerEntry | undefined,
  snapshotPath: string | undefined,
  projectRoot: string | undefined,
  _sourceSnapshot: SafeRecursiveSnapshot | undefined,
): Promise<LedgerEntry> {
  const content = action.preview?.after ?? "";
  const checksum = sha256(content);
  const contentFingerprint = action.desiredEvidence?.contentFingerprint;

  // 内容已与磁盘一致(幂等)→ 不重写,保留既有 backup/appliedAt,台账字节不变。
  if (
    prior &&
    action.preview?.before === content &&
    prior.receipt.fingerprint === checksum &&
    prior.receipt.contentFingerprint === contentFingerprint &&
    prior.projectRoot === projectRoot &&
    sameArtifactIds(prior.artifactIds, actionArtifactIds(action))
  ) {
    return prior;
  }

  // 安全:不跟随软链写(防穿越);备份既有用户文件。
  await assertNotSymbolicLink(env, action.target);
  if (!prior && !snapshotPath && (await lstatOrNull(env, action.target))) {
    throw new Error(
      `apply: target appeared after planning and will not be replaced: "${action.target}"`,
    );
  }
  // 显式 replacement 记录刚创建的密文 before-state；普通 owned-current 更新保留既有指针。
  const backup = prior ? prior.receipt.backup : (snapshotPath ?? null);

  // atomicWrite 内部会建父目录,无需重复 mkdir。
  await atomicWrite(env, action.target, content);

  return {
    agent: action.agent,
    scope: action.scope,
    capability: action.capability,
    target: action.target,
    ...(projectRoot ? { projectRoot } : {}),
    artifactIds: actionArtifactIds(action),
    receipt: {
      method: "write",
      fingerprint: checksum,
      ...(contentFingerprint ? { contentFingerprint } : {}),
      backup,
      generated: action.op === "write",
      appliedAt: env.now().toISOString(),
    },
    secretRefs: action.secretRefs,
  };
}

// skills 目录链接(symlink/copy)。实际落地方式可能因 Windows 回退(junction/copy),记台账。
// 注:不调 assertNotSymbolicLink —— skills 的 target 本就是「由 cellarer 管理的软链」,
// 既有同指向软链是幂等正常态(linkOrCopy 内部 short-circuit/clearDest 已安全处理)。
async function applyLink(
  env: Env,
  action: PlanAction,
  prior: LedgerEntry | undefined,
  snapshotPath: string | undefined,
  projectRoot: string | undefined,
  sourceSnapshot: SafeRecursiveSnapshot | undefined,
): Promise<LedgerEntry> {
  if (!action.source) {
    throw new Error(`apply: skills action for "${action.agent}" missing source path`);
  }
  const source = action.source;
  if (sourceSnapshot?.kind !== "directory") {
    throw new UnsafeRecursiveSourceError(source, "stale");
  }
  await assertSafeRecursiveSnapshotCurrent(env, sourceSnapshot);

  // 源目录指纹只供 copy 幂等判定；最终 receipt 统一从完整 staged target 计算。
  // symlink 幂等短路不读源目录，copy 路径则 memoize，避免重复遍历。
  const sourceFingerprint = sourceSnapshot.fingerprint;

  // copy 幂等 + 自愈:仅当「源未变且 target 仍是内容等于源的目录」才跳过重拷(避免 churn appliedAt);
  // target 缺失/被换成文件/被手改 → 落到 linkOrCopy 重拷,顺带修复漂移。
  // 注:hashDir 前必须确认 target 是目录 —— 否则被换成普通文件时 readdir 抛 ENOTDIR 会中断整个 apply。
  //
  // method 匹配:prior 落地为 copy 时,只要「本次请求也会产出 copy」就短路 —— 即 action.method==="copy",
  // 或 win32 目录 symlink 请求(junction 失败会回退 copy,且大概率再次失败)。否则(POSIX 下从 --copy
  // 切回 symlink)不短路,让 linkOrCopy 重新软链以兑现用户的 method 变更。
  // 不加此 method 判据会导致 win32 回退 copy 的条目每次 re-apply 都 clearDest+重拷(破坏不变量 5 幂等)。
  const copyWouldReproduce =
    prior?.receipt.method === "copy" && (action.method === "copy" || env.platform === "win32");
  if (
    copyWouldReproduce &&
    prior.receipt.fingerprint === sourceFingerprint &&
    prior.receipt.sourceFingerprint === sourceFingerprint &&
    prior.projectRoot === projectRoot &&
    sameArtifactIds(prior.artifactIds, actionArtifactIds(action))
  ) {
    const targetStat = await lstatOrNull(env, action.target);
    if (targetStat?.isDirectory() && (await hashDir(env, action.target)) === sourceFingerprint) {
      return prior;
    }
  }

  // Finish static receipt values before placement, and fingerprint the fully built staged target
  // through the same public algorithm used by plan/status/revert before any replacement swap.
  const artifactIds = actionArtifactIds(action);
  const backup = prior ? prior.receipt.backup : (snapshotPath ?? null);
  const appliedAt = env.now().toISOString();
  let receiptFingerprint: string | undefined;

  const result =
    action.method === "copy"
      ? await (async () => {
          await assertSafeRecursiveSnapshotCurrent(env, sourceSnapshot);
          await installSafeRecursiveSnapshot(
            env,
            sourceSnapshot,
            action.target,
            prior !== undefined || snapshotPath !== undefined,
          );
          receiptFingerprint = sourceFingerprint;
          return { method: "copy" as const, skipped: false };
        })()
      : await linkOrCopy(env, source, action.target, {
          method: action.method,
          kind: "dir",
          replaceExisting: prior !== undefined || snapshotPath !== undefined,
          preparePlaced: async (placedTarget) => {
            await assertSafeRecursiveSnapshotCurrent(env, sourceSnapshot);
            const fingerprint = await fingerprintTarget(env, placedTarget);
            if (!fingerprint) {
              throw new Error(`apply: placed Skill cannot be fingerprinted: "${action.target}"`);
            }
            receiptFingerprint = fingerprint;
          },
        });

  if (!receiptFingerprint) {
    throw new Error(`apply: placed Skill receipt is missing: "${action.target}"`);
  }

  // 同指向 symlink 只在完整 owner 仍与当前 target 一致时才原样复用。批准的 replacement
  // 会带来新的 snapshotPath，因此即使无需重建链接，也必须写入新的 target fingerprint/backup。
  if (
    result.skipped &&
    prior &&
    receiptFingerprint === prior.receipt.fingerprint &&
    prior.receipt.sourceFingerprint === sourceFingerprint &&
    result.method === prior.receipt.method &&
    backup === prior.receipt.backup &&
    prior.receipt.generated &&
    prior.projectRoot === projectRoot &&
    sameArtifactIds(prior.artifactIds, artifactIds)
  ) {
    return prior;
  }

  return {
    agent: action.agent,
    scope: action.scope,
    capability: action.capability,
    target: action.target,
    ...(projectRoot ? { projectRoot } : {}),
    artifactIds,
    receipt: {
      method: result.method,
      // 统一 target 指纹：copy 覆盖完整目录，symlink 覆盖顶层 kind/mode/readlink target 与内容。
      fingerprint: receiptFingerprint,
      sourceFingerprint,
      backup,
      generated: true, // 由 cellarer 落地的链接/拷贝,revert 可整体删除。
      appliedAt,
    },
  };
}

function actionArtifactIds(action: PlanAction): string[] {
  if (action.artifactIds) return [...new Set(action.artifactIds)];
  const ids = action.artifact.split(",").map((id) => id.trim());
  return [...new Set(ids.filter((id) => /^(rules|mcp|skills)\/[^/*,\s]+$/.test(id)))];
}

function sameArtifactIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function canonicalProjectRoot(env: Env, dir: string): string {
  const root = normalize(isAbsolute(dir) ? dir : join(env.cwd(), dir));
  if (!isAbsolute(root)) throw new TypeError(`project root must be absolute: ${dir}`);
  return root;
}
