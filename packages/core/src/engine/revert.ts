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
  const matched = ledger.entries.filter((e) => matchesFilter(e, opts));

  // 越界分区(先于任何破坏性删除):target 落在受管根内 → 回滚;否则 → 跳过 + 告警,保留台账不删。
  // 不 throw:一个越界条目(被篡改,或落在 home/cwd/--dir 之外的合法工程)不应阻断其余合法条目的回滚,
  // 也绝不删除盘外文件(安全)。用户可用 --dir 指明外部工程根来纳入其条目。
  const roots = allowedRevertRoots(env, opts);
  const warnings: string[] = [];
  const reverted: LedgerEntry[] = [];
  for (const entry of matched) {
    if (entry.target === "" || roots.some((root) => isPathInside(entry.target, root))) {
      reverted.push(entry);
    } else {
      warnings.push(
        `refusing to revert "${entry.agent}" target "${entry.target}" — outside managed roots [${roots.join(", ")}]. Pass --dir to include a project outside your home directory.`,
      );
    }
  }

  if (opts.dryRun) {
    return { reverted, warnings };
  }

  for (const entry of reverted) {
    await revertOne(env, entry, opts.keepBackups ?? false);
  }

  // 从台账移除已回滚条目(引用相等,reverted 是 ledger.entries 的子集);
  // 跳过的越界条目与未命中过滤器者一并保留。
  const revertedSet = new Set(reverted);
  const remaining = makeLedger(ledger.entries.filter((e) => !revertedSet.has(e)));
  await saveLedger(env, opts.storeRoot, remaining);

  // 受影响 project 目录的 .gitignore 按剩余台账重建(可能仍有其它 agent 的条目)。
  await resyncAffectedGitignores(env, reverted, remaining, opts.dir);

  return { reverted, warnings };
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

// revert 的可信受管根:target 必须落在其一内才允许删除(否则跳过 + 告警,绝不删盘外文件)。
// 不按 entry.scope 分派根 —— scope 与 target 同存于可篡改台账,relabel 即可绕过按 scope 选根的校验。
// 统一用「家目录(global 落点)∪ cwd ∪ 显式 --dir(project 工程根)」并集。
function allowedRevertRoots(env: Env, opts: RevertOptions): string[] {
  const roots = [env.homedir(), env.cwd()];
  if (opts.dir) roots.push(opts.dir);
  return roots;
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
