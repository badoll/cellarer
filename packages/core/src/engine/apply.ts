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
import { backupIfNeeded } from "../fs/backup.js";
import { hashDir } from "../fs/hashDir.js";
import { linkOrCopy } from "../fs/linkOrCopy.js";
import { lstatOrNull } from "../fs/probe.js";
import { assertNotSymbolicLink } from "../fs/safety.js";
import type { Ledger, LedgerEntry, PlanAction } from "../model/index.js";
import { sha256 } from "../store/checksum.js";
import { addEntries, entryKey, loadLedger, saveLedger } from "../store/ledger.js";
import { syncGitignore } from "./gitignore-sync.js";
import { plan } from "./plan.js";
import type { ApplyResult, DistributeOptions } from "./types.js";

// op handler:执行一种落地动作并返回台账条目。prior 是同键既有条目(供幂等复用 backup/appliedAt)。
type OpHandler = (
  env: Env,
  action: PlanAction,
  prior: LedgerEntry | undefined,
) => Promise<LedgerEntry>;

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

  if (opts.dryRun) {
    return { plan: distributePlan, entries: [] };
  }

  const ledger = await loadLedger(env, opts.storeRoot);
  const entries: LedgerEntry[] = [];

  for (const action of distributePlan.actions) {
    if (action.op === "skip") continue;
    const prior = findEntry(ledger, action);
    entries.push(await applyAction(env, action, prior));
  }

  // 写台账(同键替换,保证幂等)。
  const nextLedger = addEntries(ledger, entries);
  await saveLedger(env, opts.storeRoot, nextLedger);

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
        artifactIds: entries.map((entry) => entry.artifact),
      },
      secretRefs: entries.flatMap((entry) => entry.secretRefs ?? []),
    });
  } catch (err) {
    distributePlan.warnings.push(
      `activity log failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { plan: distributePlan, entries };
}

// 按 op 分派到 handler;未登记的 op 显式失败(M2 新增能力必须在 OP_HANDLERS 登记)。
function applyAction(
  env: Env,
  action: PlanAction,
  prior: LedgerEntry | undefined,
): Promise<LedgerEntry> {
  const handler = OP_HANDLERS[action.op];
  if (!handler) {
    throw new Error(
      `apply: no handler for op "${action.op}" (${action.capability}, agent "${action.agent}")`,
    );
  }
  return handler(env, action, prior);
}

// 按台账唯一键查既有条目(供幂等复用 backup/appliedAt)。复用 entryKey,与 addEntries 合并口径一致。
function findEntry(ledger: Ledger, action: PlanAction): LedgerEntry | undefined {
  const key = entryKey(action);
  return ledger.entries.find((e) => entryKey(e) === key);
}

// 内容写入(rules render / mcp merge|overwrite):plan 已算好最终文本,这里只做备份 + 原子写。
// generated:write(rules 整文件由 cellarer 生成)→ true;merge/overwrite(并入用户既有文件)→ false。
async function applyContentWrite(
  env: Env,
  action: PlanAction,
  prior: LedgerEntry | undefined,
): Promise<LedgerEntry> {
  const content = action.preview?.after ?? "";
  const checksum = sha256(content);

  // 内容已与磁盘一致(幂等)→ 不重写,保留既有 backup/appliedAt,台账字节不变。
  if (prior && action.preview?.before === content && prior.checksum === checksum) {
    return prior;
  }

  // 安全:不跟随软链写(防穿越);备份既有用户文件。
  await assertNotSymbolicLink(env, action.target);
  // backup 指针只在首次落地时确立;后续 apply 复用,避免被生成物覆盖丢失原始备份。
  const backup = prior?.backup ?? (await backupIfNeeded(env, action.target));

  // atomicWrite 内部会建父目录,无需重复 mkdir。
  await atomicWrite(env, action.target, content);

  return {
    artifact: action.artifact,
    agent: action.agent,
    scope: action.scope,
    capability: action.capability,
    target: action.target,
    method: "write",
    checksum,
    backup,
    generated: action.op === "write",
    appliedAt: env.now().toISOString(),
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
): Promise<LedgerEntry> {
  if (!action.source) {
    throw new Error(`apply: skills action for "${action.agent}" missing source path`);
  }
  const source = action.source;

  // 内容指纹惰性化:symlink 幂等短路路径(下方 result.skipped && prior)不需要它,
  // 避免每次 symlink re-apply 白读整个 skill 目录(横评复审 §5)。仅 copy 幂等判定与新建条目时求值,memoize。
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
    prior?.method === "copy" && (action.method === "copy" || env.platform === "win32");
  if (copyWouldReproduce && prior.checksum === (await getSourceHash())) {
    const targetStat = await lstatOrNull(env, action.target);
    if (
      targetStat?.isDirectory() &&
      (await hashDir(env, action.target)) === (await getSourceHash())
    ) {
      return prior;
    }
  }

  const result = await linkOrCopy(env, source, action.target, {
    method: action.method,
    kind: "dir",
  });

  // 幂等短路命中(已是同指向软链)→ 保留既有台账条目(含 appliedAt)。
  if (result.skipped && prior) return prior;

  return {
    artifact: action.artifact,
    agent: action.agent,
    scope: action.scope,
    capability: action.capability,
    target: action.target,
    method: result.method,
    // 内容指纹:status 对 copy 落地的真实目录用它比对(检出手改);symlink/junction 则只校验链完好。
    checksum: await getSourceHash(),
    backup: null, // skills 是新目录落地,不覆盖用户文件,无备份。
    generated: true, // 由 cellarer 落地的链接/拷贝,revert 可整体删除。
    appliedAt: env.now().toISOString(),
  };
}
