import { isAbsolute, join, normalize } from "node:path";
import { applyMutationPlan, planApplyMutation } from "../engine/apply.js";
import { plan as planDistribution } from "../engine/plan.js";
import type {
  ApplyMutationResult,
  DistributeOptions,
  PlannedApplyMutation,
} from "../engine/types.js";
import {
  type AppliedSyncTargetUninstall,
  applySyncTargetUninstallPlanWithinAuthorityScope,
  type PlannedSyncTargetUninstall,
  planSyncTargetUninstallWithinAuthorityScope,
} from "../engine/uninstall.js";
import { type VerificationReport, verify } from "../engine/verification.js";
import type { Env } from "../env.js";
import type { DistributePlan, SyncProfileTargetEvidence } from "../model/index.js";
import {
  assertCurrentMutationAuthorityScope,
  type CurrentMutationAuthorityScope,
  canonicalJson,
  withCurrentMutationAuthorityScope,
} from "../protocol/canonical.js";
import type { MutationPlan } from "../protocol/models.js";
import { targetKey } from "../store/ledger.js";
import {
  type ResolvedSyncProfileResource,
  resolveCanonicalSyncProfile,
  type SyncProfile,
  SyncProfileError,
  type SyncProfileStoreOptions,
} from "./profiles.js";

export interface SyncProfileInvocationOptions extends SyncProfileStoreOptions {
  readonly profileId: string;
  readonly workspaceRoot?: string;
  readonly replaceUnowned?: readonly string[];
  readonly overrideDrift?: readonly string[];
  readonly snapshotPassphrase?: string;
  readonly secretMode?: "env" | "vault" | "keychain";
  readonly vaultPassphrase?: string;
  readonly keychainService?: string;
}

export interface PlannedSyncProfile extends PlannedApplyMutation {
  readonly profile: SyncProfile;
  readonly workspaceRoot: string | null;
  readonly resolvedAgents: readonly string[];
  readonly resolvedResources: readonly ResolvedSyncProfileResource[];
}

export interface AppliedSyncProfile extends ApplyMutationResult {
  readonly profileId: string;
}

export interface SyncProfileVerification extends VerificationReport {
  readonly profileId: string;
  readonly profileRevision: string;
  readonly resolvedResources: readonly ResolvedSyncProfileResource[];
}

export interface PlannedSyncProfileUninstall extends PlannedSyncTargetUninstall {
  readonly profile: SyncProfile;
  readonly targetKeys: readonly string[];
}

export interface ApplySyncProfileUninstallOptions extends SyncProfileInvocationOptions {
  readonly targetKeys: readonly string[];
  readonly acknowledgements?: readonly string[];
}

export async function planSyncProfile(
  env: Env,
  opts: SyncProfileInvocationOptions,
): Promise<PlannedSyncProfile> {
  return withCurrentMutationAuthorityScope(env, async (authorityScope) => {
    const authorityLease = await assertCurrentMutationAuthorityScope(env, authorityScope);
    const resolved = await resolveProfileInvocation(env, opts, authorityScope);
    const planned = await planApplyMutation(
      env,
      resolved.distributeOptions,
      {},
      {
        syncProfileId: resolved.profile.profileId,
        authorityLease,
      },
    );
    return {
      ...planned,
      profile: resolved.profile,
      workspaceRoot: resolved.workspaceRoot,
      resolvedAgents: resolved.profile.desired.agentIds,
      resolvedResources: resolved.resources,
    };
  });
}

export async function applySyncProfilePlan(
  env: Env,
  mutationPlan: MutationPlan,
  opts: SyncProfileInvocationOptions,
): Promise<AppliedSyncProfile> {
  return withCurrentMutationAuthorityScope(env, async (authorityScope) => {
    const authorityLease = await assertCurrentMutationAuthorityScope(env, authorityScope);
    const resolved = await resolveProfileInvocation(env, opts, authorityScope);
    const applied = await applyMutationPlan(
      env,
      mutationPlan,
      {
        storeRoot: resolved.distributeOptions.storeRoot,
        syncProfileId: resolved.profile.profileId,
        options: resolved.distributeOptions,
        snapshotPassphrase: opts.snapshotPassphrase,
        secretMode: opts.secretMode,
        vaultPassphrase: opts.vaultPassphrase,
        keychainService: opts.keychainService,
      },
      { authorityLease },
    );
    return { ...applied, profileId: resolved.profile.profileId };
  });
}

export async function verifySyncProfile(
  env: Env,
  opts: SyncProfileInvocationOptions,
): Promise<SyncProfileVerification> {
  const resolved = await resolveProfileInvocation(env, opts);
  const report = await verify(env, {
    storeRoot: resolved.distributeOptions.storeRoot,
    scope: resolved.profile.desired.scope,
    ...(resolved.workspaceRoot ? { dir: resolved.workspaceRoot } : {}),
    agents: [...resolved.profile.desired.agentIds],
    resourceIds: resolved.resources.map((resource) => resource.resourceId),
    capabilities: [...resolved.profile.desired.capabilities],
    method: resolved.profile.desired.method,
    mcpStrategy: resolved.profile.desired.mergePolicy,
    syncProfile: resolved.syncProfile,
  });
  return {
    ...report,
    profileId: resolved.profile.profileId,
    profileRevision: resolved.profile.revision,
    resolvedResources: resolved.resources,
  };
}

export async function planSyncProfileUninstall(
  env: Env,
  opts: SyncProfileInvocationOptions & { readonly acknowledgements?: readonly string[] },
): Promise<PlannedSyncProfileUninstall> {
  return withCurrentMutationAuthorityScope(env, async (authorityScope) => {
    const resolved = await resolveProfileInvocation(env, opts, authorityScope);
    const desiredPlan = await profileDistributionPlan(env, resolved.distributeOptions);
    const targetKeys = exactTargetKeys(desiredPlan);
    const planned = await planSyncTargetUninstallWithinAuthorityScope(
      env,
      {
        storeRoot: resolved.distributeOptions.storeRoot,
        targetKeys,
        acknowledgements: opts.acknowledgements,
        syncProfile: resolved.syncProfile,
      },
      authorityScope,
    );
    return { ...planned, profile: resolved.profile, targetKeys };
  });
}

export async function applySyncProfileUninstallPlan(
  env: Env,
  mutationPlan: MutationPlan,
  opts: ApplySyncProfileUninstallOptions,
): Promise<AppliedSyncTargetUninstall> {
  return withCurrentMutationAuthorityScope(env, async (authorityScope) => {
    const resolved = await resolveProfileInvocation(env, opts, authorityScope);
    const desiredPlan = await profileDistributionPlan(env, resolved.distributeOptions);
    const expectedTargetKeys = exactTargetKeys(desiredPlan);
    if (
      expectedTargetKeys.length !== opts.targetKeys.length ||
      expectedTargetKeys.some((key, index) => key !== opts.targetKeys[index])
    ) {
      throw new SyncProfileError(
        "INVALID_UNINSTALL_SELECTION",
        "uninstall target keys do not match the current exact profile resolution",
      );
    }
    return applySyncTargetUninstallPlanWithinAuthorityScope(
      env,
      mutationPlan,
      {
        storeRoot: resolved.distributeOptions.storeRoot,
        options: {
          storeRoot: resolved.distributeOptions.storeRoot,
          targetKeys: expectedTargetKeys,
          acknowledgements: opts.acknowledgements,
          syncProfile: resolved.syncProfile,
        },
      },
      authorityScope,
      async () => {
        const locked = await resolveProfileInvocation(env, opts, authorityScope);
        const lockedDesiredPlan = await profileDistributionPlan(env, locked.distributeOptions);
        return (
          canonicalJson(locked.syncProfile) === canonicalJson(resolved.syncProfile) &&
          canonicalJson(exactTargetKeys(lockedDesiredPlan)) === canonicalJson(expectedTargetKeys)
        );
      },
    );
  });
}

async function resolveProfileInvocation(
  env: Env,
  opts: SyncProfileInvocationOptions,
  authorityScope?: CurrentMutationAuthorityScope,
): Promise<{
  readonly profile: SyncProfile;
  readonly workspaceRoot: string | null;
  readonly resources: readonly ResolvedSyncProfileResource[];
  readonly syncProfile: SyncProfileTargetEvidence;
  readonly distributeOptions: DistributeOptions;
}> {
  if (authorityScope) await assertCurrentMutationAuthorityScope(env, authorityScope);
  const storeRoot = normalizeAbsolute(opts.storeRoot, "storeRoot");
  const canonical = await resolveCanonicalSyncProfile(env, {
    storeRoot,
    profileId: opts.profileId,
  });
  const { profile, resources, evidence: syncProfile } = canonical;
  const workspaceRoot = resolveWorkspaceRoot(env, profile, opts.workspaceRoot);
  const distributeOptions: DistributeOptions = {
    storeRoot,
    scope: profile.desired.scope,
    ...(workspaceRoot ? { dir: workspaceRoot } : {}),
    agents: [...profile.desired.agentIds],
    resourceIds: resources.map((resource) => resource.resourceId),
    capabilities: [...profile.desired.capabilities],
    method: profile.desired.method,
    mcpStrategy: profile.desired.mergePolicy,
    ...(opts.replaceUnowned ? { replaceUnowned: [...opts.replaceUnowned] } : {}),
    ...(opts.overrideDrift ? { overrideDrift: [...opts.overrideDrift] } : {}),
    ...(opts.snapshotPassphrase ? { snapshotPassphrase: opts.snapshotPassphrase } : {}),
    ...(opts.secretMode ? { secretMode: opts.secretMode } : {}),
    ...(opts.vaultPassphrase ? { vaultPassphrase: opts.vaultPassphrase } : {}),
    ...(opts.keychainService ? { keychainService: opts.keychainService } : {}),
  };
  return { profile, workspaceRoot, resources, syncProfile, distributeOptions };
}

function resolveWorkspaceRoot(
  env: Env,
  profile: SyncProfile,
  supplied: string | undefined,
): string | null {
  if (profile.desired.scope === "global") return null;
  if (typeof supplied !== "string" || supplied.trim().length === 0) {
    throw new SyncProfileError(
      "WORKSPACE_ROOT_REQUIRED",
      "project-scoped profile requires an explicit workspace root",
    );
  }
  return normalize(isAbsolute(supplied) ? supplied : join(env.cwd(), supplied));
}

async function profileDistributionPlan(
  env: Env,
  options: DistributeOptions,
): Promise<DistributePlan> {
  return planDistribution(env, options, { providerAccess: "forbidden" });
}

function exactTargetKeys(plan: DistributePlan): string[] {
  return [
    ...new Set(plan.actions.filter((action) => action.target.length > 0).map(targetKey)),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeAbsolute(value: string, field: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new SyncProfileError("INVALID_INPUT", `${field} must be absolute`);
  }
  return normalize(value);
}
