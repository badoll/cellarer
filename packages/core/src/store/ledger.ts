// state.json 台账读写(kickoff §7.3,见计划 §3.4)。
// 台账是 revert 的权威来源(优于 ruler 靠 marker 反推),记录每次实际落地。
import { join, normalize } from "node:path";
import { z } from "zod";
import type { Env } from "../env.js";
import { atomicWrite } from "../fs/atomicWrite.js";
import { readFileOrNull } from "../fs/probe.js";
import { isPathInside } from "../fs/safety.js";
import type { Ledger, Scope, TargetOwner } from "../model/index.js";

const appliedReceiptSchema = z.object({
  method: z.enum(["write", "symlink", "junction", "copy"]),
  fingerprint: z.string(),
  backup: z.string().nullable(),
  generated: z.boolean(),
  appliedAt: z.string(),
});

const artifactIdSchema = z.string().regex(/^(rules|mcp|skills)\/[^/*,\s]+$/);

const targetOwnerSchema = z.object({
  agent: z.string(),
  scope: z.enum(["global", "project"]),
  capability: z.enum(["rules", "mcp", "skills"]),
  target: z.string(),
  artifactIds: z
    .array(artifactIdSchema)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, "artifactIds must be an ordered set"),
  receipt: appliedReceiptSchema,
  secretRefs: z.array(z.string()).optional(),
});

const ledgerSchema = z.object({
  version: z.literal(2),
  owners: z.array(targetOwnerSchema),
});

export class LegacyLedgerVersionError extends Error {
  constructor(path: string) {
    super(
      `legacy ledger version 1 at ${path} requires a pre-release reset; back up and remove state.json before re-applying managed artifacts`,
    );
    this.name = "LegacyLedgerVersionError";
  }
}

export class DuplicateTargetOwnerError extends Error {
  constructor(
    path: string,
    readonly ledger: Ledger,
    readonly duplicateKeys: string[],
  ) {
    super(
      `invalid ownership state at ${path}: duplicate physical owner ${duplicateKeys.join(", ")}`,
    );
    this.name = "DuplicateTargetOwnerError";
  }
}

export function makeLedger(owners: TargetOwner[]): Ledger {
  const normalizedOwners = z.array(targetOwnerSchema).parse(owners.map(normalizeOwner));
  assertUniqueOwners(normalizedOwners);
  return { version: 2, owners: normalizedOwners };
}

export function emptyLedger(): Ledger {
  return makeLedger([]);
}

// owner 唯一键只描述物理目标；artifactIds 是 provenance，不参与身份。
export function targetKey(
  owner: Pick<TargetOwner, "agent" | "scope" | "capability" | "target">,
): string {
  return JSON.stringify([owner.agent, owner.scope, owner.capability, normalize(owner.target)]);
}

export const entryKey = targetKey;

// 台账查询过滤器(scope / agents / dir),被 revert / status 共用。
export interface LedgerFilter {
  scope?: Scope;
  agents?: string[];
  dir?: string;
}

// entry 是否命中过滤器:dir 用 isPathInside(而非脆弱的 startsWith 前缀匹配)。
export function matchesFilter(entry: TargetOwner, filter: LedgerFilter): boolean {
  if (filter.scope && entry.scope !== filter.scope) return false;
  if (filter.agents && filter.agents.length > 0 && !filter.agents.includes(entry.agent)) {
    return false;
  }
  if (filter.dir && !isPathInside(entry.target, filter.dir)) return false;
  return true;
}

// 合并 owner:同一物理目标由最新成功凭据替换，输入制品变化不会产生第二个 owner。
export function addOwners(ledger: Ledger, incoming: TargetOwner[]): Ledger {
  const map = new Map<string, TargetOwner>();
  for (const owner of ledger.owners) map.set(targetKey(owner), owner);
  for (const owner of incoming) map.set(targetKey(owner), normalizeOwner(owner));
  return makeLedger([...map.values()]);
}

export const addEntries = addOwners;

// 聚合台账中用到的全部密钥引用名(去重 + 排序;只名不值)。
// 单一来源:CLI(secret 审计)与 web(/api/secrets)共用,避免两处各写聚合口径(不变量 1)。
export function collectLedgerSecretRefs(ledger: Ledger): string[] {
  const names = new Set<string>();
  for (const owner of ledger.owners) for (const ref of owner.secretRefs ?? []) names.add(ref);
  return [...names].sort();
}

export interface LedgerSecretRefStat {
  name: string;
  ledgerEntryCount: number;
}

export function collectLedgerSecretRefStats(ledger: Ledger): LedgerSecretRefStat[] {
  const counts = new Map<string, number>();
  for (const owner of ledger.owners) {
    for (const ref of new Set(owner.secretRefs ?? [])) {
      counts.set(ref, (counts.get(ref) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ledgerEntryCount]) => ({ name, ledgerEntryCount }));
}

export async function loadLedger(env: Env, storeRoot: string): Promise<Ledger> {
  const path = join(storeRoot, "state.json");
  const text = await readFileOrNull(env, path);
  if (text === null) return emptyLedger();
  try {
    const json: unknown = JSON.parse(text);
    if (isLegacyLedger(json)) throw new LegacyLedgerVersionError(path);
    const ledger = ledgerSchema.parse(json);
    const duplicateLedger: Ledger = { version: 2, owners: ledger.owners };
    const duplicateKeys = duplicateTargetOwnerKeys(duplicateLedger.owners);
    if (duplicateKeys.length > 0) {
      // Recovery planning must retain every duplicate record exactly as parsed. Normalizing this
      // evidence would make a later selective recovery rewrite silently alter unrelated records.
      throw new DuplicateTargetOwnerError(path, duplicateLedger, duplicateKeys);
    }
    return makeLedger(ledger.owners);
  } catch (err) {
    if (err instanceof LegacyLedgerVersionError || err instanceof DuplicateTargetOwnerError) {
      throw err;
    }
    // 损坏的台账若直接抛原始栈,会连 revert(唯一恢复路径)都用不了 → 给可操作信息。
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`corrupt ledger at ${path}: ${msg}. Fix or remove the file to recover.`);
  }
}

// Planning must surface duplicate owners as target-keyed INVALID_TARGET_OWNER conflicts. Ordinary
// apply/save paths remain closed; only the narrow selective-revert writer below may preserve them.
export async function loadLedgerForPlanning(env: Env, storeRoot: string): Promise<Ledger> {
  try {
    return await loadLedger(env, storeRoot);
  } catch (error) {
    if (error instanceof DuplicateTargetOwnerError) return error.ledger;
    throw error;
  }
}

export async function saveLedger(env: Env, storeRoot: string, ledger: Ledger): Promise<void> {
  const path = join(storeRoot, "state.json");
  const validated = makeLedger(ledgerSchema.parse(ledger).owners);
  await atomicWrite(env, path, `${JSON.stringify(validated, null, 2)}\n`);
}

// Narrow recovery writer for a duplicate-bearing ledger. It only removes owners that the revert
// engine reports as successfully reverted, and never normalizes or rewrites the duplicate records.
export async function saveLedgerAfterSelectiveRevert(
  env: Env,
  storeRoot: string,
  original: Ledger,
  successfullyReverted: readonly TargetOwner[],
): Promise<Ledger> {
  const duplicateKeys = new Set(duplicateTargetOwnerKeys(original.owners));
  if (duplicateKeys.size === 0) {
    throw new Error("selective recovery writer requires a duplicate-bearing ledger");
  }
  if (successfullyReverted.length === 0) {
    throw new Error("selective recovery writer requires a successfully reverted owner");
  }

  const current = await loadLedgerForPlanning(env, storeRoot);
  if (!sameLedger(current, original)) {
    throw new Error("ownership state changed after revert planning; refusing selective recovery");
  }

  const removedKeys = new Set<string>();
  for (const reverted of successfullyReverted) {
    const key = targetKey(reverted);
    if (duplicateKeys.has(key)) {
      throw new Error(`selective recovery cannot remove duplicate physical owner ${key}`);
    }
    if (removedKeys.has(key)) {
      throw new Error(`selective recovery received duplicate successful owner ${key}`);
    }
    const matches = original.owners.filter((owner) => targetKey(owner) === key);
    if (matches.length !== 1 || !sameOwner(matches[0], reverted)) {
      throw new Error(`selective recovery owner is not an exact unique ledger record ${key}`);
    }
    removedKeys.add(key);
  }

  const remaining: Ledger = {
    version: 2,
    owners: original.owners.filter((owner) => !removedKeys.has(targetKey(owner))),
  };
  const validated = ledgerSchema.parse(remaining);
  const remainingDuplicateKeys = duplicateTargetOwnerKeys(validated.owners);
  if (
    remainingDuplicateKeys.length !== duplicateKeys.size ||
    remainingDuplicateKeys.some((key) => !duplicateKeys.has(key))
  ) {
    throw new Error("selective recovery changed duplicate owner groups");
  }
  for (const key of duplicateKeys) {
    const before = original.owners.filter((owner) => targetKey(owner) === key);
    const after = validated.owners.filter((owner) => targetKey(owner) === key);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(`selective recovery changed duplicate owner records ${key}`);
    }
  }

  const path = join(storeRoot, "state.json");
  await atomicWrite(env, path, `${JSON.stringify(validated, null, 2)}\n`);
  return { version: 2, owners: validated.owners };
}

function normalizeOwner(owner: TargetOwner): TargetOwner {
  return {
    ...owner,
    target: normalize(owner.target),
    artifactIds: [...new Set(owner.artifactIds)],
    secretRefs: owner.secretRefs ? [...new Set(owner.secretRefs)] : undefined,
  };
}

function assertUniqueOwners(owners: TargetOwner[]): void {
  const duplicates = duplicateTargetOwnerKeys(owners);
  if (duplicates[0]) {
    throw new Error(`invalid ownership state: duplicate physical owner ${duplicates[0]}`);
  }
}

export function duplicateTargetOwnerKeys(owners: readonly TargetOwner[]): string[] {
  const keys = new Set<string>();
  const duplicates = new Set<string>();
  for (const owner of owners) {
    const key = targetKey(owner);
    if (keys.has(key)) duplicates.add(key);
    keys.add(key);
  }
  return [...duplicates];
}

function sameLedger(left: Ledger, right: Ledger): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameOwner(left: TargetOwner | undefined, right: TargetOwner): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function isLegacyLedger(value: unknown): value is { version: 1 } {
  return typeof value === "object" && value !== null && "version" in value && value.version === 1;
}
