// status:库房台账 vs 实际落地的漂移检测(kickoff §8.4)。
// 文件型(rules/mcp,op=write):缺失→missing;软链断裂→broken-link;checksum 不符→drifted。
// 目录型(skills):copy 与 symlink/junction 都使用统一 target fingerprint；软链另保留 broken-link 状态。
import type { Env } from "../env.js";
import { lstatOrNull } from "../fs/probe.js";
import type { LedgerEntry } from "../model/index.js";
import type { AssertExact, ExactContract } from "../protocol/client-types.js";
import { loadLedger, matchesFilter } from "../store/ledger.js";
import { fingerprintTarget } from "../target-ownership.js";
import type { StatusItem, StatusOptions } from "./types.js";

async function statusImplementation(env: Env, opts: StatusOptions) {
  const ledger = await loadLedger(env, opts.storeRoot);
  const items: ReturnType<typeof statusItem>[] = [];

  for (const entry of ledger.owners) {
    if (!matchesFilter(entry, opts)) continue;
    items.push(statusItem(entry, await checkEntry(env, entry)));
  }
  return items;
}

export async function status(env: Env, opts: StatusOptions): Promise<StatusItem[]> {
  return statusImplementation(env, opts);
}

function statusItem(entry: LedgerEntry, status: Awaited<ReturnType<typeof checkEntry>>) {
  return {
    artifact: entry.artifactIds.join(", "),
    agent: entry.agent,
    scope: entry.scope,
    capability: entry.capability,
    target: entry.target,
    status,
  };
}

export type StatusItemProducerContract = AssertExact<
  ExactContract<ReturnType<typeof statusItem>, StatusItem>
>;

async function checkEntry(env: Env, entry: LedgerEntry) {
  const lstat = await lstatOrNull(env, entry.target);
  if (lstat === null) return "missing";

  // 软链落地:先保留 broken-link 的公共状态，再用与 apply/plan/revert 相同的指纹
  // 检测改链、mode 及 readlink target 漂移。
  if (lstat.isSymbolicLink()) {
    try {
      await env.fs.realpath(entry.target);
    } catch {
      return "broken-link";
    }
  }

  const fingerprint = await fingerprintTarget(env, entry.target);
  return fingerprint === entry.receipt.fingerprint ? "ok" : "drifted";
}
