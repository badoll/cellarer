// status:库房台账 vs 实际落地的漂移检测(kickoff §8.4)。
// 文件型(rules/mcp,op=write):缺失→missing;软链断裂→broken-link;checksum 不符→drifted。
// 目录型(skills,link/copy):缺失→missing;软链断裂→broken-link;存在即 ok(目录不做内容 checksum)。
import type { Env } from "../env.js";
import { lstatOrNull, readFileOrNull } from "../fs/probe.js";
import type { LedgerEntry } from "../model/index.js";
import { sha256 } from "../store/checksum.js";
import { loadLedger, matchesFilter } from "../store/ledger.js";
import type { DriftStatus, StatusItem, StatusOptions } from "./types.js";

export async function status(env: Env, opts: StatusOptions): Promise<StatusItem[]> {
  const ledger = await loadLedger(env, opts.storeRoot);
  const items: StatusItem[] = [];

  for (const entry of ledger.entries) {
    if (!matchesFilter(entry, opts)) continue;
    items.push({
      artifact: entry.artifact,
      agent: entry.agent,
      scope: entry.scope,
      capability: entry.capability,
      target: entry.target,
      status: await checkEntry(env, entry),
    });
  }
  return items;
}

async function checkEntry(env: Env, entry: LedgerEntry): Promise<DriftStatus> {
  const lstat = await lstatOrNull(env, entry.target);
  if (lstat === null) return "missing";

  // 软链落地:校验是否断链(rules/mcp 不软链,skills 软链常见)。
  if (lstat.isSymbolicLink()) {
    try {
      await env.fs.realpath(entry.target);
      return "ok"; // 链接完好;目标内容(库房真源)由 status 不再二次校验。
    } catch {
      return "broken-link";
    }
  }

  // 目录型落地(skills copy):存在即 ok(不做目录内容 checksum)。
  if (lstat.isDirectory()) return "ok";

  // 文件型落地(rules/mcp write):比对内容 checksum。
  const content = await readFileOrNull(env, entry.target);
  if (content === null) return "missing";
  return sha256(content) === entry.checksum ? "ok" : "drifted";
}
