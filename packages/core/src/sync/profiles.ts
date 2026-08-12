import { isAbsolute, join, normalize } from "node:path";
import { z } from "zod";
import { loadRegistry } from "../adapters/registry.js";
import type { Env } from "../env.js";
import { readFileOrNull } from "../fs/probe.js";
import type { Capability, SyncProfileTargetEvidence } from "../model/index.js";
import {
  assertCurrentMutationAuthorityScope,
  type CurrentMutationAuthorityScope,
  canonicalJson,
  withCurrentMutationAuthorityScope,
} from "../protocol/canonical.js";
import { invalidPlanResult } from "../protocol/execute.js";
import type { CanonicalJsonObject, MutationPlan, OperationResult } from "../protocol/models.js";
import {
  applyStorePublicationPlan,
  planStorePublicationMutation,
  StoreMutationConflictError,
} from "../protocol/store-mutation.js";
import { loadResourceRecord } from "../resources/model.js";
import { scanTextForSecrets } from "../secrets/detector.js";
import { activeSecretPublicationGuard } from "../secrets/publication-guard.js";
import { sha256 } from "../store/checksum.js";
import { loadConfig } from "../store/config.js";
import { loadLedgerForPlanning, targetKey } from "../store/ledger.js";
import { listMcpArtifacts, listRuleArtifacts, listSkillArtifacts } from "../store/store.js";

export const SYNC_PROFILE_SCHEMA_VERSION = 1 as const;
const PROFILE_REGISTRY_SCHEMA_VERSION = 1 as const;
const PROFILE_MUTATION_KINDS = ["profile-create", "profile-update", "profile-delete"] as const;
const profileIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/)
  .refine((value) => !["__proto__", "prototype", "constructor"].includes(value));
const resourceIdSchema = z.string().regex(/^(rules|mcp|skills)\/[A-Za-z0-9._-]+$/);
const collectionIdSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
const unique = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .array(schema)
    .refine((values) => new Set(values).size === values.length, "values must be unique");

export const syncProfileDesiredStateSchema = z
  .object({
    agentIds: unique(profileIdSchema).min(1),
    scope: z.enum(["global", "project"]),
    resourceIds: unique(resourceIdSchema),
    collectionIds: unique(collectionIdSchema),
    capabilities: unique(z.enum(["rules", "mcp", "skills"])).min(1),
    method: z.enum(["symlink", "copy"]),
    mergePolicy: z.literal("merge"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.resourceIds.length === 0 && value.collectionIds.length === 0) {
      ctx.addIssue({ code: "custom", message: "profile must select a resource or collection" });
    }
    if (scanTextForSecrets(JSON.stringify(value)).length > 0) {
      ctx.addIssue({ code: "custom", message: "profile contains secret-like content" });
    }
    for (const text of [...value.agentIds, ...value.resourceIds, ...value.collectionIds]) {
      if (isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text)) {
        ctx.addIssue({ code: "custom", message: "profile cannot persist absolute paths" });
      }
    }
  });

export type SyncProfileDesiredState = z.infer<typeof syncProfileDesiredStateSchema>;

export const syncProfileSchema = z
  .object({
    schemaVersion: z.literal(SYNC_PROFILE_SCHEMA_VERSION),
    profileId: profileIdSchema,
    revision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    desired: syncProfileDesiredStateSchema,
  })
  .strict();

export type SyncProfile = z.infer<typeof syncProfileSchema>;

const profileRegistrySchema = z
  .object({
    schemaVersion: z.literal(PROFILE_REGISTRY_SCHEMA_VERSION),
    profiles: z.array(syncProfileSchema),
  })
  .strict();

type ProfileRegistry = z.infer<typeof profileRegistrySchema>;

const mutationInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      profileId: profileIdSchema,
      desired: syncProfileDesiredStateSchema,
      timestamp: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      profileId: profileIdSchema,
      desired: syncProfileDesiredStateSchema,
      timestamp: z.string().datetime({ offset: true }),
    })
    .strict(),
  z.object({ action: z.literal("delete"), profileId: profileIdSchema }).strict(),
]);

type ProfileMutationInput = z.infer<typeof mutationInputSchema>;

export interface SyncProfileStoreOptions {
  readonly storeRoot: string;
}

export interface SyncProfileShowOptions extends SyncProfileStoreOptions {
  readonly profileId: string;
}

export interface SyncProfileMutationOptions extends SyncProfileShowOptions {
  readonly desired: SyncProfileDesiredState;
  readonly dryRun?: boolean;
}

export interface SyncProfileDeleteOptions extends SyncProfileShowOptions {
  readonly dryRun?: boolean;
}

export interface PlannedSyncProfileMutation {
  readonly profile: SyncProfile | null;
  readonly plan: MutationPlan;
  readonly operation?: OperationResult;
}

export interface AppliedSyncProfileMutation {
  readonly plan: MutationPlan;
  readonly operation: OperationResult;
}

export interface SyncProfileResourceCascadeEdit {
  readonly profileId: string;
  readonly beforeRevision: string;
  readonly afterRevision: string | null;
}

export interface ResolvedSyncProfileResource {
  readonly resourceId: string;
  readonly revision: string;
  readonly capability: Capability;
}

export interface CanonicalSyncProfileResolution {
  readonly profile: SyncProfile;
  readonly resources: readonly ResolvedSyncProfileResource[];
  readonly evidence: SyncProfileTargetEvidence;
}

export class SyncProfileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "SyncProfileError";
  }
}

export function syncProfilesPath(storeRoot: string): string {
  return join(storeRoot, "profiles.json");
}

export async function listSyncProfiles(
  env: Env,
  opts: SyncProfileStoreOptions,
): Promise<readonly SyncProfile[]> {
  const registry = await loadProfileRegistry(env, normalizeStoreRoot(opts.storeRoot));
  return registry.profiles;
}

export function serializeSyncProfileRegistry(profiles: readonly SyncProfile[]): string {
  return serializeRegistry(
    parseProfileRegistry({
      schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
      profiles: [...profiles],
    }),
  );
}

export function cascadeResourceFromSyncProfiles(
  profiles: readonly SyncProfile[],
  resourceId: string,
  updatedAt: string,
): {
  readonly profiles: readonly SyncProfile[];
  readonly edits: readonly SyncProfileResourceCascadeEdit[];
} {
  const next: SyncProfile[] = [];
  const edits: SyncProfileResourceCascadeEdit[] = [];
  for (const profile of profiles) {
    if (!profile.desired.resourceIds.includes(resourceId)) {
      next.push(profile);
      continue;
    }
    const desired = normalizeDesired({
      ...profile.desired,
      resourceIds: profile.desired.resourceIds.filter((id) => id !== resourceId),
    });
    if (desired.resourceIds.length === 0 && desired.collectionIds.length === 0) {
      edits.push({
        profileId: profile.profileId,
        beforeRevision: profile.revision,
        afterRevision: null,
      });
      continue;
    }
    const revision = profileRevision(desired);
    const updated = parseSyncProfile({
      ...profile,
      revision,
      updatedAt: revision === profile.revision ? profile.updatedAt : updatedAt,
      desired,
    });
    next.push(updated);
    edits.push({
      profileId: profile.profileId,
      beforeRevision: profile.revision,
      afterRevision: updated.revision,
    });
  }
  next.sort((left, right) => left.profileId.localeCompare(right.profileId));
  return { profiles: next, edits };
}

export async function showSyncProfile(
  env: Env,
  opts: SyncProfileShowOptions,
): Promise<{ readonly profile: SyncProfile | null }> {
  const profileId = parseProfileId(opts.profileId);
  const profiles = await listSyncProfiles(env, opts);
  return { profile: profiles.find((profile) => profile.profileId === profileId) ?? null };
}

export async function resolveCanonicalSyncProfile(
  env: Env,
  opts: SyncProfileShowOptions,
): Promise<CanonicalSyncProfileResolution> {
  const storeRoot = normalizeStoreRoot(opts.storeRoot);
  const profile = (await showSyncProfile(env, { storeRoot, profileId: opts.profileId })).profile;
  if (!profile) {
    throw new SyncProfileError("PROFILE_NOT_FOUND", `profile "${opts.profileId}" does not exist`);
  }
  await validateDependencies(env, storeRoot, profile.desired);
  const [config, rules, mcp, skills] = await Promise.all([
    loadConfig(env, storeRoot),
    listRuleArtifacts(env, storeRoot),
    listMcpArtifacts(env, storeRoot),
    listSkillArtifacts(env, storeRoot),
  ]);
  const artifacts = [...rules, ...mcp, ...skills];
  const selected = new Set(profile.desired.resourceIds);
  for (const artifact of artifacts) {
    const memberships = config.artifacts[artifact.id]?.collections ?? [];
    if (memberships.some((collectionId) => profile.desired.collectionIds.includes(collectionId))) {
      selected.add(artifact.id);
    }
  }
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact] as const));
  const missing = [...selected].filter((resourceId) => !byId.has(resourceId));
  if (missing.length > 0) {
    throw new SyncProfileError("MISSING_PROFILE_DEPENDENCY", "profile resources are missing", {
      resources: missing,
    });
  }
  const resources = (
    await Promise.all(
      [...selected]
        .sort((left, right) => left.localeCompare(right))
        .map(async (resourceId) => {
          const artifact = byId.get(resourceId);
          if (!artifact) throw new TypeError("resolved resource disappeared");
          const record = await loadResourceRecord(env, storeRoot, artifact);
          return {
            resourceId,
            revision: record.currentRevision.id,
            capability: artifact.kind,
          } satisfies ResolvedSyncProfileResource;
        }),
    )
  ).filter((resource) => profile.desired.capabilities.includes(resource.capability));
  return {
    profile,
    resources,
    evidence: {
      profileId: profile.profileId,
      profileRevision: profile.revision,
      resolvedResources: resources.map((resource) => ({ ...resource })),
    },
  };
}

export async function createSyncProfile(
  env: Env,
  opts: SyncProfileMutationOptions,
): Promise<PlannedSyncProfileMutation> {
  return withCurrentMutationAuthorityScope(env, (authorityScope) =>
    mutateProfile(
      env,
      opts,
      {
        action: "create",
        profileId: opts.profileId,
        desired: opts.desired,
        timestamp: env.now().toISOString(),
      },
      authorityScope,
    ),
  );
}

export async function updateSyncProfile(
  env: Env,
  opts: SyncProfileMutationOptions,
): Promise<PlannedSyncProfileMutation> {
  return withCurrentMutationAuthorityScope(env, (authorityScope) =>
    mutateProfile(
      env,
      opts,
      {
        action: "update",
        profileId: opts.profileId,
        desired: opts.desired,
        timestamp: env.now().toISOString(),
      },
      authorityScope,
    ),
  );
}

export async function deleteSyncProfile(
  env: Env,
  opts: SyncProfileDeleteOptions,
): Promise<PlannedSyncProfileMutation> {
  return withCurrentMutationAuthorityScope(env, (authorityScope) =>
    mutateProfile(env, opts, { action: "delete", profileId: opts.profileId }, authorityScope),
  );
}

export async function applySyncProfileMutationPlan(
  env: Env,
  plan: MutationPlan,
  opts: SyncProfileStoreOptions,
): Promise<AppliedSyncProfileMutation> {
  return withCurrentMutationAuthorityScope(env, (authorityScope) =>
    applySyncProfileMutationPlanWithinScope(env, plan, opts, authorityScope),
  );
}

async function applySyncProfileMutationPlanWithinScope(
  env: Env,
  plan: MutationPlan,
  opts: SyncProfileStoreOptions,
  authorityScope: CurrentMutationAuthorityScope,
): Promise<AppliedSyncProfileMutation> {
  const authorityLease = await assertCurrentMutationAuthorityScope(env, authorityScope);
  const storeRoot = normalizeStoreRoot(opts.storeRoot);
  const businessInput = decodeBusinessInput(plan);
  if (!businessInput) return { plan, operation: invalidPlanResult() };
  const mutationKind = mutationKindFor(businessInput);
  const path = syncProfilesPath(storeRoot);
  const result = await applyStorePublicationPlan(env, storeRoot, plan, {
    secretPublicationGuard: activeSecretPublicationGuard,
    operation: "settings",
    allowedMutationKinds: PROFILE_MUTATION_KINDS,
    requiredTarget: path,
    requiredProvenancePathsByMutationKind: Object.fromEntries(
      PROFILE_MUTATION_KINDS.map((kind) => [kind, profileProvenancePaths(storeRoot)]),
    ),
    requiredNormalizedInputKeys: ["businessInput"],
    validatePublicationData: validateRegistryPublication,
    validatePlanUnderLock: async (lockedPlan, publication) => {
      const decoded = decodeBusinessInput(lockedPlan);
      if (
        !decoded ||
        mutationKindFor(decoded) !== mutationKind ||
        canonicalJson(decoded) !== canonicalJson(businessInput)
      ) {
        return invalidPlanResult();
      }
      try {
        const expected = await prepareMutation(env, storeRoot, decoded);
        if (
          publication.path !== path ||
          publication.mode !== 0o600 ||
          publication.data !== serializeRegistry(expected.registry)
        ) {
          return invalidPlanResult();
        }
        return null;
      } catch {
        return invalidPlanResult();
      }
    },
    authorityLease,
  });
  return { plan, operation: result.operation };
}

export function parseSyncProfile(value: unknown): SyncProfile {
  const profile = syncProfileSchema.parse(value);
  if (profile.revision !== profileRevision(profile.desired)) {
    throw new SyncProfileError("INVALID_PROFILE", "profile revision does not match desired state");
  }
  return profile;
}

async function mutateProfile(
  env: Env,
  opts: SyncProfileStoreOptions & { readonly dryRun?: boolean },
  rawInput: ProfileMutationInput,
  authorityScope: CurrentMutationAuthorityScope,
): Promise<PlannedSyncProfileMutation> {
  const authorityLease = await assertCurrentMutationAuthorityScope(env, authorityScope);
  const storeRoot = normalizeStoreRoot(opts.storeRoot);
  const input = mutationInputSchema.parse(rawInput);
  const mutationKind = mutationKindFor(input);
  const changedFields = [`profiles.${input.profileId}`];
  const prepare = async () => {
    const prepared = await prepareMutation(env, storeRoot, input);
    return {
      value: prepared.profile,
      publications: [
        {
          path: syncProfilesPath(storeRoot),
          data: serializeRegistry(prepared.registry),
          mode: 0o600,
        },
      ],
    };
  };
  const planned = await planStorePublicationMutation(
    env,
    storeRoot,
    "settings",
    mutationKind,
    prepare,
    {
      provenancePaths: profileProvenancePaths(storeRoot),
      normalizedInputs: {
        businessInput: input as unknown as CanonicalJsonObject,
        changedFields,
      },
      selfContainedPublications: true,
      secretPublicationGuard: activeSecretPublicationGuard,
      validatePublications: (publications) =>
        publications.forEach(({ data }) => {
          validateRegistryPublication(data);
        }),
    },
    { authorityLease },
  );
  if (opts.dryRun) return { profile: planned.value, plan: planned.plan };
  const applied = await applySyncProfileMutationPlanWithinScope(
    env,
    planned.plan,
    { storeRoot },
    authorityScope,
  );
  if (!applied.operation.ok) throw new StoreMutationConflictError(applied.operation.conflict);
  return { profile: planned.value, plan: planned.plan, operation: applied.operation };
}

async function prepareMutation(
  env: Env,
  storeRoot: string,
  input: ProfileMutationInput,
): Promise<{ readonly registry: ProfileRegistry; readonly profile: SyncProfile | null }> {
  const current = await loadProfileRegistry(env, storeRoot);
  const index = current.profiles.findIndex((profile) => profile.profileId === input.profileId);
  if (input.action === "create" && index >= 0) {
    throw new SyncProfileError("PROFILE_EXISTS", `profile "${input.profileId}" already exists`);
  }
  if (input.action !== "create" && index < 0) {
    throw new SyncProfileError("PROFILE_NOT_FOUND", `profile "${input.profileId}" does not exist`);
  }
  if (input.action !== "create") {
    const ledger = await loadLedgerForPlanning(env, storeRoot);
    const owners = ledger.owners.filter(
      (owner) => owner.syncProfile?.profileId === input.profileId,
    );
    if (owners.length > 0) {
      throw new SyncProfileError(
        "PROFILE_TARGETS_OWNED",
        `profile "${input.profileId}" still owns targets; sync uninstall it with the current profile evidence before ${input.action}`,
        {
          profileId: input.profileId,
          targetKeys: owners.map(targetKey).sort((left, right) => left.localeCompare(right)),
          ownerEvidence: owners.map((owner) => owner.syncProfile),
        },
      );
    }
  }
  if (input.action === "delete") {
    return {
      registry: parseProfileRegistry({
        schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
        profiles: current.profiles.filter((profile) => profile.profileId !== input.profileId),
      }),
      profile: null,
    };
  }
  const desired = normalizeDesired(input.desired);
  await validateDependencies(env, storeRoot, desired);
  const prior = index >= 0 ? current.profiles[index] : undefined;
  const now = input.timestamp;
  const revision = profileRevision(desired);
  const profile = parseSyncProfile({
    schemaVersion: SYNC_PROFILE_SCHEMA_VERSION,
    profileId: input.profileId,
    revision,
    createdAt: prior?.createdAt ?? now,
    updatedAt: prior?.revision === revision ? prior.updatedAt : now,
    desired,
  });
  const profiles = current.profiles.filter((item) => item.profileId !== profile.profileId);
  profiles.push(profile);
  profiles.sort((left, right) => left.profileId.localeCompare(right.profileId));
  return {
    registry: parseProfileRegistry({ schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION, profiles }),
    profile,
  };
}

async function validateDependencies(
  env: Env,
  storeRoot: string,
  desired: SyncProfileDesiredState,
): Promise<void> {
  const [registry, config, rules, mcp, skills] = await Promise.all([
    loadRegistry(env, storeRoot),
    loadConfig(env, storeRoot),
    listRuleArtifacts(env, storeRoot),
    listMcpArtifacts(env, storeRoot),
    listSkillArtifacts(env, storeRoot),
  ]);
  const missingAgents = desired.agentIds.filter((id) => !registry.get(id));
  const resourceIds = new Set([...rules, ...mcp, ...skills].map((artifact) => artifact.id));
  const missingResources = desired.resourceIds.filter((id) => !resourceIds.has(id));
  const missingCollections = desired.collectionIds.filter(
    (id) => !Object.hasOwn(config.collections, id),
  );
  if (missingAgents.length || missingResources.length || missingCollections.length) {
    throw new SyncProfileError("MISSING_PROFILE_DEPENDENCY", "profile dependencies are missing", {
      agents: missingAgents,
      resources: missingResources,
      collections: missingCollections,
    });
  }
}

function normalizeDesired(value: SyncProfileDesiredState): SyncProfileDesiredState {
  const desired = syncProfileDesiredStateSchema.parse(value);
  return {
    ...desired,
    agentIds: sorted(desired.agentIds),
    resourceIds: sorted(desired.resourceIds),
    collectionIds: sorted(desired.collectionIds),
    capabilities: sorted(desired.capabilities),
  };
}

function profileRevision(desired: SyncProfileDesiredState): string {
  return sha256(canonicalJson(normalizeDesired(desired) as unknown as CanonicalJsonObject));
}

async function loadProfileRegistry(env: Env, storeRoot: string): Promise<ProfileRegistry> {
  const text = await readFileOrNull(env, syncProfilesPath(storeRoot));
  if (text === null) return { schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION, profiles: [] };
  try {
    return parseProfileRegistry(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyncProfileError) throw error;
    throw new SyncProfileError("INVALID_PROFILE_STORE", "profile registry is invalid");
  }
}

function parseProfileRegistry(value: unknown): ProfileRegistry {
  const registry = profileRegistrySchema.parse(value);
  const profiles = registry.profiles.map(parseSyncProfile);
  if (new Set(profiles.map((profile) => profile.profileId)).size !== profiles.length) {
    throw new SyncProfileError("INVALID_PROFILE_STORE", "profile IDs must be unique");
  }
  const sortedProfiles = [...profiles].sort((left, right) =>
    left.profileId.localeCompare(right.profileId),
  );
  if (canonicalJson(profiles) !== canonicalJson(sortedProfiles)) {
    throw new SyncProfileError("INVALID_PROFILE_STORE", "profiles must use deterministic ordering");
  }
  return { schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION, profiles: sortedProfiles };
}

function validateRegistryPublication(data: string): void {
  const parsed = parseProfileRegistry(JSON.parse(data));
  if (serializeRegistry(parsed) !== data) {
    throw new SyncProfileError("INVALID_PROFILE_STORE", "profile registry is not canonical");
  }
}

function serializeRegistry(registry: ProfileRegistry): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

function decodeBusinessInput(plan: MutationPlan): ProfileMutationInput | null {
  try {
    const input = mutationInputSchema.parse(plan.normalizedInputs.businessInput);
    if (plan.normalizedInputs.mutationKind !== mutationKindFor(input)) return null;
    if (
      canonicalJson(plan.normalizedInputs.changedFields) !==
      canonicalJson([`profiles.${input.profileId}`])
    ) {
      return null;
    }
    return input;
  } catch {
    return null;
  }
}

function mutationKindFor(input: ProfileMutationInput): (typeof PROFILE_MUTATION_KINDS)[number] {
  return `profile-${input.action}`;
}

function profileProvenancePaths(storeRoot: string): string[] {
  return [
    syncProfilesPath(storeRoot),
    join(storeRoot, "config.json"),
    join(storeRoot, "store", "metadata"),
    join(storeRoot, "store", "rules"),
    join(storeRoot, "store", "mcp"),
    join(storeRoot, "store", "skills"),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeStoreRoot(value: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new SyncProfileError("INVALID_INPUT", "storeRoot must be absolute");
  }
  return normalize(value);
}

function parseProfileId(value: string): string {
  const result = profileIdSchema.safeParse(value);
  if (!result.success) throw new SyncProfileError("INVALID_INPUT", "profileId is invalid");
  return result.data;
}

function sorted<T extends string>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}
