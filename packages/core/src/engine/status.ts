// status:库房台账 vs 实际落地的漂移检测(kickoff §8.4)。
// 文件型(rules/mcp,op=write):缺失→missing;软链断裂→broken-link;checksum 不符→drifted。
// 目录型(skills):软链/junction 落地→只校验链完好(内容=库房真源,天然同步);
//   copy 落地的真实目录→用 hashDir 内容指纹比对台账 checksum,手改→drifted(横评 §5.2)。
import type { Env } from "../env.js";
import { hashDir } from "../fs/hashDir.js";
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

  // 目录型落地(skills copy/junction):
  //   - junction(Windows 目录软链)对 lstat 可能报目录而非 symlink,但其内容 = 库房真源,
  //     与 symlink 同理只需存在即 ok;仅当台账 method=copy(真实拷贝)才做内容漂移比对。
  if (lstat.isDirectory()) {
    if (entry.capability === "skills" && entry.method === "copy") {
      return (await hashDir(env, entry.target)) === entry.checksum ? "ok" : "drifted";
    }
    return "ok"; // symlink/junction 落地:内容随真源,存在即 ok。
  }

  // 文件型落地(rules/mcp write):比对内容 checksum。
  const content = await readFileOrNull(env, entry.target);
  if (content === null) return "missing";
  return sha256(content) === entry.checksum ? "ok" : "drifted";
}
