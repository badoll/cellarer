// state.json 台账读写(kickoff §7.3,见计划 §3.4)。
// 台账是 revert 的权威来源(优于 ruler 靠 marker 反推),记录每次实际落地。
import { isAbsolute, join, normalize } from "node:path";
import { z } from "zod";
import type { Env } from "../env.js";
import { readFileOrNull } from "../fs/probe.js";
import { isPathInside } from "../fs/safety.js";
import type { Ledger, Scope, TargetOwner } from "../model/index.js";
import { scanTextForSecrets } from "../secrets/detector.js";
import {
  assertNoSecretValues,
  containsObservableKnownValue,
  observableOptionsForEnv,
  type SecretValue,
  serializeObservable,
} from "../secrets/observable.js";

const appliedReceiptSchema = z.strictObject({
  method: z.enum(["write", "symlink", "junction", "copy"]),
  fingerprint: z.string(),
  contentFingerprint: z.string().optional(),
  sourceFingerprint: z.string().optional(),
  backup: z.string().nullable(),
  generated: z.boolean(),
  appliedAt: z.string(),
});

const artifactIdSchema = z.string().regex(/^(rules|mcp|skills)\/[^/*,\s]+$/);

const targetOwnerFields = {
  agent: z.string(),
  capability: z.enum(["rules", "mcp", "skills"]),
  target: z.string(),
  artifactIds: z
    .array(artifactIdSchema)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, "artifactIds must be an ordered set"),
  receipt: appliedReceiptSchema,
  secretRefs: z
    .array(
      z
        .string()
        .min(1)
        .refine((name) => name.trim() === name && !/[{}\r\n]/.test(name)),
    )
    .optional(),
};

const targetOwnerSchema = z.discriminatedUnion("scope", [
  z.strictObject({
    ...targetOwnerFields,
    scope: z.literal("global"),
    projectRoot: z.never().optional(),
  }),
  z.strictObject({
    ...targetOwnerFields,
    scope: z.literal("project"),
    projectRoot: z.string().refine(isAbsolute, "projectRoot must be absolute"),
  }),
]);

const ledgerSchema = z.strictObject({
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

export class PreReleaseProjectOwnerError extends Error {
  constructor(path: string) {
    super(
      `project owner at ${path} is missing a canonical projectRoot; back up and move state.json aside, then re-apply project targets with the current pre-release build`,
    );
    this.name = "PreReleaseProjectOwnerError";
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
  if (filter.dir) {
    if (entry.scope === "project") {
      if (normalize(entry.projectRoot ?? "") !== normalize(filter.dir)) return false;
    } else if (!isPathInside(entry.target, filter.dir)) {
      return false;
    }
  }
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
    if (hasProjectOwnerWithoutCanonicalRoot(json)) {
      throw new PreReleaseProjectOwnerError(path);
    }
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
    if (
      err instanceof LegacyLedgerVersionError ||
      err instanceof PreReleaseProjectOwnerError ||
      err instanceof DuplicateTargetOwnerError
    ) {
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
  await env.fs.publishFileAtomically(
    path,
    serializeLedger(ledger, observableOptionsForEnv(env).knownValues),
    { mode: 0o600 },
  );
}

export function serializeLedger(ledger: Ledger, knownValues: readonly SecretValue[] = []): string {
  assertNoSecretValues(ledger, "state");
  const validated = makeLedger(ledgerSchema.parse(ledger).owners);
  return serializeExactLedgerState(validated, knownValues);
}

// Narrow recovery writer for a duplicate-bearing ledger. It only removes owners that the revert
// engine reports as successfully reverted, and never normalizes or rewrites the duplicate records.
export async function saveLedgerAfterSelectiveRevert(
  env: Env,
  storeRoot: string,
  original: Ledger,
  successfullyReverted: readonly TargetOwner[],
): Promise<Ledger> {
  const prepared = await prepareLedgerAfterSelectiveRevert(
    env,
    storeRoot,
    original,
    successfullyReverted,
  );
  await env.fs.publishFileAtomically(join(storeRoot, "state.json"), prepared.serialized, {
    mode: 0o600,
  });
  return prepared.ledger;
}

export interface PreparedSelectiveRevertLedger {
  ledger: Ledger;
  serialized: string;
}

export async function prepareLedgerAfterSelectiveRevert(
  env: Env,
  storeRoot: string,
  original: Ledger,
  successfullyReverted: readonly TargetOwner[],
): Promise<PreparedSelectiveRevertLedger> {
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

  const ledger = { version: 2 as const, owners: validated.owners };
  return {
    ledger,
    serialized: serializeExactLedgerState(ledger, observableOptionsForEnv(env).knownValues ?? []),
  };
}

// `secretRefs` is validated durable protocol metadata containing reference names, not a generic
// observable exemption. Validate the complete exact-key ledger first, run ordinary state
// redaction over a shape with only that one field removed, and then preserve the validated names
// only in this dedicated serializer. Any ordinary `{ secretRefs: ... }` still follows the shared
// sensitive-field policy.
function serializeExactLedgerState(ledger: Ledger, knownValues: readonly SecretValue[]): string {
  assertNoSecretValues(ledger, "state");
  const exact = ledgerSchema.parse(ledger) as Ledger;
  const withoutSecretRefs: Ledger = {
    version: exact.version,
    owners: exact.owners.map((owner) => {
      const { secretRefs: _secretRefs, ...rest } = owner;
      return rest;
    }),
  };
  const ordinarySerialized = serializeObservable("state", withoutSecretRefs, {
    knownValues,
    pretty: true,
  });
  const ordinaryPublished = ledgerSchema.parse(JSON.parse(ordinarySerialized)) as Ledger;
  if (!sameLedger(ordinaryPublished, withoutSecretRefs)) {
    throw new TypeError("active secret value is not allowed in durable ownership state");
  }
  for (const owner of exact.owners) {
    for (const referenceName of owner.secretRefs ?? []) {
      if (
        containsObservableKnownValue(referenceName, knownValues) ||
        scanTextForSecrets(referenceName).length > 0
      ) {
        throw new TypeError("active secret value is not allowed in durable ownership state");
      }
    }
  }
  const serialized = JSON.stringify(exact, null, 2);
  const published = ledgerSchema.parse(JSON.parse(serialized)) as Ledger;
  if (!sameLedger(published, exact)) {
    throw new TypeError("invalid durable ownership state serialization");
  }
  return `${serialized}\n`;
}

function normalizeOwner(owner: TargetOwner): TargetOwner {
  return {
    ...owner,
    target: normalize(owner.target),
    ...(owner.scope === "project" && owner.projectRoot
      ? { projectRoot: normalize(owner.projectRoot) }
      : {}),
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

function hasProjectOwnerWithoutCanonicalRoot(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const owners = (value as { owners?: unknown }).owners;
  if (!Array.isArray(owners)) return false;
  return owners.some(
    (owner) =>
      typeof owner === "object" &&
      owner !== null &&
      (owner as { scope?: unknown }).scope === "project" &&
      (typeof (owner as { projectRoot?: unknown }).projectRoot !== "string" ||
        !isAbsolute((owner as { projectRoot: string }).projectRoot)),
  );
}
