import { dirname, isAbsolute, join, normalize } from "node:path";
import type {
  Env,
  FileTreeSnapshot,
  FileTreeSnapshotNode,
  MutationAuthorityLease,
} from "../env.js";
import { serverFromRaw } from "../mcp/model.js";
import type { Artifact, ArtifactKind, TargetOwner } from "../model/index.js";
import {
  acquireCurrentMutationAuthorityLease,
  assertStrictMutationPlanRuntime,
  canonicalJson,
  createAuthorizedMutationPlan,
  verifyMutationPlanAuthorization,
  verifyMutationPlanDigest,
} from "../protocol/canonical.js";
import {
  assertMutationPlanActionAlignment,
  executeMutationPlan,
  invalidPlanResult,
  targetState,
} from "../protocol/execute.js";
import type {
  CanonicalJsonObject,
  MutationPlan,
  MutationPlanAction,
  OperationActionReceipt,
  OperationResult,
  PlanExpiry,
  TargetStateReceipt,
} from "../protocol/models.js";
import { captureStoreProvenance, validateStoreProvenance } from "../protocol/store-mutation.js";
import { observeAtStableStoreRevision } from "../protocol/store-revision.js";
import { discoverSecretReferences } from "../secrets/active-values.js";
import {
  isSensitiveSecretFieldName,
  scanStructuredFileSecretFindings,
  scanTextForSecrets,
} from "../secrets/detector.js";
import { containsObservableKnownValue, observableKnownValues } from "../secrets/observable.js";
import { secretReferenceToken } from "../secrets/reference.js";
import {
  captureSafeRecursiveSource,
  installSafeRecursiveSnapshot,
  type SafeRecursiveSnapshot,
} from "../secrets/safe-tree.js";
import { sha256 } from "../store/checksum.js";
import {
  type CellarerConfig,
  CONFIG_FILENAME,
  loadConfig,
  parseConfigValue,
} from "../store/config.js";
import { entryKey, loadLedgerForPlanning } from "../store/ledger.js";
import { listMcpArtifacts, listRuleArtifacts, listSkillArtifacts } from "../store/store.js";
import {
  cascadeResourceFromSyncProfiles,
  listSyncProfiles,
  type SyncProfile,
  type SyncProfileResourceCascadeEdit,
  serializeSyncProfileRegistry,
  syncProfilesPath,
} from "../sync/profiles.js";
import {
  createResourceRecord,
  loadResourceRecord,
  parseResourceRecord,
  type ResourceRecord,
  type ResourceSourceDescriptor,
  resourceMetadataPath,
  resourceSourceDescriptorSchema,
} from "./model.js";

const LIFECYCLE_SCHEMA_VERSION = 1 as const;
const BUNDLE_FORMAT = "cellarer-resource-bundle" as const;
const BUNDLE_SCHEMA_VERSION = 1 as const;
const RESOURCE_ID_PATTERN = /^(rules|mcp|skills)\/[A-Za-z0-9._-]+$/;
const RESOURCE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface ResourceDependencyOptions {
  readonly storeRoot: string;
  readonly resourceId: string;
}

export interface ResourceDependencyReport {
  readonly schemaVersion: 1;
  readonly resourceId: string;
  readonly currentRevisionId: string;
  readonly collections: readonly {
    readonly collectionId: string;
    readonly resourceId: string;
  }[];
  readonly profiles: readonly {
    readonly profileId: string;
    readonly profileRevision: string;
    readonly viaResource: boolean;
    readonly collectionIds: readonly string[];
  }[];
  readonly desiredSelections: readonly {
    readonly selector: "defaults.collections";
    readonly collectionId: string;
    readonly resourceId: string;
  }[];
  readonly ownedTargets: readonly {
    readonly key: string;
    readonly agent: string;
    readonly scope: TargetOwner["scope"];
    readonly capability: TargetOwner["capability"];
    readonly target: string;
    readonly resourceId: string;
    readonly receiptFingerprint: string;
  }[];
}

export type ResourceLifecycleBlockCode =
  | "LOCAL_FORK_REQUIRED"
  | "RESOURCE_COLLISION"
  | "COLLECTION_DEPENDENCY"
  | "PROFILE_DEPENDENCY"
  | "DESIRED_SELECTION_DEPENDENCY"
  | "OWNED_TARGET_DEPENDENCY";

export interface ResourceRenameOptions extends ResourceDependencyOptions {
  readonly newName: string;
  readonly mode: "rename" | "local-fork";
}

export interface ResourceRemoveOptions extends ResourceDependencyOptions {
  readonly cascade: boolean;
}

export interface ResourceExportOptions {
  readonly storeRoot: string;
  readonly resourceId: string;
  readonly bundlePath: string;
}

export interface ResourceBundleImportOptions {
  readonly storeRoot: string;
  readonly bundlePath: string;
}

export interface PlannedResourceLifecycle {
  readonly plan: MutationPlan;
  readonly blocked: readonly ResourceLifecycleBlockCode[];
  readonly dependencyReport?: ResourceDependencyReport;
  readonly resource: ResourceRecord | null;
}

export interface PlannedResourceExport {
  readonly plan: MutationPlan;
  readonly bundleDigest: string;
  readonly resource: ResourceRecord;
}

export interface PlannedResourceBundleImport {
  readonly plan: MutationPlan;
  readonly bundleDigest: string;
  readonly resource: ResourceRecord;
}

export interface AppliedResourceLifecycle {
  readonly plan: MutationPlan;
  readonly resource: ResourceRecord | null;
  readonly operation: OperationResult;
}

interface EncodedContentNode {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly mode: number;
  readonly dataHex?: string;
  readonly digest?: string;
}

interface EncodedResourceContent {
  readonly kind: "file" | "directory";
  readonly nodes: readonly EncodedContentNode[];
  readonly fingerprint: string;
  readonly byteLength: number;
  readonly digest: string;
}

interface PortableBundleManifest {
  readonly format: typeof BUNDLE_FORMAT;
  readonly schemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  readonly resource: ResourceRecord;
  readonly contentDigest: string;
  readonly secretRefs: readonly string[];
}

interface PortableResourceBundle {
  readonly manifest: PortableBundleManifest;
  readonly content: EncodedResourceContent;
  readonly bundleDigest: string;
}

export interface ValidatedResourceBundle {
  readonly resource: ResourceRecord;
  readonly bundleDigest: string;
  readonly contentFingerprint: string;
}

interface ExactResource {
  readonly artifact: Artifact;
  readonly record: ResourceRecord;
}

interface ExecutableLifecycleAction {
  readonly action: MutationPlanAction;
  readonly execute: () => Promise<void>;
}

interface BuiltLifecyclePlan {
  readonly plan: MutationPlan;
  readonly actions: readonly ExecutableLifecycleAction[];
  readonly blocked: readonly ResourceLifecycleBlockCode[];
  readonly resource: ResourceRecord | null;
  readonly dependencyReport?: ResourceDependencyReport;
  readonly bundleDigest?: string;
}

interface BuildOptions {
  readonly planId?: string;
  readonly expires?: PlanExpiry;
}

export class ResourceLifecycleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ResourceLifecycleError";
  }
}

export async function resourceDependencyReport(
  env: Env,
  opts: ResourceDependencyOptions,
): Promise<ResourceDependencyReport> {
  const normalized = normalizeDependencyOptions(opts);
  const observed = await observeAtStableStoreRevision(env, normalized.storeRoot, async () => {
    const current = await exactResource(env, normalized.storeRoot, normalized.resourceId);
    const [config, ledger, profiles] = await Promise.all([
      loadConfig(env, normalized.storeRoot),
      loadLedgerForPlanning(env, normalized.storeRoot),
      listSyncProfiles(env, { storeRoot: normalized.storeRoot }),
    ]);
    return buildDependencyReport(current.record, config, ledger.owners, profiles);
  });
  return observed.value;
}

export async function planResourceRename(
  env: Env,
  opts: ResourceRenameOptions,
): Promise<PlannedResourceLifecycle> {
  const normalized = normalizeRenameOptions(opts);
  return withAuthorityLease(env, async () =>
    projectLifecycle(await buildRenamePlan(env, normalized)),
  );
}

export async function applyResourceRenamePlan(
  env: Env,
  plan: MutationPlan,
  context: { readonly storeRoot: string; readonly options: ResourceRenameOptions },
): Promise<AppliedResourceLifecycle> {
  const options = normalizeRenameOptions(context.options);
  if (context.storeRoot !== options.storeRoot) return invalidApplied(plan);
  return applyCanonicalLifecyclePlan(env, plan, options.storeRoot, (buildOptions) =>
    buildRenamePlan(env, options, buildOptions),
  );
}

export async function planResourceRemove(
  env: Env,
  opts: ResourceRemoveOptions,
): Promise<PlannedResourceLifecycle> {
  const normalized = normalizeRemoveOptions(opts);
  return withAuthorityLease(env, async () =>
    projectLifecycle(await buildRemovePlan(env, normalized)),
  );
}

export async function applyResourceRemovePlan(
  env: Env,
  plan: MutationPlan,
  context: { readonly storeRoot: string; readonly options: ResourceRemoveOptions },
): Promise<AppliedResourceLifecycle> {
  const options = normalizeRemoveOptions(context.options);
  if (context.storeRoot !== options.storeRoot) return invalidApplied(plan);
  return applyCanonicalLifecyclePlan(env, plan, options.storeRoot, (buildOptions) =>
    buildRemovePlan(env, options, buildOptions),
  );
}

export async function planResourceExport(
  env: Env,
  opts: ResourceExportOptions,
): Promise<PlannedResourceExport> {
  const normalized = normalizeExportOptions(opts);
  const built = await withAuthorityLease(env, () => buildExportPlan(env, normalized));
  if (!built.bundleDigest || !built.resource)
    throw new TypeError("resource export plan is incomplete");
  return { plan: built.plan, bundleDigest: built.bundleDigest, resource: built.resource };
}

export async function applyResourceExportPlan(
  env: Env,
  plan: MutationPlan,
  context: { readonly storeRoot: string; readonly options: ResourceExportOptions },
): Promise<AppliedResourceLifecycle> {
  const options = normalizeExportOptions(context.options);
  if (context.storeRoot !== options.storeRoot) return invalidApplied(plan);
  return applyCanonicalLifecyclePlan(env, plan, options.storeRoot, (buildOptions) =>
    buildExportPlan(env, options, buildOptions),
  );
}

export async function validateResourceBundle(
  env: Env,
  opts: { readonly bundlePath: string },
): Promise<ValidatedResourceBundle> {
  const bundlePath = normalizeAbsolutePath(opts.bundlePath, "bundlePath");
  const parsed = await readAndValidateBundle(env, bundlePath);
  return deepFreeze({
    resource: parsed.manifest.resource,
    bundleDigest: parsed.bundleDigest,
    contentFingerprint: parsed.content.fingerprint,
  });
}

export async function planResourceBundleImport(
  env: Env,
  opts: ResourceBundleImportOptions,
): Promise<PlannedResourceBundleImport> {
  const normalized = normalizeImportOptions(opts);
  const built = await withAuthorityLease(env, () => buildImportPlan(env, normalized));
  if (!built.bundleDigest || !built.resource)
    throw new TypeError("resource import plan is incomplete");
  return { plan: built.plan, bundleDigest: built.bundleDigest, resource: built.resource };
}

export async function applyResourceBundleImportPlan(
  env: Env,
  plan: MutationPlan,
  context: { readonly storeRoot: string; readonly options: ResourceBundleImportOptions },
): Promise<AppliedResourceLifecycle> {
  const options = normalizeImportOptions(context.options);
  if (context.storeRoot !== options.storeRoot) return invalidApplied(plan);
  return applyCanonicalLifecyclePlan(env, plan, options.storeRoot, (buildOptions) =>
    buildImportPlan(env, options, buildOptions),
  );
}

async function buildRenamePlan(
  env: Env,
  opts: ResourceRenameOptions,
  buildOptions: BuildOptions = {},
): Promise<BuiltLifecyclePlan> {
  const observed = await observeAtStableStoreRevision(env, opts.storeRoot, async () => {
    const current = await exactResource(env, opts.storeRoot, opts.resourceId);
    const [config, ledger, snapshot, profiles] = await Promise.all([
      loadConfig(env, opts.storeRoot),
      loadLedgerForPlanning(env, opts.storeRoot),
      captureSafeRecursiveSource(env, current.artifact.sourcePath),
      listSyncProfiles(env, { storeRoot: opts.storeRoot }),
    ]);
    const report = buildDependencyReport(current.record, config, ledger.owners, profiles);
    const collision = await resourceNameCollision(
      env,
      opts.storeRoot,
      current.record.kind,
      opts.newName,
      opts.mode === "local-fork"
        ? `${current.record.kind}/${opts.newName}`
        : current.record.resourceId,
      opts.mode === "rename" ? current.record.resourceId : undefined,
    );
    const blocked: ResourceLifecycleBlockCode[] = [];
    if (current.record.kind === "skills" && opts.mode === "rename") {
      blocked.push("LOCAL_FORK_REQUIRED");
    }
    if (collision) blocked.push("RESOURCE_COLLISION");

    const actions: ExecutableLifecycleAction[] = [];
    let resource: ResourceRecord | null = current.record;
    const provenancePaths = lifecycleResourceProvenancePaths(opts.storeRoot, current);
    if (blocked.length === 0 && opts.mode === "local-fork") {
      const content = forkContent(env, current.record, snapshot, opts.newName);
      resource = createResourceRecord({
        resourceId: `${current.record.kind}/${opts.newName}`,
        kind: current.record.kind,
        name: opts.newName,
        contentFingerprint: content.fingerprint,
        validation: {
          status: "validated",
          checkedAt: env.now().toISOString(),
          checks: [...validationChecksFor(current.record.kind)],
        },
        source: { type: "local-snapshot" },
      });
      const target = resourceBasePath(opts.storeRoot, resource.kind, resource.name);
      const metadataTarget = resourceMetadataPath(opts.storeRoot, resource.kind, resource.name);
      actions.push(
        contentInstallAction("resource-local-fork", resource, content, target, env),
        metadataPublishAction("resource-local-fork", resource, metadataTarget, env),
      );
    } else if (blocked.length === 0) {
      resource = createResourceRecord({
        resourceId: current.record.resourceId,
        kind: current.record.kind,
        name: opts.newName,
        contentFingerprint: current.record.currentRevision.contentFingerprint,
        validation: current.record.currentRevision.validation,
        source: current.record.currentRevision.source,
      });
      const source = resourceBasePath(opts.storeRoot, current.record.kind, current.record.name);
      const target = resourceBasePath(opts.storeRoot, current.record.kind, opts.newName);
      if (current.artifact.sourcePath === source) {
        actions.push(renameContentAction(source, target, current.record, resource, env));
      } else {
        const content = encodeContent(snapshot.tree.nodes);
        validateContent(env, current.record.kind, opts.newName, content);
        actions.push(
          contentInstallAction("resource-rename", resource, content, target, env),
          removePathAction("resource-rename", source, current.record.resourceId, env),
        );
      }
      const metadataTarget = resourceMetadataPath(opts.storeRoot, resource.kind, resource.name);
      actions.push(metadataPublishAction("resource-rename", resource, metadataTarget, env));
      const oldMetadata = resourceMetadataPath(
        opts.storeRoot,
        current.record.kind,
        current.record.name,
      );
      if (
        oldMetadata !== metadataTarget &&
        (await targetState(env, oldMetadata)).state === "present"
      ) {
        actions.push(
          removePathAction("resource-rename", oldMetadata, current.record.resourceId, env),
        );
      }
    }
    return { current, report, blocked: uniqueSorted(blocked), actions, resource, provenancePaths };
  });
  return finalizeLifecyclePlan(env, opts.storeRoot, observed.revision, {
    mutationKind: opts.mode === "local-fork" ? "resource-local-fork" : "resource-rename",
    businessInput: renameBusinessInput(opts),
    capabilitySnapshot: capabilitySnapshot(observed.value.current.record),
    currentRevisionId: observed.value.current.record.currentRevision.id,
    provenancePaths: observed.value.provenancePaths,
    actions: observed.value.actions,
    blocked: observed.value.blocked,
    resource: observed.value.resource,
    dependencyReport: observed.value.report,
    buildOptions,
  });
}

async function buildRemovePlan(
  env: Env,
  opts: ResourceRemoveOptions,
  buildOptions: BuildOptions = {},
): Promise<BuiltLifecyclePlan> {
  const observed = await observeAtStableStoreRevision(env, opts.storeRoot, async () => {
    const current = await exactResource(env, opts.storeRoot, opts.resourceId);
    const [config, ledger, profiles] = await Promise.all([
      loadConfig(env, opts.storeRoot),
      loadLedgerForPlanning(env, opts.storeRoot),
      listSyncProfiles(env, { storeRoot: opts.storeRoot }),
    ]);
    const report = buildDependencyReport(current.record, config, ledger.owners, profiles);
    const blocked: ResourceLifecycleBlockCode[] = [];
    if (report.ownedTargets.length > 0) blocked.push("OWNED_TARGET_DEPENDENCY");
    if (!opts.cascade) {
      if (report.collections.length > 0) blocked.push("COLLECTION_DEPENDENCY");
      if (report.profiles.length > 0) blocked.push("PROFILE_DEPENDENCY");
      if (report.desiredSelections.length > 0) blocked.push("DESIRED_SELECTION_DEPENDENCY");
    }

    const actions: ExecutableLifecycleAction[] = [];
    const provenancePaths = lifecycleResourceProvenancePaths(opts.storeRoot, current);
    provenancePaths.push(join(opts.storeRoot, CONFIG_FILENAME));
    provenancePaths.push(syncProfilesPath(opts.storeRoot));
    if (blocked.length === 0) {
      const removalPaths = uniqueSorted([
        resourceBasePath(opts.storeRoot, current.record.kind, current.record.name),
        resourceMetadataPath(opts.storeRoot, current.record.kind, current.record.name),
        resourceRevisionRootPath(opts.storeRoot, current.record.resourceId),
      ]);
      for (const path of removalPaths) {
        if ((await targetState(env, path)).state === "present") {
          actions.push(removePathAction("resource-remove", path, current.record.resourceId, env));
        }
      }
      const nextConfig = configWithoutResource(config, current.record.resourceId);
      if (canonicalJson(config) !== canonicalJson(nextConfig)) {
        actions.push(configPublishAction("resource-remove", opts.storeRoot, nextConfig, env));
      }
      if (opts.cascade) {
        const cascaded = cascadeResourceFromSyncProfiles(
          profiles,
          current.record.resourceId,
          env.now().toISOString(),
        );
        if (cascaded.edits.length > 0) {
          actions.push(
            profileRegistryPublishAction(
              "resource-remove",
              opts.storeRoot,
              cascaded.profiles,
              cascaded.edits,
              env,
            ),
          );
        }
      }
    }
    return {
      current,
      report,
      blocked: uniqueSorted(blocked),
      actions,
      provenancePaths: uniqueSorted(provenancePaths),
    };
  });
  return finalizeLifecyclePlan(env, opts.storeRoot, observed.revision, {
    mutationKind: opts.cascade ? "resource-remove-cascade" : "resource-remove-ordinary",
    businessInput: removeBusinessInput(opts),
    capabilitySnapshot: capabilitySnapshot(observed.value.current.record),
    currentRevisionId: observed.value.current.record.currentRevision.id,
    provenancePaths: observed.value.provenancePaths,
    actions: observed.value.actions,
    blocked: observed.value.blocked,
    resource: null,
    dependencyReport: observed.value.report,
    buildOptions,
  });
}

async function buildExportPlan(
  env: Env,
  opts: ResourceExportOptions,
  buildOptions: BuildOptions = {},
): Promise<BuiltLifecyclePlan> {
  const observed = await observeAtStableStoreRevision(env, opts.storeRoot, async () => {
    const current = await exactResource(env, opts.storeRoot, opts.resourceId);
    const snapshot = await captureSafeRecursiveSource(env, current.artifact.sourcePath);
    const bundle = createPortableBundle(env, current.record, snapshot);
    const serialized = serializeBundle(bundle);
    const parent = await targetState(env, dirname(opts.bundlePath));
    if (parent.state !== "present") {
      throw new ResourceLifecycleError(
        "EXPORT_PARENT_MISSING",
        "resource export parent directory must already exist",
      );
    }
    if ((await targetState(env, opts.bundlePath)).state !== "absent") {
      throw new ResourceLifecycleError(
        "RESOURCE_EXPORT_COLLISION",
        "resource export target already exists",
      );
    }
    const action = exportWriteAction(opts.bundlePath, bundle, serialized, env);
    return {
      current,
      bundle,
      action,
      provenancePaths: lifecycleResourceProvenancePaths(opts.storeRoot, current),
    };
  });
  return finalizeLifecyclePlan(env, opts.storeRoot, observed.revision, {
    mutationKind: "resource-export",
    businessInput: exportBusinessInput(opts),
    capabilitySnapshot: capabilitySnapshot(observed.value.current.record),
    currentRevisionId: observed.value.current.record.currentRevision.id,
    provenancePaths: observed.value.provenancePaths,
    actions: [observed.value.action],
    blocked: [],
    resource: observed.value.bundle.manifest.resource,
    bundleDigest: observed.value.bundle.bundleDigest,
    buildOptions,
  });
}

async function buildImportPlan(
  env: Env,
  opts: ResourceBundleImportOptions,
  buildOptions: BuildOptions = {},
): Promise<BuiltLifecyclePlan> {
  // Complete format, digest, identity, path, and secret validation intentionally precedes any
  // Store inventory observation so hostile bundles cannot cause partial Store decisions.
  const bundle = await readAndValidateBundle(env, opts.bundlePath);
  const observed = await observeAtStableStoreRevision(env, opts.storeRoot, async () => {
    if (
      await resourceNameCollision(
        env,
        opts.storeRoot,
        bundle.manifest.resource.kind,
        bundle.manifest.resource.name,
        bundle.manifest.resource.resourceId,
      )
    ) {
      throw new ResourceLifecycleError(
        "RESOURCE_COLLISION",
        "bundle resource identity or name collides with managed Store state",
      );
    }
    const resource = createResourceRecord({
      resourceId: bundle.manifest.resource.resourceId,
      kind: bundle.manifest.resource.kind,
      name: bundle.manifest.resource.name,
      contentFingerprint: bundle.content.fingerprint,
      validation: bundle.manifest.resource.currentRevision.validation,
      source: { type: "local-snapshot" },
    });
    const bundleState = await targetState(env, opts.bundlePath);
    if (bundleState.state !== "present") {
      throw new ResourceLifecycleError("INVALID_BUNDLE", "bundle source disappeared");
    }
    const actions: ExecutableLifecycleAction[] = [
      preserveBundleAction(opts.bundlePath, bundleState, bundle.bundleDigest),
      contentInstallAction(
        "resource-bundle-import",
        resource,
        bundle.content,
        resourceBasePath(opts.storeRoot, resource.kind, resource.name),
        env,
      ),
      metadataPublishAction(
        "resource-bundle-import",
        resource,
        resourceMetadataPath(opts.storeRoot, resource.kind, resource.name),
        env,
      ),
    ];
    const provenancePaths = [
      join(opts.storeRoot, "store", "rules"),
      join(opts.storeRoot, "store", "mcp"),
      join(opts.storeRoot, "store", "skills"),
      join(opts.storeRoot, "store", "metadata"),
    ];
    return { resource, actions, provenancePaths };
  });
  return finalizeLifecyclePlan(env, opts.storeRoot, observed.revision, {
    mutationKind: "resource-bundle-import",
    businessInput: importBusinessInput(opts),
    capabilitySnapshot: capabilitySnapshot(observed.value.resource),
    currentRevisionId: bundle.manifest.resource.currentRevision.id,
    provenancePaths: observed.value.provenancePaths,
    actions: observed.value.actions,
    blocked: [],
    resource: observed.value.resource,
    bundleDigest: bundle.bundleDigest,
    buildOptions,
  });
}

async function finalizeLifecyclePlan(
  env: Env,
  storeRoot: string,
  baseRevision: number,
  input: {
    readonly mutationKind: string;
    readonly businessInput: CanonicalJsonObject;
    readonly capabilitySnapshot: CanonicalJsonObject;
    readonly currentRevisionId: string;
    readonly provenancePaths: readonly string[];
    readonly actions: readonly ExecutableLifecycleAction[];
    readonly blocked: readonly ResourceLifecycleBlockCode[];
    readonly resource: ResourceRecord | null;
    readonly dependencyReport?: ResourceDependencyReport;
    readonly bundleDigest?: string;
    readonly buildOptions: BuildOptions;
  },
): Promise<BuiltLifecyclePlan> {
  const provenance = await captureStoreProvenance(
    env,
    storeRoot,
    uniqueSorted(input.provenancePaths),
  );
  const targetPreconditions = await Promise.all(
    input.actions.map(async ({ action }) => ({
      actionId: action.actionId,
      target: action.target,
      expected: await targetState(env, action.target),
    })),
  );
  const plan = createAuthorizedMutationPlan(env, storeRoot, {
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    planId: input.buildOptions.planId ?? `plan-${env.randomId()}`,
    operation: "resource-lifecycle",
    baseRevision,
    normalizedInputs: jsonObject({
      mutationKind: input.mutationKind,
      businessInput: input.businessInput,
      capabilitySnapshot: input.capabilitySnapshot,
      currentRevisionId: input.currentRevisionId,
      blocked: input.blocked,
      storeProvenance: provenance,
      ...(input.dependencyReport ? { dependencyReport: input.dependencyReport } : {}),
      ...(input.bundleDigest ? { bundleDigest: input.bundleDigest } : {}),
    }),
    targetPreconditions,
    actions: input.actions.map(({ action }) => action),
    expires: input.buildOptions.expires ?? { policy: "none" },
  });
  return {
    plan,
    actions: input.actions,
    blocked: input.blocked,
    resource: input.resource,
    ...(input.dependencyReport ? { dependencyReport: input.dependencyReport } : {}),
    ...(input.bundleDigest ? { bundleDigest: input.bundleDigest } : {}),
  };
}

async function applyCanonicalLifecyclePlan(
  env: Env,
  plan: MutationPlan,
  storeRoot: string,
  rebuild: (options: BuildOptions) => Promise<BuiltLifecyclePlan>,
): Promise<AppliedResourceLifecycle> {
  try {
    assertStrictMutationPlanRuntime(plan, "resource-lifecycle");
  } catch (error) {
    if (error instanceof TypeError || error instanceof ResourceLifecycleError) {
      return invalidApplied(plan);
    }
    throw error;
  }
  if (!verifyMutationPlanAuthorization(env, storeRoot, plan) || !verifyMutationPlanDigest(plan)) {
    return invalidApplied(plan);
  }
  let lease: MutationAuthorityLease | null = null;
  try {
    lease = await acquireCurrentMutationAuthorityLease(env).catch(() => null);
    if (!lease || !(await lease.isCurrent().catch(() => false))) return invalidApplied(plan);
    assertMutationPlanActionAlignment(plan);
    const expected = await rebuild({ planId: plan.planId, expires: plan.expires });
    if (expected.blocked.length > 0 || canonicalJson(expected.plan) !== canonicalJson(plan)) {
      return invalidApplied(plan);
    }
    const validate = async (): Promise<OperationResult | null> =>
      validateStoreProvenance(env, storeRoot, plan);
    const operation = await executeMutationPlan(
      env,
      storeRoot,
      plan,
      async (_operationId, record, authorize) => {
        const receipts: OperationActionReceipt[] = [];
        const failedActionIds: string[] = [];
        for (const executable of expected.actions) {
          const authorized = await authorize(executable.action.actionId);
          if (!authorized.ok) {
            receipts.push(authorized.receipt);
            failedActionIds.push(executable.action.actionId);
            break;
          }
          let failure: { code: string; message: string } | undefined;
          try {
            await executable.execute();
            const after = await targetState(env, executable.action.target);
            if (
              !executable.action.postcondition ||
              !sameTargetReceipt(executable.action.postcondition, after)
            ) {
              throw Object.assign(new Error("resource lifecycle postcondition failed"), {
                code: "ACTION_POSTCONDITION_FAILED",
              });
            }
          } catch (error) {
            const code = controlledIoCode(error);
            if (!code) throw error;
            failure = { code, message: `filesystem action failed (${code})` };
            failedActionIds.push(executable.action.actionId);
          }
          const after = await targetState(env, executable.action.target);
          const receipt: OperationActionReceipt = {
            actionId: executable.action.actionId,
            target: executable.action.target,
            outcome: failure
              ? "failed"
              : sameTargetReceipt(authorized.before, after)
                ? "unchanged"
                : "applied",
            before: authorized.before,
            after,
            recordedAt: env.now().toISOString(),
            ...(failure ? { error: failure } : {}),
          };
          await record(receipt);
          receipts.push(receipt);
          if (failure) break;
        }
        return {
          actionReceipts: receipts,
          ...(failedActionIds.length > 0 ? { failedActionIds } : {}),
        };
      },
      {
        authorityLease: lease,
        validatePreflightBeforeObservation: validate,
        validateBeforeObservationUnderLock: validate,
        validateUnderLock: validate,
      },
    );
    return { plan, resource: expected.resource, operation };
  } catch (error) {
    if (error instanceof TypeError || error instanceof ResourceLifecycleError) {
      return invalidApplied(plan);
    }
    throw error;
  } finally {
    await lease?.release().catch(() => undefined);
  }
}

function buildDependencyReport(
  record: ResourceRecord,
  config: CellarerConfig,
  owners: readonly TargetOwner[],
  profileEvidence: readonly SyncProfile[],
): ResourceDependencyReport {
  const collectionIds = uniqueSorted(config.artifacts[record.resourceId]?.collections ?? []);
  const profiles = profileEvidence.flatMap((profile) => {
    const viaResource = profile.desired.resourceIds.includes(record.resourceId);
    const viaCollections = uniqueSorted(
      profile.desired.collectionIds.filter((collectionId) => collectionIds.includes(collectionId)),
    );
    return viaResource || viaCollections.length > 0
      ? [
          {
            profileId: profile.profileId,
            profileRevision: profile.revision,
            viaResource,
            collectionIds: viaCollections,
          },
        ]
      : [];
  });
  profiles.sort((left, right) => left.profileId.localeCompare(right.profileId));
  const desired = uniqueSorted(
    collectionIds.filter((collectionId) => config.defaults.collections.includes(collectionId)),
  );
  const ownedTargets = owners
    .filter((owner) => owner.artifactIds.includes(record.resourceId))
    .map((owner) => ({
      key: entryKey(owner),
      agent: owner.agent,
      scope: owner.scope,
      capability: owner.capability,
      target: owner.target,
      resourceId: record.resourceId,
      receiptFingerprint: owner.receipt.fingerprint,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return deepFreeze({
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    resourceId: record.resourceId,
    currentRevisionId: record.currentRevision.id,
    collections: collectionIds.map((collectionId) => ({
      collectionId,
      resourceId: record.resourceId,
    })),
    profiles,
    desiredSelections: desired.map((collectionId) => ({
      selector: "defaults.collections" as const,
      collectionId,
      resourceId: record.resourceId,
    })),
    ownedTargets,
  });
}

function contentInstallAction(
  mutationKind: string,
  resource: ResourceRecord,
  content: EncodedResourceContent,
  target: string,
  env: Env,
): ExecutableLifecycleAction {
  const action: MutationPlanAction = {
    actionId: lifecycleActionId(mutationKind, "install-resource-content", target, content.digest),
    kind: "install-resource-content",
    target,
    payload: {
      resourceId: resource.resourceId,
      contentDigest: content.digest,
      contentFingerprint: content.fingerprint,
    },
    postcondition: { state: "present", fingerprint: content.fingerprint },
  };
  return {
    action,
    execute: () => installEncodedContent(env, content, target),
  };
}

function metadataPublishAction(
  mutationKind: string,
  resource: ResourceRecord,
  target: string,
  env: Env,
): ExecutableLifecycleAction {
  const data = `${JSON.stringify(resource, null, 2)}\n`;
  const digest = sha256(data);
  return {
    action: {
      actionId: lifecycleActionId(mutationKind, "publish-resource-metadata", target, digest),
      kind: "publish-resource-metadata",
      target,
      payload: { resourceId: resource.resourceId, digest, mode: 0o600 },
      postcondition: { state: "present", fingerprint: digest },
    },
    execute: async () => {
      await env.fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await env.fs.publishFileAtomically(target, data, { mode: 0o600 });
    },
  };
}

function renameContentAction(
  source: string,
  target: string,
  before: ResourceRecord,
  after: ResourceRecord,
  env: Env,
): ExecutableLifecycleAction {
  return {
    action: {
      actionId: lifecycleActionId("resource-rename", "rename-resource-content", target, source),
      kind: "rename-resource-content",
      target,
      payload: {
        source,
        resourceId: before.resourceId,
        currentRevisionId: before.currentRevision.id,
        newName: after.name,
      },
      postcondition: {
        state: "present",
        fingerprint: before.currentRevision.contentFingerprint,
      },
    },
    execute: () => env.fs.rename(source, target),
  };
}

function removePathAction(
  mutationKind: string,
  target: string,
  resourceId: string,
  env: Env,
): ExecutableLifecycleAction {
  return {
    action: {
      actionId: lifecycleActionId(mutationKind, "remove-resource-path", target, resourceId),
      kind: "remove-resource-path",
      target,
      payload: { resourceId },
      postcondition: { state: "absent" },
    },
    execute: () => env.fs.rm(target, { recursive: true, force: true }),
  };
}

function configPublishAction(
  mutationKind: string,
  storeRoot: string,
  config: CellarerConfig,
  env: Env,
): ExecutableLifecycleAction {
  const target = join(storeRoot, CONFIG_FILENAME);
  const data = `${JSON.stringify(parseConfigValue(config), null, 2)}\n`;
  const digest = sha256(data);
  return {
    action: {
      actionId: lifecycleActionId(mutationKind, "publish-file", target, digest),
      kind: "publish-file",
      target,
      payload: { path: target, digest, mode: 0o600 },
      postcondition: { state: "present", fingerprint: digest },
    },
    execute: () => env.fs.publishFileAtomically(target, data, { mode: 0o600 }),
  };
}

function profileRegistryPublishAction(
  mutationKind: string,
  storeRoot: string,
  profiles: readonly SyncProfile[],
  edits: readonly SyncProfileResourceCascadeEdit[],
  env: Env,
): ExecutableLifecycleAction {
  const target = syncProfilesPath(storeRoot);
  const data = serializeSyncProfileRegistry(profiles);
  const digest = sha256(data);
  return {
    action: {
      actionId: lifecycleActionId(mutationKind, "publish-file", target, digest),
      kind: "publish-file",
      target,
      payload: {
        path: target,
        digest,
        mode: 0o600,
        profileEdits: edits.map((edit) => ({ ...edit })),
      },
      postcondition: { state: "present", fingerprint: digest },
    },
    execute: () => env.fs.publishFileAtomically(target, data, { mode: 0o600 }),
  };
}

function exportWriteAction(
  target: string,
  bundle: PortableResourceBundle,
  serialized: string,
  env: Env,
): ExecutableLifecycleAction {
  const digest = sha256(serialized);
  return {
    action: {
      actionId: lifecycleActionId("resource-export", "write-resource-bundle", target, digest),
      kind: "write-resource-bundle",
      target,
      payload: {
        bundleDigest: bundle.bundleDigest,
        serializedDigest: digest,
        resourceId: bundle.manifest.resource.resourceId,
        mode: 0o600,
      },
      postcondition: { state: "present", fingerprint: digest },
    },
    execute: () => env.fs.publishFileAtomically(target, serialized, { mode: 0o600 }),
  };
}

function preserveBundleAction(
  target: string,
  state: Extract<TargetStateReceipt, { readonly state: "present" }>,
  bundleDigest: string,
): ExecutableLifecycleAction {
  return {
    action: {
      actionId: lifecycleActionId(
        "resource-bundle-import",
        "preserve-file",
        target,
        state.fingerprint,
      ),
      kind: "preserve-file",
      target,
      payload: { bundleDigest, serializedDigest: state.fingerprint },
      postcondition: state,
    },
    execute: async () => undefined,
  };
}

function createPortableBundle(
  env: Env,
  record: ResourceRecord,
  snapshot: SafeRecursiveSnapshot,
): PortableResourceBundle {
  const content = encodeContent(snapshot.tree.nodes);
  if (content.fingerprint !== record.currentRevision.contentFingerprint) {
    throw new ResourceLifecycleError(
      "RESOURCE_INTEGRITY_FAILED",
      "managed resource content no longer matches its current revision",
    );
  }
  validateContent(env, record.kind, record.name, content);
  const portableSource = portableSourceDescriptor(record.currentRevision.source);
  const portableRecord = createResourceRecord({
    resourceId: record.resourceId,
    kind: record.kind,
    name: record.name,
    contentFingerprint: content.fingerprint,
    validation: record.currentRevision.validation,
    source: portableSource,
  });
  const manifest: PortableBundleManifest = {
    format: BUNDLE_FORMAT,
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    resource: portableRecord,
    contentDigest: content.digest,
    secretRefs: uniqueSorted(
      discoverSecretReferences(contentTexts(content)).map(secretReferenceToken),
    ),
  };
  const bundleDigest = sha256(canonicalJson({ manifest, content }));
  const bundle = { manifest, content, bundleDigest };
  assertPortableBundleStrings(bundle);
  return deepFreeze(bundle);
}

function serializeBundle(bundle: PortableResourceBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

async function readAndValidateBundle(
  env: Env,
  bundlePath: string,
): Promise<PortableResourceBundle> {
  let raw: string;
  try {
    raw = await env.fs.readFile(bundlePath);
  } catch {
    throw new ResourceLifecycleError("INVALID_BUNDLE", "resource bundle is unavailable");
  }
  const structuredFindings = scanStructuredFileSecretFindings(bundlePath, raw);
  if (
    structuredFindings.some(
      (finding) => finding.rule === "duplicate-key" || finding.rule === "structured-parse-error",
    )
  ) {
    throw new ResourceLifecycleError("INVALID_BUNDLE", "resource bundle JSON is ambiguous");
  }
  if (
    scanTextForSecrets(raw).length > 0 ||
    containsObservableKnownValue(raw, observableKnownValues(env))
  ) {
    throw new ResourceLifecycleError(
      "BUNDLE_SECRET_BLOCKED",
      "resource bundle contains blocked plaintext secret-like content",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ResourceLifecycleError("INVALID_BUNDLE", "resource bundle is invalid JSON");
  }
  try {
    if (!hasExactKeys(value, ["bundleDigest", "content", "manifest"])) {
      throw new TypeError("bundle keys are invalid");
    }
    if (
      !hasExactKeys(value.manifest, [
        "contentDigest",
        "format",
        "resource",
        "schemaVersion",
        "secretRefs",
      ])
    ) {
      throw new TypeError("bundle manifest keys are invalid");
    }
    if (
      value.manifest.format !== BUNDLE_FORMAT ||
      value.manifest.schemaVersion !== BUNDLE_SCHEMA_VERSION ||
      typeof value.bundleDigest !== "string"
    ) {
      throw new TypeError("bundle version is invalid");
    }
    const resource = parseResourceRecord(value.manifest.resource);
    const content = parseEncodedContent(value.content);
    if (
      !Array.isArray(value.manifest.secretRefs) ||
      !value.manifest.secretRefs.every((reference) => typeof reference === "string")
    ) {
      throw new TypeError("bundle references are invalid");
    }
    const secretRefs = uniqueSorted(value.manifest.secretRefs as string[]);
    if (
      canonicalJson(secretRefs) !==
      canonicalJson(
        uniqueSorted(discoverSecretReferences(contentTexts(content)).map(secretReferenceToken)),
      )
    ) {
      throw new TypeError("bundle references do not match content");
    }
    if (
      value.manifest.contentDigest !== content.digest ||
      resource.currentRevision.contentFingerprint !== content.fingerprint
    ) {
      throw new TypeError("bundle content evidence is invalid");
    }
    const manifest: PortableBundleManifest = {
      format: BUNDLE_FORMAT,
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      resource,
      contentDigest: content.digest,
      secretRefs,
    };
    const expectedDigest = sha256(canonicalJson({ manifest, content }));
    if (value.bundleDigest !== expectedDigest) throw new TypeError("bundle digest is invalid");
    validateContent(env, resource.kind, resource.name, content);
    const bundle = { manifest, content, bundleDigest: expectedDigest };
    assertPortableBundleStrings(bundle);
    return deepFreeze(bundle);
  } catch (error) {
    if (error instanceof ResourceLifecycleError) throw error;
    throw new ResourceLifecycleError("INVALID_BUNDLE", "resource bundle validation failed");
  }
}

function encodeContent(nodes: readonly FileTreeSnapshotNode[]): EncodedResourceContent {
  if (nodes.length === 0 || nodes.length > 100_000)
    throw new TypeError("resource node budget exceeded");
  const paths = new Set<string>();
  const encoded = nodes.map((node): EncodedContentNode => {
    assertBundlePath(node.relativePath);
    if (paths.has(node.relativePath)) throw new TypeError("resource paths must be unique");
    paths.add(node.relativePath);
    if (!Number.isInteger(node.mode) || node.mode < 0 || node.mode > 0o7777) {
      throw new TypeError("resource mode is invalid");
    }
    if (node.kind === "directory") {
      if (node.data !== undefined) throw new TypeError("resource directory contains bytes");
      return { path: node.relativePath, kind: node.kind, mode: node.mode };
    }
    if (!node.data) throw new TypeError("resource file bytes are missing");
    return {
      path: node.relativePath,
      kind: node.kind,
      mode: node.mode,
      dataHex: bytesToHex(node.data),
      digest: sha256(node.data),
    };
  });
  encoded.sort((left, right) => left.path.localeCompare(right.path));
  const root = encoded.find((node) => node.path === "");
  if (!root) throw new TypeError("resource root is missing");
  for (const node of encoded) {
    if (!node.path) continue;
    const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
    if (!encoded.some((candidate) => candidate.path === parent && candidate.kind === "directory")) {
      throw new TypeError("resource parent directory is missing");
    }
  }
  const fingerprint =
    root.kind === "file"
      ? (root.digest ?? sha256(new Uint8Array()))
      : sha256(
          JSON.stringify(
            encoded.map((node) =>
              node.kind === "directory"
                ? { path: node.path, kind: node.kind, mode: node.mode }
                : { path: node.path, kind: node.kind, mode: node.mode, digest: node.digest },
            ),
          ),
        );
  const byteLength = encoded.reduce(
    (total, node) => total + (node.dataHex ? node.dataHex.length / 2 : 0),
    0,
  );
  if (byteLength > 224 * 1024 * 1024) throw new TypeError("resource byte budget exceeded");
  const evidence = { kind: root.kind, nodes: encoded, fingerprint, byteLength };
  return { ...evidence, digest: sha256(JSON.stringify(evidence)) };
}

function parseEncodedContent(value: unknown): EncodedResourceContent {
  if (!hasExactKeys(value, ["byteLength", "digest", "fingerprint", "kind", "nodes"])) {
    throw new TypeError("resource content keys are invalid");
  }
  if (
    (value.kind !== "file" && value.kind !== "directory") ||
    !Array.isArray(value.nodes) ||
    typeof value.fingerprint !== "string" ||
    typeof value.byteLength !== "number" ||
    typeof value.digest !== "string"
  ) {
    throw new TypeError("resource content is invalid");
  }
  const nodes: EncodedContentNode[] = value.nodes.map((node) => {
    if (!isRecord(node)) throw new TypeError("resource node is invalid");
    if (node.kind === "directory") {
      if (!hasExactKeys(node, ["kind", "mode", "path"]))
        throw new TypeError("resource node keys are invalid");
      if (typeof node.path !== "string" || typeof node.mode !== "number")
        throw new TypeError("resource node is invalid");
      return { path: node.path, kind: "directory", mode: node.mode };
    }
    if (
      !hasExactKeys(node, ["dataHex", "digest", "kind", "mode", "path"]) ||
      node.kind !== "file"
    ) {
      throw new TypeError("resource node keys are invalid");
    }
    if (
      typeof node.path !== "string" ||
      typeof node.mode !== "number" ||
      typeof node.dataHex !== "string" ||
      typeof node.digest !== "string"
    ) {
      throw new TypeError("resource node is invalid");
    }
    return {
      path: node.path,
      kind: "file",
      mode: node.mode,
      dataHex: node.dataHex,
      digest: node.digest,
    };
  });
  const reconstructed = encodeContent(
    nodes.map((node) => ({
      relativePath: node.path,
      kind: node.kind,
      mode: node.mode,
      identity: `bundle:${node.path}`,
      ...(node.kind === "file" ? { data: hexToBytes(node.dataHex ?? "") } : {}),
    })),
  );
  const parsed: EncodedResourceContent = {
    kind: value.kind,
    nodes,
    fingerprint: value.fingerprint,
    byteLength: value.byteLength,
    digest: value.digest,
  };
  if (canonicalJson(reconstructed) !== canonicalJson(parsed)) {
    throw new TypeError("resource content evidence is invalid");
  }
  return parsed;
}

function validateContent(
  env: Env,
  kind: ArtifactKind,
  name: string,
  content: EncodedResourceContent,
): void {
  const files = content.nodes.filter(
    (node): node is EncodedContentNode & { readonly dataHex: string; readonly digest: string } =>
      node.kind === "file" && typeof node.dataHex === "string" && typeof node.digest === "string",
  );
  if (kind === "skills") {
    if (content.kind !== "directory") throw new TypeError("Skill content must be a directory");
    const manifest = files.find((file) => file.path === "SKILL.md");
    if (!manifest) throw new TypeError("Skill content is missing SKILL.md");
    const text = decodeUtf8(manifest.dataHex);
    const manifestName = text
      .match(/^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]
      ?.trim();
    const description = text
      .match(/^---\r?\n[\s\S]*?^description:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]
      ?.trim();
    if (manifestName !== name || !description)
      throw new TypeError("Skill manifest identity is invalid");
  } else {
    if (content.kind !== "file" || files.length !== 1 || files[0]?.path !== "") {
      throw new TypeError("Rule and MCP content must be one regular file");
    }
    const text = decodeUtf8(files[0].dataHex);
    if (kind === "rules" && text.trim().length === 0) throw new TypeError("Rule content is empty");
    if (kind === "mcp") serverFromRaw(JSON.parse(text));
  }
  const knownEnvironmentValues = Object.entries(env.env).flatMap(([key, value]) =>
    value && isSensitiveSecretFieldName(key) ? [value] : [],
  );
  for (const file of files) {
    const text = decodeUtf8(file.dataHex);
    if (
      scanStructuredFileSecretFindings(file.path || name, text).length > 0 ||
      scanTextForSecrets(text).length > 0 ||
      containsObservableKnownValue(text, observableKnownValues(env)) ||
      knownEnvironmentValues.some((value) => value.length > 0 && text.includes(value))
    ) {
      throw new ResourceLifecycleError(
        "BUNDLE_SECRET_BLOCKED",
        "resource content contains blocked plaintext secret-like content",
      );
    }
  }
}

function contentTexts(content: EncodedResourceContent): string[] {
  return content.nodes.flatMap((node) =>
    node.kind === "file" && node.dataHex ? [decodeUtf8(node.dataHex)] : [],
  );
}

async function installEncodedContent(
  env: Env,
  content: EncodedResourceContent,
  target: string,
): Promise<void> {
  if (content.kind === "file") {
    const root = content.nodes.find((node) => node.path === "" && node.kind === "file");
    if (!root?.dataHex) throw new TypeError("resource file bytes are missing");
    await env.fs.mkdir(dirname(target), { recursive: true });
    await env.fs.publishFileAtomically(target, decodeUtf8(root.dataHex), { mode: root.mode });
    return;
  }
  const tree: FileTreeSnapshot = {
    rootPath: target,
    nodes: content.nodes.map((node) => ({
      relativePath: node.path,
      kind: node.kind,
      mode: node.mode,
      identity: `bundle:${node.path}:${node.digest ?? "directory"}`,
      ...(node.kind === "file" ? { data: hexToBytes(node.dataHex ?? "") } : {}),
    })),
  };
  const snapshot: SafeRecursiveSnapshot = {
    rootPath: target,
    kind: "directory",
    files: content.nodes.flatMap((node) =>
      node.kind === "file" && node.dataHex
        ? [
            {
              absolutePath: join(target, ...node.path.split("/")),
              relativePath: node.path,
              mode: node.mode,
              content: decodeUtf8(node.dataHex),
              data: hexToBytes(node.dataHex),
            },
          ]
        : [],
    ),
    directories: content.nodes.flatMap((node) =>
      node.kind === "directory" ? [{ relativePath: node.path, mode: node.mode }] : [],
    ),
    fingerprint: content.fingerprint,
    identity: sha256(content.digest),
    tree,
  };
  await installSafeRecursiveSnapshot(env, snapshot, target, false);
}

function forkContent(
  env: Env,
  record: ResourceRecord,
  snapshot: SafeRecursiveSnapshot,
  newName: string,
): EncodedResourceContent {
  if (record.kind !== "skills") return encodeContent(snapshot.tree.nodes);
  const nodes = snapshot.tree.nodes.map((node) => {
    if (node.kind !== "file" || node.relativePath !== "SKILL.md" || !node.data) return node;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(node.data);
    const replaced = text.replace(
      /(^---\r?\n[\s\S]*?^name:\s*)(["']?)[^"'\r\n]+\2(\s*$)/m,
      `$1${newName}$3`,
    );
    if (replaced === text)
      throw new ResourceLifecycleError(
        "INVALID_RESOURCE",
        "Skill manifest name cannot be forked safely",
      );
    return { ...node, data: new TextEncoder().encode(replaced) };
  });
  const content = encodeContent(nodes);
  validateContent(env, "skills", newName, content);
  return content;
}

function portableSourceDescriptor(source: ResourceSourceDescriptor): ResourceSourceDescriptor {
  const parsed = resourceSourceDescriptorSchema.parse(source);
  return parsed.type === "local-snapshot" ? { type: "local-snapshot" } : parsed;
}

async function exactResource(
  env: Env,
  storeRoot: string,
  resourceId: string,
): Promise<ExactResource> {
  assertResourceId(resourceId);
  const artifacts = (
    await Promise.all([
      listRuleArtifacts(env, storeRoot),
      listMcpArtifacts(env, storeRoot),
      listSkillArtifacts(env, storeRoot),
    ])
  ).flat();
  const matches = artifacts.filter((artifact) => artifact.id === resourceId);
  if (matches.length !== 1 || !matches[0]) {
    throw new ResourceLifecycleError("RESOURCE_NOT_FOUND", "exact resource ID was not found");
  }
  return { artifact: matches[0], record: await loadResourceRecord(env, storeRoot, matches[0]) };
}

async function resourceNameCollision(
  env: Env,
  storeRoot: string,
  kind: ArtifactKind,
  name: string,
  proposedResourceId: string,
  ignoredResourceId?: string,
): Promise<boolean> {
  const artifacts = (
    await Promise.all([
      listRuleArtifacts(env, storeRoot),
      listMcpArtifacts(env, storeRoot),
      listSkillArtifacts(env, storeRoot),
    ])
  ).flat();
  const inventoryCollision = artifacts.some(
    (artifact) =>
      artifact.id !== ignoredResourceId &&
      (artifact.id === proposedResourceId || (artifact.kind === kind && artifact.name === name)),
  );
  if (inventoryCollision) return true;

  const ignored = artifacts.find((artifact) => artifact.id === ignoredResourceId);
  const reusesIgnoredName = ignored?.kind === kind && ignored.name === name;
  const [contentState, metadataState, revisionState] = await Promise.all([
    targetState(env, resourceBasePath(storeRoot, kind, name)),
    targetState(env, resourceMetadataPath(storeRoot, kind, name)),
    targetState(env, resourceRevisionRootPath(storeRoot, proposedResourceId)),
  ]);
  return (
    (!reusesIgnoredName &&
      (contentState.state === "present" || metadataState.state === "present")) ||
    (proposedResourceId !== ignoredResourceId && revisionState.state === "present")
  );
}

function lifecycleResourceProvenancePaths(storeRoot: string, current: ExactResource): string[] {
  return uniqueSorted([
    current.artifact.sourcePath,
    resourceBasePath(storeRoot, current.record.kind, current.record.name),
    resourceMetadataPath(storeRoot, current.record.kind, current.record.name),
    join(storeRoot, CONFIG_FILENAME),
    join(storeRoot, "state.json"),
    syncProfilesPath(storeRoot),
  ]);
}

function resourceBasePath(storeRoot: string, kind: ArtifactKind, name: string): string {
  assertResourceName(name);
  return join(
    storeRoot,
    "store",
    kind,
    kind === "rules" ? `${name}.md` : kind === "mcp" ? `${name}.json` : name,
  );
}

function resourceRevisionRootPath(storeRoot: string, resourceId: string): string {
  assertResourceId(resourceId);
  const [kind, identity] = resourceId.split("/") as [ArtifactKind, string];
  return join(storeRoot, "store", kind, ".cellarer-revisions", identity);
}

function configWithoutResource(config: CellarerConfig, resourceId: string): CellarerConfig {
  const artifacts = { ...config.artifacts };
  delete artifacts[resourceId];
  return parseConfigValue({ ...config, artifacts });
}

function capabilitySnapshot(record: ResourceRecord): CanonicalJsonObject {
  return {
    resourceModelSchemaVersion: record.schemaVersion,
    resourceKind: record.kind,
  };
}

function renameBusinessInput(opts: ResourceRenameOptions): CanonicalJsonObject {
  return jsonObject({
    operation: "rename",
    resourceId: opts.resourceId,
    newName: opts.newName,
    mode: opts.mode,
  });
}

function removeBusinessInput(opts: ResourceRemoveOptions): CanonicalJsonObject {
  return jsonObject({
    operation: "remove",
    resourceId: opts.resourceId,
    cascade: opts.cascade,
  });
}

function exportBusinessInput(opts: ResourceExportOptions): CanonicalJsonObject {
  return { operation: "export", resourceId: opts.resourceId, bundlePath: opts.bundlePath };
}

function importBusinessInput(opts: ResourceBundleImportOptions): CanonicalJsonObject {
  return { operation: "bundle-import", bundlePath: opts.bundlePath };
}

function normalizeDependencyOptions<T extends ResourceDependencyOptions>(opts: T): T {
  const storeRoot = normalizeAbsolutePath(opts.storeRoot, "storeRoot");
  assertResourceId(opts.resourceId);
  return { ...opts, storeRoot, resourceId: opts.resourceId };
}

function normalizeRenameOptions(opts: ResourceRenameOptions): ResourceRenameOptions {
  const normalized = normalizeDependencyOptions(opts);
  assertResourceName(opts.newName);
  if (opts.mode !== "rename" && opts.mode !== "local-fork") {
    throw new ResourceLifecycleError("INVALID_INPUT", "rename mode is invalid");
  }
  return { ...normalized, newName: opts.newName, mode: opts.mode };
}

function normalizeRemoveOptions(opts: ResourceRemoveOptions): ResourceRemoveOptions {
  const normalized = normalizeDependencyOptions(opts);
  if (typeof opts.cascade !== "boolean") {
    throw new ResourceLifecycleError("INVALID_INPUT", "remove cascade must be explicit");
  }
  return { ...normalized, cascade: opts.cascade };
}

function normalizeExportOptions(opts: ResourceExportOptions): ResourceExportOptions {
  const storeRoot = normalizeAbsolutePath(opts.storeRoot, "storeRoot");
  const bundlePath = normalizeAbsolutePath(opts.bundlePath, "bundlePath");
  assertResourceId(opts.resourceId);
  return { storeRoot, resourceId: opts.resourceId, bundlePath };
}

function normalizeImportOptions(opts: ResourceBundleImportOptions): ResourceBundleImportOptions {
  return {
    storeRoot: normalizeAbsolutePath(opts.storeRoot, "storeRoot"),
    bundlePath: normalizeAbsolutePath(opts.bundlePath, "bundlePath"),
  };
}

function assertPortableBundleStrings(value: unknown, path = "$bundle"): void {
  if (typeof value === "string") {
    if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\")) {
      throw new ResourceLifecycleError("INVALID_BUNDLE", `${path} contains a machine-local path`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertPortableBundleStrings(item, `${path}[${index}]`);
    });
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (["journal", "journals", "ownership", "owners", "snapshot", "snapshots"].includes(key)) {
      throw new ResourceLifecycleError("INVALID_BUNDLE", `${path}.${key} is operational state`);
    }
    assertPortableBundleStrings(child, `${path}.${key}`);
  }
}

function assertBundlePath(path: string): void {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.endsWith("/") ||
    path
      .split("/")
      .some(
        (segment) => segment === "." || segment === ".." || (segment.length === 0 && path !== ""),
      )
  ) {
    throw new ResourceLifecycleError("INVALID_BUNDLE", "resource bundle contains an unsafe path");
  }
}

function assertResourceId(resourceId: string): void {
  if (
    !RESOURCE_ID_PATTERN.test(resourceId) ||
    resourceId.endsWith("/.") ||
    resourceId.endsWith("/..")
  ) {
    throw new ResourceLifecycleError(
      "INVALID_RESOURCE_ID",
      "resource ID must be exact and immutable",
    );
  }
}

function assertResourceName(name: string): void {
  if (!RESOURCE_NAME_PATTERN.test(name) || name === "." || name === "..") {
    throw new ResourceLifecycleError("INVALID_RESOURCE_NAME", "resource name is unsafe");
  }
}

function normalizeAbsolutePath(path: string, label: string): string {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new ResourceLifecycleError("INVALID_INPUT", `${label} must be absolute`);
  }
  return normalize(path);
}

function validationChecksFor(kind: ArtifactKind) {
  return kind === "skills"
    ? (["content-fingerprint", "manifest", "secret-scan"] as const)
    : (["content-fingerprint", "secret-scan"] as const);
}

function lifecycleActionId(kind: string, action: string, target: string, evidence: string): string {
  return sha256(JSON.stringify({ kind, action, target, evidence }));
}

function sameTargetReceipt(left: TargetStateReceipt, right: TargetStateReceipt): boolean {
  return (
    left.state === right.state &&
    (left.state === "absent" ||
      (right.state === "present" && left.fingerprint === right.fingerprint))
  );
}

function controlledIoCode(error: unknown): string | null {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" &&
    [
      "EACCES",
      "EDQUOT",
      "EFBIG",
      "EIO",
      "ENOSPC",
      "EPERM",
      "EROFS",
      "ESTALE",
      "ACTION_POSTCONDITION_FAILED",
    ].includes(code)
    ? code
    : null;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value))
    throw new TypeError("resource bytes are invalid");
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function decodeUtf8(dataHex: string): string {
  const bytes = hexToBytes(dataHex);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (bytesToHex(new TextEncoder().encode(text)) !== dataHex)
    throw new TypeError("resource bytes are not canonical UTF-8");
  return text;
}

function jsonObject(value: unknown): CanonicalJsonObject {
  return JSON.parse(JSON.stringify(value)) as CanonicalJsonObject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function projectLifecycle(built: BuiltLifecyclePlan): PlannedResourceLifecycle {
  return {
    plan: built.plan,
    blocked: built.blocked,
    resource: built.resource,
    ...(built.dependencyReport ? { dependencyReport: built.dependencyReport } : {}),
  };
}

function invalidApplied(plan: MutationPlan): AppliedResourceLifecycle {
  return { plan, resource: null, operation: invalidPlanResult() };
}

async function withAuthorityLease<T>(env: Env, task: () => Promise<T>): Promise<T> {
  const lease = await acquireCurrentMutationAuthorityLease(env).catch(() => null);
  if (!lease || !(await lease.isCurrent().catch(() => false))) {
    await lease?.release().catch(() => undefined);
    throw new TypeError("mutation authority is not current");
  }
  try {
    return await task();
  } finally {
    await lease.release();
  }
}
