// apply = plan + 执行 + 写台账(不变量 3/5)。dryRun 只返回 plan,不落地。
// 分派结构(M2 重构):按 PlanAction.op 查 handler 表,引擎不散写 if (cap === "rules" && op === "write")。
// 每个 op handler 负责一种落地动作(write/merge/overwrite/symlink/copy),返回写入台账的条目。
// op 未登记 handler → 显式抛错(防「plan 产出了某 op,apply 却静默忽略」),新增能力必须在此登记。
//
// 幂等关键:重复 apply 必须产出与磁盘一致的台账,且不丢失首次备份指针 ——
//   故复用既有台账条目的 backup;内容未变时保留 appliedAt 并跳过重写(避免 mtime 抖动)。

import { dirname, isAbsolute, join, normalize } from "node:path";
import { appendActivity } from "../activity.js";
import type { Env } from "../env.js";
import { atomicWrite } from "../fs/atomicWrite.js";
import { hashDir } from "../fs/hashDir.js";
import { linkOrCopy } from "../fs/linkOrCopy.js";
import { lstatOrNull } from "../fs/probe.js";
import { assertNotSymbolicLink } from "../fs/safety.js";
import type { DistributePlan, Ledger, LedgerEntry, PlanAction } from "../model/index.js";
import { createMutationPlan } from "../protocol/canonical.js";
import {
  type AuthorizeOperationAction,
  executeMutationPlan,
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
import { mutationPresentation } from "../protocol/presentation.js";
import { PublicationPostconditionError } from "../protocol/publication.js";
import { observeAtStableStoreRevision } from "../protocol/store-revision.js";
import { sha256 } from "../store/checksum.js";
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
  assertGitignoreMutationMatchesLedger,
  executeGitignoreMutation,
  planGitignoreMutation,
  projectTargetsUnder,
} from "./gitignore-sync.js";
import { plan } from "./plan.js";
import type {
  ApplyCallResult,
  ApplyFailure,
  ApplyMutationContext,
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

export async function apply(env: Env, opts: DistributeOptions): Promise<ApplyCallResult> {
  const prepared = await planApplyMutation(env, opts);
  const distributePlan = prepared.plan;

  // Duplicate physical owners make the ledger globally unsafe to update. Planning already exposes
  // the target-keyed conflict, so non-dry apply returns the same blocked result without reopening
  // the ledger through the strict mutation path or performing any effect.
  if (opts.dryRun || distributePlan.invalidLedger) {
    return {
      plan: distributePlan,
      entries: [],
      failures: [],
      mutation: mutationPresentation(prepared.mutationPlan),
    };
  }

  return applyMutationPlan(env, prepared.mutationPlan, {
    storeRoot: opts.storeRoot,
    snapshotPassphrase: opts.snapshotPassphrase,
  });
}

export async function planApplyMutation(
  env: Env,
  opts: DistributeOptions,
  planOptions: MutationPlanOptions = {},
): Promise<PlannedApplyMutation> {
  const observed = await observeAtStableStoreRevision(env, opts.storeRoot, async () => {
    const distributePlan = await plan(env, opts);
    const executable = distributePlan.actions.filter((action) => action.op !== "skip");
    const gitignore =
      opts.scope === "project" && opts.dir
        ? await planGitignoreMutation(env, opts.dir, [
            ...projectTargetsUnder(await loadLedgerForPlanning(env, opts.storeRoot), opts.dir),
            ...executable.map((action) => action.target),
          ])
        : undefined;
    return { distributePlan, gitignore };
  });
  const { distributePlan, gitignore } = observed.value;
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
    ...(opts.dir ? { dir: opts.dir } : {}),
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    distributePlan,
  });
  return {
    plan: distributePlan,
    mutationPlan: createMutationPlan({
      schemaVersion: 1,
      planId: planOptions.planId ?? `plan-${env.randomId()}`,
      operation: "apply",
      baseRevision: observed.revision,
      normalizedInputs,
      targetPreconditions,
      actions,
      expires: planOptions.expires ?? { policy: "none" },
    }),
  };
}

export async function applyMutationPlan(
  env: Env,
  mutationPlan: MutationPlan,
  context: ApplyMutationContext,
): Promise<ApplyMutationResult> {
  let distributePlan: DistributePlan = { actions: [], warnings: [], conflicts: [] };
  let applied: ApplyResult | undefined;
  const operation = await executeMutationPlan(
    env,
    context.storeRoot,
    mutationPlan,
    async (_operationId, recordAction, authorizeAction) => {
      if (mutationPlan.operation !== "apply") {
        throw new TypeError(`apply mutation requires an apply plan, got ${mutationPlan.operation}`);
      }
      const decoded = decodeApplyMutation(mutationPlan);
      if (decoded.opts.storeRoot !== context.storeRoot) {
        throw new TypeError("apply mutation store does not match its execution context");
      }
      distributePlan = decoded.distributePlan;
      const executed = await executeApplyPlan(
        env,
        decoded.opts,
        decoded.executionPlan,
        context.snapshotPassphrase,
        mutationPlan,
        recordAction,
        authorizeAction,
      );
      applied = executed.result;
      return {
        actionReceipts: executed.actionReceipts,
        failedActionIds: executed.failedActionIds,
        ...(executed.statePublications ? { statePublications: executed.statePublications } : {}),
        ...(executed.afterCommit ? { afterCommit: executed.afterCommit } : {}),
      };
    },
  );
  const returnedPlan = applied
    ? { ...distributePlan, warnings: [...applied.plan.warnings] }
    : distributePlan;
  return {
    ...(applied ?? { plan: distributePlan, entries: [], failures: [] }),
    plan: returnedPlan,
    operation,
    mutation: mutationPresentation(mutationPlan, operation),
  };
}

async function executeApplyPlan(
  env: Env,
  opts: DistributeOptions,
  distributePlan: DistributePlan,
  snapshotPassphrase: string | undefined,
  mutationPlan: MutationPlan,
  recordAction: RecordOperationAction,
  authorizeAction: AuthorizeOperationAction,
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
      appliedAction = await applyAction(env, action, prior, {
        storeRoot: opts.storeRoot,
        snapshotPassphrase,
        projectRoot,
      });
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
              references: {
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
              data: serializeLedger(nextLedger),
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

function decodeApplyMutation(planReceipt: MutationPlan): {
  opts: DistributeOptions;
  distributePlan: DistributePlan;
  executionPlan: DistributePlan;
} {
  const input = planReceipt.normalizedInputs as Record<string, unknown>;
  if (
    typeof input.storeRoot !== "string" ||
    (input.scope !== "global" && input.scope !== "project") ||
    !Array.isArray(input.agents) ||
    !input.agents.every((agent) => typeof agent === "string") ||
    typeof input.distributePlan !== "object" ||
    input.distributePlan === null
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
  const distributePlan = input.distributePlan as unknown as DistributePlan;
  const actions = planReceipt.actions
    .filter((mutationAction) => mutationAction.kind !== "sync-gitignore")
    .map((mutationAction) => {
      const action = mutationAction.payload.planAction as unknown;
      if (
        typeof action !== "object" ||
        action === null ||
        typeof (action as PlanAction).target !== "string" ||
        typeof (action as PlanAction).op !== "string" ||
        (action as PlanAction).target !== mutationAction.target ||
        (action as PlanAction).op !== mutationAction.kind
      ) {
        throw new TypeError(`apply mutation action ${mutationAction.actionId} has invalid payload`);
      }
      return action as PlanAction;
    });
  return {
    opts,
    distributePlan,
    executionPlan: { ...distributePlan, actions },
  };
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
  const entry = await handler(env, action, prior, snapshotPath, context.projectRoot);
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
): Promise<LedgerEntry> {
  if (!action.source) {
    throw new Error(`apply: skills action for "${action.agent}" missing source path`);
  }
  const source = action.source;

  // 源目录指纹只供 copy 幂等判定；最终 receipt 统一从完整 staged target 计算。
  // symlink 幂等短路不读源目录，copy 路径则 memoize，避免重复遍历。
  let sourceHashCache: string | undefined;
  const getSourceHash = async (): Promise<string> => {
    if (sourceHashCache === undefined) sourceHashCache = await hashDir(env, source);
    return sourceHashCache;
  };
  // Source evidence is part of the static receipt preparation. Finish this fallible read before
  // linkOrCopy can swap a staged placement over the current target.
  const sourceFingerprint = await getSourceHash();

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

  const result = await linkOrCopy(env, source, action.target, {
    method: action.method,
    kind: "dir",
    replaceExisting: prior !== undefined || snapshotPath !== undefined,
    preparePlaced: async (placedTarget) => {
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
