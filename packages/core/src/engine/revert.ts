// Revert is plan-first: inspect every selected physical target, expose exact preconditions, then
// mutate eligible targets once. Ownership is removed only after that target was restored/removed.
import { dirname, join, normalize, relative, sep } from "node:path";
import { appendActivity } from "../activity.js";
import type { Env } from "../env.js";
import { lstatOrNull } from "../fs/probe.js";
import { isPathInside } from "../fs/safety.js";
import type {
  AppliedReceipt,
  Ledger,
  LedgerEntry,
  TargetAcknowledgement,
  TargetConflict,
  TargetOwnershipEvidence,
} from "../model/index.js";
import { sha256 } from "../store/checksum.js";
import {
  duplicateTargetOwnerKeys,
  entryKey,
  loadLedgerForPlanning,
  makeLedger,
  matchesFilter,
  saveLedger,
  saveLedgerAfterSelectiveRevert,
} from "../store/ledger.js";
import { fingerprintTarget, inspectTargetOwnership } from "../target-ownership.js";
import { decryptTargetSnapshot, restoreTargetSnapshot } from "../target-snapshot.js";
import { syncGitignore } from "./gitignore-sync.js";
import type {
  RevertFailure,
  RevertOptions,
  RevertPlan,
  RevertPlanTarget,
  RevertProposedAction,
  RevertResult,
  RevertSnapshotAvailability,
} from "./types.js";

interface BuiltRevertPlan {
  ledger: Ledger;
  plan: RevertPlan;
  duplicateOwnerKeys: string[];
}

class SnapshotPassphraseRequiredError extends Error {
  constructor(target: string) {
    super(`encrypted snapshot restoration for "${target}" requires a snapshot passphrase`);
    this.name = "SnapshotPassphraseRequiredError";
  }
}

export async function planRevert(env: Env, opts: RevertOptions): Promise<RevertPlan> {
  return (await buildRevertPlan(env, opts)).plan;
}

export async function revert(env: Env, opts: RevertOptions): Promise<RevertResult> {
  const { ledger, plan, duplicateOwnerKeys } = await buildRevertPlan(env, opts);
  const warnings = [...plan.warnings];
  const eligible = plan.targets.filter((target) => !target.blocked);

  // Preserve the historical preview field while the complete, structured preview lives in plan.
  if (opts.dryRun) {
    return {
      plan,
      reverted: eligible.flatMap((target) => target.owners),
      failures: [],
      warnings,
    };
  }

  const reverted: LedgerEntry[] = [];
  const failures: RevertFailure[] = [];
  const backupsToRemove = new Set<string>();
  const successfulKeys = new Set<string>();

  for (const target of eligible) {
    try {
      const backup = await revertOne(env, target, opts.snapshotPassphrase);
      for (const owner of target.owners) {
        const key = entryKey(owner);
        if (successfulKeys.has(key)) continue;
        successfulKeys.add(key);
        reverted.push(owner);
      }
      if (backup) backupsToRemove.add(backup);
    } catch (error) {
      failures.push({
        code:
          error instanceof SnapshotPassphraseRequiredError
            ? "SNAPSHOT_PASSPHRASE_REQUIRED"
            : "REVERT_FAILED",
        target: target.target,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let remaining = ledger;
  if (reverted.length > 0) {
    if (duplicateOwnerKeys.length > 0) {
      remaining = await saveLedgerAfterSelectiveRevert(env, opts.storeRoot, ledger, reverted);
    } else {
      remaining = makeLedger(ledger.owners.filter((owner) => !successfulKeys.has(entryKey(owner))));
      // The save happens after every target in `reverted` succeeded. If save fails, backups remain.
      await saveLedger(env, opts.storeRoot, remaining);
    }

    if (!opts.keepBackups) {
      for (const backup of backupsToRemove) {
        try {
          await env.fs.rm(backup, { recursive: true, force: true });
        } catch (error) {
          warnings.push(
            `revert succeeded but recovery snapshot cleanup failed for "${backup}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    await resyncAffectedGitignores(env, reverted, remaining, opts.dir);
  }

  // Preserve the existing activity contract for an explicit non-dry revert, including safe no-ops.
  await recordRevertActivity(env, opts, reverted, warnings);

  return { plan, reverted, failures, warnings };
}

async function buildRevertPlan(env: Env, opts: RevertOptions): Promise<BuiltRevertPlan> {
  const ledger = await loadLedgerForPlanning(env, opts.storeRoot);
  const duplicateOwnerKeys = duplicateTargetOwnerKeys(ledger.owners);
  const selected = ledger.owners.filter(
    (owner) =>
      matchesFilter(owner, opts) &&
      (!opts.artifactIds ||
        opts.artifactIds.length === 0 ||
        owner.artifactIds.some((id) => opts.artifactIds?.includes(id))),
  );
  const allByPhysicalTarget = groupByPhysicalTarget(ledger.owners);
  const selectedByPhysicalTarget = groupByPhysicalTarget(selected);
  const roots = allowedRevertRoots(env, opts);
  const warnings: string[] = [];
  const conflicts: TargetConflict[] = [];
  const targets: RevertPlanTarget[] = [];

  for (const [target, owners] of selectedByPhysicalTarget) {
    const primary = owners[0];
    if (!primary) continue;
    const allOwners = allByPhysicalTarget.get(target) ?? owners;
    let invalidReason: string | undefined;
    if (allOwners.length !== owners.length) {
      invalidReason = "the physical target also has an owner outside the revert selection";
    } else if (!owners.every((owner) => sameReceipt(primary.receipt, owner.receipt))) {
      invalidReason = "the physical target has owners with conflicting applied receipts";
    }

    let ownership: TargetOwnershipEvidence;
    if (target === "" || !roots.some((root) => isPathInside(target, root))) {
      invalidReason =
        invalidReason ??
        `target is outside managed roots [${roots.join(", ")}]. Pass --dir to include a project outside your home directory.`;
      ownership = ownershipEvidence(primary, "invalid-owner", null);
      warnings.push(
        `refusing to revert "${primary.agent}" target "${target}" — outside managed roots [${roots.join(", ")}]. Pass --dir to include a project outside your home directory.`,
      );
    } else if (invalidReason) {
      ownership = ownershipEvidence(primary, "invalid-owner", null);
    } else {
      const inspected = await inspectTargetOwnership(env, {
        agent: primary.agent,
        scope: primary.scope,
        capability: primary.capability,
        target,
        dir: opts.dir,
        owners: ledger.owners,
      });
      ownership = {
        key: entryKey(primary),
        classification: inspected.classification,
        target: inspected.target,
        currentFingerprint: inspected.fingerprint,
        expectedReceipt: primary.receipt,
      };
      invalidReason = inspected.reason;
    }

    const snapshot = await snapshotAvailability(env, opts.storeRoot, primary.receipt.backup);
    const proposedAction: RevertProposedAction =
      snapshot.status === "none" ? "remove-target" : "restore-snapshot";
    const acknowledgement =
      ownership.classification === "owned-drifted"
        ? revertAcknowledgement(owners, ownership, proposedAction)
        : undefined;
    const driftOverridden =
      acknowledgement !== undefined &&
      opts.acknowledgements?.includes(acknowledgement.token) === true;

    let blocked = false;
    let blockReason: string | undefined;
    if (ownership.classification === "owned-drifted" && !driftOverridden) {
      blocked = true;
      blockReason = "owned target has drifted; exact revert acknowledgement required";
    } else if (
      ownership.classification === "invalid-owner" ||
      ownership.classification === "unowned-existing"
    ) {
      blocked = true;
      blockReason = invalidReason ?? "target ownership is invalid";
    } else if (snapshot.status === "missing" || snapshot.status === "invalid") {
      blocked = true;
      blockReason =
        snapshot.status === "missing"
          ? "recorded recovery snapshot is missing"
          : "recorded recovery snapshot is outside the snapshot store or has an invalid type";
    }

    const item: RevertPlanTarget = {
      target,
      owners,
      expectedReceipt: primary.receipt,
      ownership,
      snapshot,
      proposedAction,
      blocked,
      ...(blockReason ? { blockReason } : {}),
      ...(acknowledgement ? { acknowledgement } : {}),
      driftOverridden,
    };
    targets.push(item);

    if (blocked && ownership.classification === "owned-drifted") {
      conflicts.push({
        code: "REVERT_TARGET_DRIFTED",
        target,
        message: blockReason ?? "owned target has drifted",
        ownership,
        acknowledgement,
      });
    } else if (blocked && ownership.classification === "invalid-owner") {
      conflicts.push({
        code: "INVALID_TARGET_OWNER",
        target,
        message: blockReason ?? "target ownership is invalid",
        ownership,
      });
    } else if (blocked) {
      conflicts.push({
        code: "REVERT_SNAPSHOT_UNAVAILABLE",
        target,
        message: blockReason ?? "recovery snapshot is unavailable",
        ownership,
      });
    }
  }

  return { ledger, plan: { targets, conflicts, warnings }, duplicateOwnerKeys };
}

function groupByPhysicalTarget(owners: readonly LedgerEntry[]): Map<string, LedgerEntry[]> {
  const groups = new Map<string, LedgerEntry[]>();
  for (const owner of owners) {
    const target = normalize(owner.target);
    const group = groups.get(target) ?? [];
    group.push(owner);
    groups.set(target, group);
  }
  return groups;
}

function sameReceipt(left: AppliedReceipt, right: AppliedReceipt): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ownershipEvidence(
  owner: LedgerEntry,
  classification: TargetOwnershipEvidence["classification"],
  currentFingerprint: string | null,
): TargetOwnershipEvidence {
  return {
    key: entryKey(owner),
    classification,
    target: normalize(owner.target),
    currentFingerprint,
    expectedReceipt: owner.receipt,
  };
}

async function snapshotAvailability(
  env: Env,
  storeRoot: string,
  path: string | null,
): Promise<RevertSnapshotAvailability> {
  if (!path) return { path: null, status: "none", encrypted: false };
  const encrypted = path.endsWith(".age");
  const snapshotsRoot = join(storeRoot, "snapshots");
  if (!encrypted || !isPathInside(path, snapshotsRoot)) {
    return { path, status: "invalid", encrypted };
  }
  const rootStat = await lstatOrNull(env, snapshotsRoot);
  if (!rootStat) return { path, status: "missing", encrypted };
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { path, status: "invalid", encrypted };
  }
  const relParent = relative(snapshotsRoot, dirname(path));
  let ancestor = snapshotsRoot;
  for (const segment of relParent.length === 0 ? [] : relParent.split(sep)) {
    ancestor = join(ancestor, segment);
    const ancestorStat = await lstatOrNull(env, ancestor);
    if (!ancestorStat) return { path, status: "missing", encrypted };
    if (ancestorStat.isSymbolicLink() || !ancestorStat.isDirectory()) {
      return { path, status: "invalid", encrypted };
    }
  }
  const stat = await lstatOrNull(env, path);
  if (!stat) return { path, status: "missing", encrypted };
  if (!stat.isFile() || stat.isSymbolicLink()) return { path, status: "invalid", encrypted };
  return { path, status: "available", encrypted };
}

function revertAcknowledgement(
  owners: LedgerEntry[],
  ownership: TargetOwnershipEvidence,
  proposedAction: RevertProposedAction,
): TargetAcknowledgement {
  const kind = "revert-drift" as const;
  return {
    kind,
    token: sha256(
      JSON.stringify({
        version: 1,
        kind,
        ownerKeys: owners.map(entryKey).sort(),
        classification: ownership.classification,
        currentFingerprint: ownership.currentFingerprint,
        expectedReceipt: ownership.expectedReceipt,
        proposedAction,
      }),
    ),
  };
}

async function revertOne(
  env: Env,
  target: RevertPlanTarget,
  snapshotPassphrase: string | undefined,
): Promise<string | null> {
  // Re-check the exact disk receipt consumed by the plan before the first destructive effect.
  const currentFingerprint = await fingerprintTarget(env, target.target);
  if (currentFingerprint !== target.ownership.currentFingerprint) {
    throw new Error(`target "${target.target}" changed after revert planning`);
  }

  if (target.snapshot.status === "none") {
    await env.fs.rm(target.target, { recursive: true, force: true });
    return null;
  }
  if (target.snapshot.status !== "available" || !target.snapshot.path) {
    throw new Error(`recorded recovery snapshot for "${target.target}" is unavailable`);
  }

  if (!snapshotPassphrase) throw new SnapshotPassphraseRequiredError(target.target);
  // The plan only permits managed .age snapshots. Decrypt and fully validate before mutation.
  const encrypted = await env.fs.readFile(target.snapshot.path);
  const snapshot = await decryptTargetSnapshot(encrypted, snapshotPassphrase);
  await restoreTargetSnapshot(env, target.target, snapshot, target.ownership.currentFingerprint);
  return target.snapshot.path;
}

function allowedRevertRoots(env: Env, opts: RevertOptions): string[] {
  const roots = [env.homedir(), env.cwd()];
  if (opts.dir) roots.push(opts.dir);
  return roots.map(normalize);
}

async function resyncAffectedGitignores(
  env: Env,
  reverted: LedgerEntry[],
  remaining: Ledger,
  optsDir: string | undefined,
): Promise<void> {
  const dirs = new Set<string>();
  if (optsDir) dirs.add(optsDir);
  for (const entry of reverted) {
    if (entry.scope === "project") dirs.add(dirname(entry.target));
  }
  for (const dir of dirs) await syncGitignore(env, dir, remaining);
}

async function recordRevertActivity(
  env: Env,
  opts: RevertOptions,
  reverted: LedgerEntry[],
  warnings: string[],
): Promise<void> {
  try {
    await appendActivity(env, opts.storeRoot, {
      action: "revert",
      scope: opts.scope,
      projectDir: opts.dir,
      agents: opts.agents ?? [...new Set(reverted.map((entry) => entry.agent))],
      capabilities: [...new Set(reverted.map((entry) => entry.capability))],
      affectedCount: reverted.length,
      warningsCount: warnings.length,
      summary: `Reverted ${reverted.length} ${reverted.length === 1 ? "target" : "targets"}`,
      references: {
        ledgerEntryKeys: reverted.map(entryKey),
        artifactIds: reverted.flatMap((entry) => entry.artifactIds),
      },
      secretRefs: reverted.flatMap((entry) => entry.secretRefs ?? []),
    });
  } catch (error) {
    warnings.push(`activity log failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
