// state.json 台账读写(kickoff §7.3,见计划 §3.4)。
// 台账是 revert 的权威来源(优于 ruler 靠 marker 反推),记录每次实际落地。
import { join } from "node:path";
import { z } from "zod";
import type { Env } from "../env.js";
import { atomicWrite } from "../fs/atomicWrite.js";
import { readFileOrNull } from "../fs/probe.js";
import { isPathInside } from "../fs/safety.js";
import type { Ledger, LedgerEntry, Scope } from "../model/index.js";

const entrySchema = z.object({
  artifact: z.string(),
  agent: z.string(),
  scope: z.enum(["global", "project"]),
  capability: z.enum(["rules", "mcp", "skills"]),
  target: z.string(),
  method: z.enum(["write", "symlink", "junction", "copy"]),
  checksum: z.string(),
  backup: z.string().nullable(),
  generated: z.boolean(),
  appliedAt: z.string(),
  secretRefs: z.array(z.string()).optional(),
});

const ledgerSchema = z.object({
  version: z.literal(1),
  entries: z.array(entrySchema),
});

export function makeLedger(entries: LedgerEntry[]): Ledger {
  return { version: 1, entries };
}

export function emptyLedger(): Ledger {
  return makeLedger([]);
}

// 唯一键:同一 (artifact, agent, scope, target) 视为同一条落地,重复 apply 时替换。
// 单一来源:addEntries 合并与 apply 幂等查找都据此,避免身份定义漂移。
export function entryKey(e: Pick<LedgerEntry, "artifact" | "agent" | "scope" | "target">): string {
  return `${e.artifact} ${e.agent} ${e.scope} ${e.target}`;
}

// 台账查询过滤器(scope / agents / dir),被 revert / status 共用。
export interface LedgerFilter {
  scope?: Scope;
  agents?: string[];
  dir?: string;
}

// entry 是否命中过滤器:dir 用 isPathInside(而非脆弱的 startsWith 前缀匹配)。
export function matchesFilter(entry: LedgerEntry, filter: LedgerFilter): boolean {
  if (filter.scope && entry.scope !== filter.scope) return false;
  if (filter.agents && filter.agents.length > 0 && !filter.agents.includes(entry.agent)) {
    return false;
  }
  if (filter.dir && !isPathInside(entry.target, filter.dir)) return false;
  return true;
}

// 合并新条目:同键替换(保证幂等台账),新键追加。
export function addEntries(ledger: Ledger, incoming: LedgerEntry[]): Ledger {
  const map = new Map<string, LedgerEntry>();
  for (const e of ledger.entries) map.set(entryKey(e), e);
  for (const e of incoming) map.set(entryKey(e), e);
  return makeLedger([...map.values()]);
}

export async function loadLedger(env: Env, storeRoot: string): Promise<Ledger> {
  const path = join(storeRoot, "state.json");
  const text = await readFileOrNull(env, path);
  if (text === null) return emptyLedger();
  try {
    return ledgerSchema.parse(JSON.parse(text));
  } catch (err) {
    // 损坏的台账若直接抛原始栈,会连 revert(唯一恢复路径)都用不了 → 给可操作信息。
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`corrupt ledger at ${path}: ${msg}. Fix or remove the file to recover.`);
  }
}

export async function saveLedger(env: Env, storeRoot: string, ledger: Ledger): Promise<void> {
  const path = join(storeRoot, "state.json");
  await atomicWrite(env, path, `${JSON.stringify(ledger, null, 2)}\n`);
}
