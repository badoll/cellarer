// revert:依据台账回滚(不变量 5;优于 ruler 的 marker 反推,见计划 §7.2)。
// 对每条目:有 .bak → 恢复(--keep-backups 则保留 .bak 副本);
// 生成文件(write/copy)→ 删除;软链 → 只删链不删真源;最后清 project .gitignore block。
import type { Env } from "../env.js";
import { removeManagedBlock } from "../fs/gitignore.js";
import { readFileOrNull } from "../fs/probe.js";
import type { LedgerEntry } from "../model/index.js";
import { loadLedger, makeLedger, matchesFilter, saveLedger } from "../store/ledger.js";
import type { RevertOptions, RevertResult } from "./types.js";

export async function revert(env: Env, opts: RevertOptions): Promise<RevertResult> {
  const ledger = await loadLedger(env, opts.storeRoot);
  const reverted = ledger.entries.filter((e) => matchesFilter(e, opts));

  if (opts.dryRun) {
    return { reverted };
  }

  for (const entry of reverted) {
    await revertOne(env, entry, opts.keepBackups ?? false);
  }

  // 从台账移除已回滚条目(等价于保留未命中过滤器者)。
  const remaining = ledger.entries.filter((e) => !matchesFilter(e, opts));
  await saveLedger(env, opts.storeRoot, makeLedger(remaining));

  // 清理 project .gitignore managed block(opts.dir 至多一个)。
  if (opts.dir && reverted.some((e) => e.scope === "project")) {
    await removeManagedBlock(env, opts.dir);
  }

  return { reverted };
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
