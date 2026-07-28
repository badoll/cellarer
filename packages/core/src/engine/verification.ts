import type { Env } from "../env.js";
import type {
  AppliedMethod,
  Capability,
  DesiredPlacementMethod,
  LinkMethod,
  PlanAction,
  Scope,
  TargetOwner,
} from "../model/index.js";
import {
  type MutationRecoveryPresentation,
  mutationRecoveryPresentation,
} from "../protocol/presentation.js";
import { diagnoseMutationRecovery } from "../protocol/recovery.js";
import { readStoreRevision } from "../protocol/store-revision.js";
import { loadLedger, matchesFilter, targetKey } from "../store/ledger.js";
import { plan } from "./plan.js";
import { status } from "./status.js";
import type { StatusItem } from "./types.js";

export interface VerificationOptions {
  readonly storeRoot: string;
  readonly scope: Scope;
  readonly dir?: string;
  readonly agents: string[];
  readonly collections?: string[];
  readonly capabilities?: Capability[];
  readonly method?: LinkMethod;
  readonly mcpStrategy?: "merge" | "overwrite";
}

export type DesiredAppliedStatus =
  | "in-sync"
  | "missing-applied"
  | "selection-mismatch"
  | "content-mismatch"
  | "method-mismatch"
  | "unverifiable"
  | "unexpected-applied";

export type EvidenceComparison = "matched" | "mismatched" | "unverifiable" | "not-applicable";

export interface DesiredAppliedComparisons {
  readonly selection: EvidenceComparison;
  readonly content: EvidenceComparison;
  readonly method: EvidenceComparison;
}

export interface DesiredAppliedItem {
  readonly agent: string;
  readonly scope: Scope;
  readonly capability: Capability;
  readonly target: string;
  readonly status: DesiredAppliedStatus;
  readonly desiredArtifactIds: readonly string[];
  readonly appliedArtifactIds: readonly string[];
  readonly desiredMethod?: DesiredPlacementMethod;
  readonly appliedMethod?: DesiredPlacementMethod;
  readonly comparisons: DesiredAppliedComparisons;
}

export interface DesiredAppliedVerification {
  readonly status: "converged" | "diverged";
  readonly items: readonly DesiredAppliedItem[];
}

export interface AppliedDiskVerification {
  readonly status: "converged" | "diverged";
  readonly items: readonly StatusItem[];
}

export interface VerificationReport {
  readonly storeRevision: number;
  readonly desiredVsApplied: DesiredAppliedVerification;
  readonly appliedVsDisk: AppliedDiskVerification;
  readonly recovery: MutationRecoveryPresentation;
  readonly healthy: boolean;
}

export async function verify(env: Env, opts: VerificationOptions): Promise<VerificationReport> {
  const capabilities = opts.capabilities ?? ["rules"];
  const [desiredPlan, ledger, diskItems, diagnosis, storeRevision] = await Promise.all([
    plan(env, {
      storeRoot: opts.storeRoot,
      scope: opts.scope,
      dir: opts.dir,
      agents: opts.agents,
      collections: opts.collections,
      capabilities,
      method: opts.method,
      mcpStrategy: opts.mcpStrategy,
      secretMode: "env",
      dryRun: true,
    }),
    loadLedger(env, opts.storeRoot),
    status(env, {
      storeRoot: opts.storeRoot,
      scope: opts.scope,
      dir: opts.dir,
      agents: opts.agents,
    }),
    diagnoseMutationRecovery(env, opts.storeRoot),
    readStoreRevision(env, opts.storeRoot),
  ]);

  const applied = ledger.owners.filter(
    (owner) =>
      matchesFilter(owner, {
        scope: opts.scope,
        dir: opts.dir,
        agents: opts.agents,
      }) && capabilities.includes(owner.capability),
  );
  const desired = desiredPlan.actions.filter(
    (action) =>
      action.target.length > 0 && (action.op !== "skip" || action.ownership !== undefined),
  );
  const appliedByKey = new Map(applied.map((owner) => [targetKey(owner), owner] as const));
  const desiredKeys = new Set<string>();
  const desiredItems: DesiredAppliedItem[] = [];

  for (const action of desired) {
    const key = targetKey(action);
    if (desiredKeys.has(key)) continue;
    desiredKeys.add(key);
    const owner = appliedByKey.get(key);
    const desiredArtifactIds = sorted(action.artifactIds ?? []);
    const appliedArtifactIds = sorted(owner?.artifactIds ?? []);
    const desiredMethod = action.desiredEvidence?.method;
    const appliedMethod = owner ? normalizeAppliedMethod(owner.receipt.method) : undefined;
    const comparisons = compareDesiredEvidence(
      action,
      owner,
      desiredArtifactIds,
      appliedArtifactIds,
      desiredMethod,
      appliedMethod,
    );
    const itemStatus = desiredAppliedStatus(owner, comparisons);
    desiredItems.push({
      agent: action.agent,
      scope: action.scope,
      capability: action.capability,
      target: action.target,
      status: itemStatus,
      desiredArtifactIds,
      appliedArtifactIds,
      ...(desiredMethod ? { desiredMethod } : {}),
      ...(appliedMethod ? { appliedMethod } : {}),
      comparisons,
    });
  }

  for (const owner of applied) {
    if (desiredKeys.has(targetKey(owner))) continue;
    desiredItems.push({
      agent: owner.agent,
      scope: owner.scope,
      capability: owner.capability,
      target: owner.target,
      status: "unexpected-applied",
      desiredArtifactIds: [],
      appliedArtifactIds: sorted(owner.artifactIds),
      appliedMethod: normalizeAppliedMethod(owner.receipt.method),
      comparisons: {
        selection: "mismatched",
        content: "not-applicable",
        method: "not-applicable",
      },
    });
  }

  desiredItems.sort(compareVerificationItems);
  const desiredVsApplied: DesiredAppliedVerification = {
    status: desiredItems.every((item) => item.status === "in-sync") ? "converged" : "diverged",
    items: desiredItems,
  };
  const scopedDiskItems = diskItems
    .filter((item) => capabilities.includes(item.capability))
    .sort((left, right) => left.target.localeCompare(right.target));
  const appliedVsDisk: AppliedDiskVerification = {
    status: scopedDiskItems.every((item) => item.status === "ok") ? "converged" : "diverged",
    items: scopedDiskItems,
  };
  const recovery = mutationRecoveryPresentation(diagnosis);

  return {
    storeRevision,
    desiredVsApplied,
    appliedVsDisk,
    recovery,
    healthy:
      desiredVsApplied.status === "converged" &&
      appliedVsDisk.status === "converged" &&
      recovery.status === "clean",
  };
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareVerificationItems(left: DesiredAppliedItem, right: DesiredAppliedItem): number {
  return targetKey(left).localeCompare(targetKey(right));
}

function compareDesiredEvidence(
  action: PlanAction,
  owner: TargetOwner | undefined,
  desiredArtifactIds: readonly string[],
  appliedArtifactIds: readonly string[],
  desiredMethod: DesiredPlacementMethod | undefined,
  appliedMethod: DesiredPlacementMethod | undefined,
): DesiredAppliedComparisons {
  const selection = sameStrings(desiredArtifactIds, appliedArtifactIds) ? "matched" : "mismatched";
  if (!owner) {
    return { selection, content: "unverifiable", method: "unverifiable" };
  }

  const content = compareContentEvidence(action, owner);
  const method =
    desiredMethod === undefined || appliedMethod === undefined
      ? "unverifiable"
      : desiredMethod === appliedMethod
        ? "matched"
        : "mismatched";
  return { selection, content, method };
}

function compareContentEvidence(action: PlanAction, owner: TargetOwner): EvidenceComparison {
  const desired = action.desiredEvidence;
  if (!desired) return "unverifiable";
  if (desired.contentFingerprint !== undefined) {
    if (owner.receipt.contentFingerprint === undefined) return "unverifiable";
    return desired.contentFingerprint === owner.receipt.contentFingerprint
      ? "matched"
      : "mismatched";
  }
  if (desired.sourceFingerprint !== undefined) {
    if (owner.receipt.sourceFingerprint === undefined) return "unverifiable";
    return desired.sourceFingerprint === owner.receipt.sourceFingerprint ? "matched" : "mismatched";
  }
  return "unverifiable";
}

function desiredAppliedStatus(
  owner: TargetOwner | undefined,
  comparisons: DesiredAppliedComparisons,
): DesiredAppliedStatus {
  if (!owner) return "missing-applied";
  if (comparisons.selection === "mismatched") return "selection-mismatch";
  if (comparisons.content === "mismatched") return "content-mismatch";
  if (comparisons.method === "mismatched") return "method-mismatch";
  if (
    comparisons.selection === "unverifiable" ||
    comparisons.content === "unverifiable" ||
    comparisons.method === "unverifiable"
  ) {
    return "unverifiable";
  }
  return "in-sync";
}

function normalizeAppliedMethod(method: AppliedMethod): DesiredPlacementMethod {
  return method === "junction" ? "symlink" : method;
}
