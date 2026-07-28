// apply = plan + 执行 + 写台账(不变量 3/5)。dryRun 只返回 plan,不落地。
// 分派结构(M2 重构):按 PlanAction.op 查 handler 表,引擎不散写 if (cap === "rules" && op === "write")。
// 每个 op handler 负责一种落地动作(write/merge/overwrite/symlink/copy),返回写入台账的条目。
// op 未登记 handler → 显式抛错(防「plan 产出了某 op,apply 却静默忽略」),新增能力必须在此登记。
//
// 幂等关键:重复 apply 必须产出与磁盘一致的台账,且不丢失首次备份指针 ——
//   故复用既有台账条目的 backup;内容未变时保留 appliedAt 并跳过重写(避免 mtime 抖动)。

import { appendActivity } from "../activity.js";
import type { Env } from "../env.js";
import { atomicWrite } from "../fs/atomicWrite.js";
import { hashDir } from "../fs/hashDir.js";
import { linkOrCopy } from "../fs/linkOrCopy.js";
import { lstatOrNull } from "../fs/probe.js";
import { assertNotSymbolicLink } from "../fs/safety.js";
import type { Ledger, LedgerEntry, PlanAction } from "../model/index.js";
import { sha256 } from "../store/checksum.js";
import { addEntries, entryKey, loadLedger, saveLedger } from "../store/ledger.js";
import { fingerprintTarget } from "../target-ownership.js";
import { createEncryptedTargetSnapshot, SnapshotCreationError } from "../target-snapshot.js";
import { syncGitignore } from "./gitignore-sync.js";
import { plan } from "./plan.js";
import type { ApplyFailure, ApplyResult, DistributeOptions } from "./types.js";

// op handler:执行一种落地动作并返回台账条目。prior 是同键既有条目(供幂等复用 backup/appliedAt)。
type OpHandler = (
  env: Env,
  action: PlanAction,
  prior: LedgerEntry | undefined,
  snapshotPath: string | undefined,
) => Promise<LedgerEntry>;

interface ApplyContext {
  storeRoot: string;
  snapshotPassphrase?: string;
}

interface AppliedAction {
  entry: LedgerEntry;
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

export async function apply(env: Env, opts: DistributeOptions): Promise<ApplyResult> {
  const distributePlan = await plan(env, opts);

  // Duplicate physical owners make the ledger globally unsafe to update. Planning already exposes
  // the target-keyed conflict, so non-dry apply returns the same blocked result without reopening
  // the ledger through the strict mutation path or performing any effect.
  if (opts.dryRun || distributePlan.invalidLedger) {
    return { plan: distributePlan, entries: [], failures: [] };
  }

  const ledger = await loadLedger(env, opts.storeRoot);
  const entries: LedgerEntry[] = [];
  const failures: ApplyFailure[] = [];
  const transientSnapshots = new Set<string>();

  for (const action of distributePlan.actions) {
    if (action.op === "skip") continue;
    const prior = findEntry(ledger, action);
    try {
      const applied = await applyAction(env, action, prior, {
        storeRoot: opts.storeRoot,
        snapshotPassphrase: opts.snapshotPassphrase,
      });
      entries.push(applied.entry);
      if (applied.transientSnapshotPath) {
        transientSnapshots.add(applied.transientSnapshotPath);
      }
    } catch (error) {
      if (!(error instanceof SnapshotCreationError)) throw error;
      failures.push({ code: "SNAPSHOT_FAILED", target: action.target, message: error.message });
    }
  }

  // 写台账(同键替换,保证幂等)。
  const nextLedger = addEntries(ledger, entries);
  await saveLedger(env, opts.storeRoot, nextLedger);

  // Drift snapshots protect only the current mutation attempt. Once its owner receipt is durable,
  // the original recovery baseline remains authoritative and the temporary asset is unreferenced.
  for (const snapshotPath of transientSnapshots) {
    try {
      await env.fs.rm(snapshotPath, { force: true });
    } catch (error) {
      distributePlan.warnings.push(
        `apply succeeded but temporary recovery snapshot cleanup failed for "${snapshotPath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // project scope:.gitignore block 从「最终台账」整体重建(而非仅本次 targets),
  // 否则换一组 --agent 再 apply 会丢掉先前 agent 的条目。
  if (opts.scope === "project" && opts.dir) {
    await syncGitignore(env, opts.dir, nextLedger);
  }

  try {
    await appendActivity(env, opts.storeRoot, {
      action: "apply",
      scope: opts.scope,
      projectDir: opts.dir,
      agents: opts.agents,
      capabilities: opts.capabilities ?? [...new Set(entries.map((entry) => entry.capability))],
      affectedCount: entries.length,
      warningsCount: distributePlan.warnings.length,
      summary: `Applied ${entries.length} ${entries.length === 1 ? "target" : "targets"}`,
      references: {
        ledgerEntryKeys: entries.map(entryKey),
        artifactIds: entries.flatMap((entry) => entry.artifactIds),
      },
      secretRefs: entries.flatMap((entry) => entry.secretRefs ?? []),
    });
  } catch (err) {
    distributePlan.warnings.push(
      `activity log failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { plan: distributePlan, entries, failures };
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
  }
  try {
    const entry = await handler(env, action, prior, snapshotPath);
    return {
      entry,
      ...(snapshotPath && prior ? { transientSnapshotPath: snapshotPath } : {}),
    };
  } catch (error) {
    if (snapshotPath) {
      const currentFingerprint = await fingerprintTarget(env, action.target).catch(() => null);
      if (currentFingerprint === action.ownership?.currentFingerprint) {
        await env.fs.rm(snapshotPath, { force: true }).catch(() => {});
      }
    }
    throw error;
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
): Promise<LedgerEntry> {
  const content = action.preview?.after ?? "";
  const checksum = sha256(content);

  // 内容已与磁盘一致(幂等)→ 不重写,保留既有 backup/appliedAt,台账字节不变。
  if (
    prior &&
    action.preview?.before === content &&
    prior.receipt.fingerprint === checksum &&
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
    artifactIds: actionArtifactIds(action),
    receipt: {
      method: "write",
      fingerprint: checksum,
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
    prior.receipt.fingerprint === (await getSourceHash()) &&
    sameArtifactIds(prior.artifactIds, actionArtifactIds(action))
  ) {
    const targetStat = await lstatOrNull(env, action.target);
    if (
      targetStat?.isDirectory() &&
      (await hashDir(env, action.target)) === (await getSourceHash())
    ) {
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
    result.method === prior.receipt.method &&
    backup === prior.receipt.backup &&
    prior.receipt.generated &&
    sameArtifactIds(prior.artifactIds, artifactIds)
  ) {
    return prior;
  }

  return {
    agent: action.agent,
    scope: action.scope,
    capability: action.capability,
    target: action.target,
    artifactIds,
    receipt: {
      method: result.method,
      // 统一 target 指纹：copy 覆盖完整目录，symlink 覆盖顶层 kind/mode/readlink target 与内容。
      fingerprint: receiptFingerprint,
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
