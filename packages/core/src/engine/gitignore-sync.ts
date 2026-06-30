// .gitignore 与台账同步:project 工程的 managed block 始终从「当前台账中该目录下的
// 全部 project-scope 落地目标」整体重建,而非某次 apply/revert 的局部 targets。
// 这样多 agent 分批 apply、或 partial revert 后,block 仍与实际生成物一致。
import type { Env } from "../env.js";
import { removeManagedBlock, updateGitignore } from "../fs/gitignore.js";
import { isPathInside } from "../fs/safety.js";
import type { Ledger } from "../model/index.js";

// 台账中位于 dir 之内的 project-scope 目标(去重保序)。
function projectTargetsUnder(ledger: Ledger, dir: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of ledger.entries) {
    if (e.scope !== "project") continue;
    if (!isPathInside(e.target, dir)) continue;
    if (seen.has(e.target)) continue;
    seen.add(e.target);
    out.push(e.target);
  }
  return out;
}

// 重建(或清除)dir 的 .gitignore managed block 以匹配台账现状。
export async function syncGitignore(env: Env, dir: string, ledger: Ledger): Promise<void> {
  const targets = projectTargetsUnder(ledger, dir);
  if (targets.length === 0) {
    await removeManagedBlock(env, dir);
    return;
  }
  await updateGitignore(env, dir, targets);
}
