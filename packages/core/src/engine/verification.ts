import { loadRegistryFromConfig } from "../adapters/registry.js";
import type { Env } from "../env.js";
import type {
  AppliedMethod,
  Capability,
  DesiredPlacementMethod,
  LinkMethod,
  PlanAction,
  Scope,
  SyncProfileTargetEvidence,
  TargetOwner,
} from "../model/index.js";
import { canonicalJson } from "../protocol/canonical.js";
import type {
  ConfigurationOutcome,
  VerificationCoverage,
  VerificationCoverageItem,
  VerificationCoverageOutcome,
  VerificationRuntimeEvidence,
} from "../protocol/client-types.js";
import { readOperationJournal } from "../protocol/journal.js";
import {
  readStoreMutationLockOwner,
  readStoreRecoveryLockOwner,
} from "../protocol/mutation-lock.js";
import {
  type MutationRecoveryPresentation,
  mutationRecoveryPresentation,
} from "../protocol/presentation.js";
import { readStoreRevision } from "../protocol/store-revision.js";
import { loadConfig } from "../store/config.js";
import { loadLedger, matchesFilter, targetKey } from "../store/ledger.js";
import { plan } from "./plan.js";
import { status } from "./status.js";
import type { StatusItem } from "./types.js";

export interface VerificationOptions {
  readonly storeRoot: string;
  readonly scope: Scope;
  readonly dir?: string;
  readonly agents: string[];
  readonly resourceIds?: string[];
  readonly collections?: string[];
  readonly capabilities?: Capability[];
  readonly method?: LinkMethod;
  readonly mcpStrategy?: "merge" | "overwrite";
  readonly syncProfile?: SyncProfileTargetEvidence;
}

export type DesiredAppliedStatus =
  | "in-sync"
  | "missing-applied"
  | "selection-mismatch"
  | "content-mismatch"
  | "method-mismatch"
  | "provenance-mismatch"
  | "unverifiable"
  | "unexpected-applied";

export type EvidenceComparison = "matched" | "mismatched" | "unverifiable" | "not-applicable";

export interface DesiredAppliedComparisons {
  readonly selection: EvidenceComparison;
  readonly content: EvidenceComparison;
  readonly method: EvidenceComparison;
  readonly provenance: EvidenceComparison;
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
  readonly configuration: ConfigurationOutcome;
  readonly coverage: VerificationCoverage;
  readonly runtime: VerificationRuntimeEvidence;
}

export async function verify(env: Env, opts: VerificationOptions): Promise<VerificationReport> {
  const agents = [...new Set(opts.agents)];
  const capabilities = [...new Set(opts.capabilities ?? ["rules" as const])];
  const config = await loadConfig(env, opts.storeRoot);
  const registry = await loadRegistryFromConfig(env, config);
  if (agents.some((agent) => !registry.get(agent))) {
    throw new VerificationInputError();
  }
  const planned = await Promise.all(
    agents.flatMap((agent) =>
      capabilities.map(async (capability) => {
        const observation: { outcome: VerificationCoverageOutcome } = { outcome: "failed" };
        let actions: PlanAction[] = [];
        if (config.adapterOverrides[agent]?.enabled === false) {
          observation.outcome = "disabled";
        } else if (!registry.get(agent)?.capabilities[capability]?.includes(opts.scope)) {
          observation.outcome = "unsupported";
        } else
          try {
            const result = await plan(
              env,
              {
                ...opts,
                agents: [agent],
                capabilities: [capability],
                secretMode: "env",
                dryRun: true,
              },
              {
                providerAccess: "forbidden",
                onCoverage: (value) => {
                  observation.outcome = value;
                },
              },
            );
            actions = result.actions;
            if (
              observation.outcome === "covered" &&
              (result.invalidLedger ||
                actions.some(
                  (action) =>
                    action.op === "skip" &&
                    !(
                      action.desiredEvidence && action.ownership?.classification === "owned-drifted"
                    ),
                ))
            )
              observation.outcome = "blocked";
          } catch {
            observation.outcome = "failed";
          }
        const codes: Record<VerificationCoverageOutcome, VerificationCoverageItem["code"]> = {
          covered: "EVALUATED",
          "no-op": "EMPTY_SELECTION",
          unsupported: "UNSUPPORTED_CAPABILITY",
          disabled: "AGENT_DISABLED",
          blocked: "PLANNING_BLOCKED",
          failed: "PLANNING_FAILED",
        };
        return {
          actions,
          item: {
            agent,
            scope: opts.scope,
            capability,
            outcome: observation.outcome,
            code: codes[observation.outcome],
          } satisfies VerificationCoverageItem,
        };
      }),
    ),
  );
  const desiredPlan = { actions: planned.flatMap((result) => result.actions) };
  const coverageItems: VerificationCoverageItem[] = planned.map((result) => result.item);
  const [ledger, diskResults, recovery, storeRevision] = await Promise.all([
    loadLedger(env, opts.storeRoot),
    Promise.all(
      agents.map(async (agent) => {
        try {
          return await status(env, {
            storeRoot: opts.storeRoot,
            scope: opts.scope,
            dir: opts.dir,
            agents: [agent],
          });
        } catch {
          for (let index = 0; index < coverageItems.length; index++) {
            const item = coverageItems[index];
            if (item?.agent === agent)
              coverageItems[index] = { ...item, outcome: "failed", code: "OBSERVATION_FAILED" };
          }
          return [];
        }
      }),
    ),
    observeVerificationRecovery(env, opts.storeRoot),
    readStoreRevision(env, opts.storeRoot),
  ]);
  const diskItems = diskResults.flat();
  const observed = coverageItems.filter(
    (item) => item.outcome === "covered" || item.outcome === "no-op",
  ).length;
  const coverage: VerificationCoverage = {
    expected: coverageItems.length,
    observed,
    failed: coverageItems.filter((item) => item.outcome === "failed").length,
    complete: observed === coverageItems.length,
    items: coverageItems,
  };

  const applied = ledger.owners.filter(
    (owner) =>
      agents.includes(owner.agent) &&
      matchesFilter(owner, {
        scope: opts.scope,
        dir: opts.dir,
        agents,
      }) &&
      capabilities.includes(owner.capability),
  );
  const desired = desiredPlan.actions.filter(
    (action) =>
      action.target.length > 0 && (action.op !== "skip" || action.ownership !== undefined),
  );
  const projectionKey = (owner: Pick<TargetOwner, "agent" | "scope" | "capability" | "target">) =>
    targetKey(owner);
  const appliedByKey = new Map<string, TargetOwner>();
  for (const owner of applied) {
    const key = projectionKey({
      agent: owner.agent,
      scope: owner.scope,
      capability: owner.capability,
      target: owner.target,
    });
    if (!appliedByKey.has(key) || owner.syncProfile?.profileId === opts.syncProfile?.profileId)
      appliedByKey.set(key, owner);
  }
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
      opts.syncProfile,
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
    if (
      desiredKeys.has(
        projectionKey({
          agent: owner.agent,
          scope: owner.scope,
          capability: owner.capability,
          target: owner.target,
        }),
      )
    )
      continue;
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
        provenance: "not-applicable",
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
  const converged =
    desiredVsApplied.status === "converged" &&
    appliedVsDisk.status === "converged" &&
    recovery.status === "clean";
  const configuration: ConfigurationOutcome = !coverage.complete
    ? "incomplete"
    : !converged
      ? "unhealthy"
      : desiredItems.length > 0
        ? "healthy"
        : "no-op";

  return {
    storeRevision,
    desiredVsApplied,
    appliedVsDisk,
    recovery,
    coverage,
    configuration,
    runtime: { observation: "unknown" },
    healthy: configuration === "healthy",
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
  expectedSyncProfile: SyncProfileTargetEvidence | undefined,
): DesiredAppliedComparisons {
  const selection = sameStrings(desiredArtifactIds, appliedArtifactIds) ? "matched" : "mismatched";
  if (!owner) {
    return {
      selection,
      content: "unverifiable",
      method: "unverifiable",
      provenance: expectedSyncProfile ? "unverifiable" : "not-applicable",
    };
  }

  const content = compareContentEvidence(action, owner);
  const method =
    desiredMethod === undefined || appliedMethod === undefined
      ? "unverifiable"
      : desiredMethod === appliedMethod
        ? "matched"
        : "mismatched";
  const provenance = expectedSyncProfile
    ? canonicalJson(owner.syncProfile ?? null) === canonicalJson(expectedSyncProfile)
      ? "matched"
      : "mismatched"
    : "not-applicable";
  return { selection, content, method, provenance };
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
  if (comparisons.provenance === "mismatched") return "provenance-mismatch";
  if (
    comparisons.selection === "unverifiable" ||
    comparisons.content === "unverifiable" ||
    comparisons.method === "unverifiable" ||
    comparisons.provenance === "unverifiable"
  ) {
    return "unverifiable";
  }
  return "in-sync";
}

function normalizeAppliedMethod(method: AppliedMethod): DesiredPlacementMethod {
  return method === "junction" ? "symlink" : method;
}

export class VerificationInputError extends Error {
  readonly code = "INVALID_INPUT";
  constructor() {
    super("Verification contains an unregistered Agent identity");
  }
}

async function observeVerificationRecovery(
  env: Env,
  storeRoot: string,
): Promise<MutationRecoveryPresentation> {
  try {
    const [journal, lockOwner, recoveryLockOwner] = await Promise.all([
      readOperationJournal(env, storeRoot),
      readStoreMutationLockOwner(env, storeRoot),
      readStoreRecoveryLockOwner(env, storeRoot),
    ]);
    if (!journal && !lockOwner && !recoveryLockOwner) return { status: "clean" };
    return mutationRecoveryPresentation({
      status: "manual-recovery-required",
      journal,
      lockOwner,
      recoveryLockOwner,
      receipt: null,
      message: "Outstanding operation state requires authorized recovery inspection",
    });
  } catch {
    return mutationRecoveryPresentation({
      status: "manual-recovery-required",
      journal: null,
      lockOwner: null,
      recoveryLockOwner: null,
      receipt: null,
      message: "Operation state could not be observed",
    });
  }
}
