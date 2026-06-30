// apply = plan + 执行 + 写台账(不变量 3/5)。dryRun 只返回 plan,不落地。
// M1 rules:备份既有 → 安全校验 → 原子写 → 记台账(generated:true)→ project 维护 .gitignore。
// 幂等关键:重复 apply 必须产出与磁盘一致的台账,且不丢失首次备份指针 ——
//   故复用既有台账条目的 backup;内容未变时保留 appliedAt 并跳过重写(避免 mtime 抖动)。
import type { Env } from "../env.js";
import { atomicWrite } from "../fs/atomicWrite.js";
import { backupIfNeeded } from "../fs/backup.js";
import { assertNotSymbolicLink } from "../fs/safety.js";
import type { Ledger, LedgerEntry, PlanAction } from "../model/index.js";
import { sha256 } from "../store/checksum.js";
import { addEntries, entryKey, loadLedger, saveLedger } from "../store/ledger.js";
import { syncGitignore } from "./gitignore-sync.js";
import { plan } from "./plan.js";
import type { ApplyResult, DistributeOptions } from "./types.js";

export async function apply(env: Env, opts: DistributeOptions): Promise<ApplyResult> {
  const distributePlan = await plan(env, opts);

  if (opts.dryRun) {
    return { plan: distributePlan, entries: [] };
  }

  const ledger = await loadLedger(env, opts.storeRoot);
  const entries: LedgerEntry[] = [];

  for (const action of distributePlan.actions) {
    if (action.op === "skip") continue;
    if (action.capability === "rules" && action.op === "write") {
      const prior = findEntry(ledger, action);
      const entry = await applyRulesWrite(env, action, prior);
      entries.push(entry);
    } else {
      // 防御:plan 当前只产出 skip 或 rules/write;出现未知动作应显式失败而非静默丢弃
      // (M2 加 mcp/skills 时强制在此登记处理,避免「返回成功却什么都没写」)。
      throw new Error(
        `apply: unhandled action ${action.capability}/${action.op} for agent "${action.agent}"`,
      );
    }
  }

  // 写台账(同键替换,保证幂等)。
  const nextLedger = addEntries(ledger, entries);
  await saveLedger(env, opts.storeRoot, nextLedger);

  // project scope:.gitignore block 从「最终台账」整体重建(而非仅本次 targets),
  // 否则换一组 --agent 再 apply 会丢掉先前 agent 的条目。
  if (opts.scope === "project" && opts.dir) {
    await syncGitignore(env, opts.dir, nextLedger);
  }

  return { plan: distributePlan, entries };
}

// 按台账唯一键查既有条目(供幂等复用 backup/appliedAt)。复用 entryKey,与 addEntries 合并口径一致。
function findEntry(ledger: Ledger, action: PlanAction): LedgerEntry | undefined {
  const key = entryKey(action);
  return ledger.entries.find((e) => entryKey(e) === key);
}

async function applyRulesWrite(
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
    capability: "rules",
    target: action.target,
    method: "write",
    checksum,
    backup,
    generated: true,
    appliedAt: env.now().toISOString(),
    secretRefs: action.secretRefs,
  };
}
