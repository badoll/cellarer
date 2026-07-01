// revert:依据台账回滚(不变量 5;优于 ruler 的 marker 反推,见计划 §7.2)。
// 对每条目:有 .bak → 恢复(--keep-backups 则保留 .bak 副本);
// 生成文件(write/copy)→ 删除;软链 → 只删链不删真源;最后按剩余台账重建 project .gitignore。
import { dirname } from "node:path";
import type { Env } from "../env.js";
import { readFileOrNull } from "../fs/probe.js";
import { isPathInside } from "../fs/safety.js";
import type { Ledger, LedgerEntry } from "../model/index.js";
import { loadLedger, makeLedger, matchesFilter, saveLedger } from "../store/ledger.js";
import { syncGitignore } from "./gitignore-sync.js";
import type { RevertOptions, RevertResult } from "./types.js";

export async function revert(env: Env, opts: RevertOptions): Promise<RevertResult> {
  const ledger = await loadLedger(env, opts.storeRoot);
  const reverted = ledger.entries.filter((e) => matchesFilter(e, opts));

  if (opts.dryRun) {
    return { reverted };
  }

  // 越界护栏先于任何破坏性删除:全部校验通过才开始 rm(prepare-before-destroy),
  // 否则一个被篡改的越界条目可能在前序合法条目已删后才被拦,破坏原子性直觉。
  const roots = allowedRevertRoots(env, opts);
  for (const entry of reverted) {
    assertRevertTargetInRoot(entry, roots);
  }
  for (const entry of reverted) {
    await revertOne(env, entry, opts.keepBackups ?? false);
  }

  // 从台账移除已回滚条目(等价于保留未命中过滤器者)。
  const remaining = makeLedger(ledger.entries.filter((e) => !matchesFilter(e, opts)));
  await saveLedger(env, opts.storeRoot, remaining);

  // 受影响 project 目录的 .gitignore 按剩余台账重建(可能仍有其它 agent 的条目)。
  // 收集被回滚的 project 条目所在目录;opts.dir 显式时也纳入(即便其下已无条目,需清空)。
  await resyncAffectedGitignores(env, reverted, remaining, opts.dir);

  return { reverted };
}

// 重建所有「被回滚条目波及的 project 目录」的 .gitignore,使其匹配剩余台账。
async function resyncAffectedGitignores(
  env: Env,
  reverted: LedgerEntry[],
  remaining: Ledger,
  optsDir: string | undefined,
): Promise<void> {
  const dirs = new Set<string>();
  if (optsDir) dirs.add(optsDir);
  for (const e of reverted) {
    if (e.scope === "project") dirs.add(dirname(e.target));
  }
  for (const dir of dirs) {
    await syncGitignore(env, dir, remaining);
  }
}

// 删前越界护栏:防止篡改的 state.json 把 revert 的 rm 引向管理根之外(§5.1 assertPathInside 接入点)。
// 关键:不按 entry.scope 分派根 —— scope 与 target 同存于可被篡改的台账,攻击者只需把恶意条目
// 标成任一 scope 即可绕过按 scope 选根的校验。故对**所有**条目统一校验:target 必须落在
// 「可信可知的受管根」并集内 —— 家目录(global 落点)∪ cwd ∪ 显式 --dir(project 工程根)。
// 越界即拒绝并提示(而非静默删除):project 工程根在 home/cwd 之外时,用 --dir 指明即可放行。
function allowedRevertRoots(env: Env, opts: RevertOptions): string[] {
  const roots = [env.homedir(), env.cwd()];
  if (opts.dir) roots.push(opts.dir);
  return roots;
}

function assertRevertTargetInRoot(entry: LedgerEntry, roots: string[]): void {
  if (entry.target === "") return;
  if (roots.some((root) => isPathInside(entry.target, root))) return;
  throw new Error(
    `safety: refusing to revert "${entry.agent}" target "${entry.target}" — outside managed roots [${roots.join(", ")}]. Pass --dir to revert a project outside your home directory.`,
  );
}

async function revertOne(env: Env, entry: LedgerEntry, keepBackups: boolean): Promise<void> {
  // 先移除落地物:软链只删链;生成文件直接删。
  await env.fs.rm(entry.target, { recursive: true, force: true });

  // 有备份 → 恢复用户原始文件。
  if (entry.backup) {
    const original = await readFileOrNull(env, entry.backup);
    if (original !== null) {
      await env.fs.writeFile(entry.target, original);
      if (!keepBackups) await env.fs.rm(entry.backup, { force: true });
    }
  }
}
