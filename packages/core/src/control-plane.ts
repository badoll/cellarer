import { ZodError } from "zod";
import { dashboardSummary } from "./dashboard.js";
import { doctor } from "./diagnostics.js";
import { status } from "./engine/status.js";
import type { StatusOptions } from "./engine/types.js";
import {
  type DesiredAppliedItem,
  type VerificationOptions,
  type VerificationReport,
  verify,
} from "./engine/verification.js";
import type { Env } from "./env.js";
import type { Capability, Scope } from "./model/index.js";
import { listOperationReceipts, readOperationReceipt } from "./protocol/journal.js";
import type { OperationReceipt } from "./protocol/models.js";
import { readStoreRevision } from "./protocol/store-revision.js";
import {
  type ResourceCatalogCounts,
  type ResourceCatalogItem,
  type ResourceCatalogOptions,
  type ResourceState,
  type ResourceSyncTarget,
  resourceCatalog,
} from "./resources/catalog.js";
import {
  type DiscoverySummaryOptions,
  type DiscoverySummaryResult,
  discoverySummary,
} from "./resources/discovery.js";
import type { CellarerConfig } from "./store/config.js";
import {
  loadConfig,
  packagedConfigText,
  parseConfigValue,
  parsePackagedConfigForSettings,
  projectPublicControlPlaneConfig,
} from "./store/config.js";

export interface ControlPlaneValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ControlPlaneResourceValidation {
  readonly status: "valid" | "warning" | "invalid";
  readonly issues: readonly ControlPlaneValidationIssue[];
}

export interface ControlPlaneResourceDesiredUsage {
  readonly collection: string;
}

export interface ControlPlaneResourceDto {
  readonly id: string;
  readonly kind: Capability;
  readonly name: string;
  readonly source: string;
  readonly state: ResourceState;
  readonly provenance?: ResourceCatalogItem["provenance"];
  readonly discovered?: ResourceCatalogItem["discovered"];
  readonly membership: { readonly collections: readonly string[] };
  readonly selection: { readonly desired: boolean; readonly collections: readonly string[] };
  readonly validation: ControlPlaneResourceValidation;
  readonly secretReferenceNames: readonly string[];
  readonly usage: {
    readonly desired: readonly ControlPlaneResourceDesiredUsage[];
    readonly applied: readonly ResourceSyncTarget[];
  };
  readonly lastActivityAt?: string;
}

export interface ControlPlaneResourceQuery extends ResourceCatalogOptions {
  readonly states?: readonly ResourceState[];
  readonly sources?: readonly string[];
}

export interface ControlPlaneResourceListDto {
  readonly generatedAt: string;
  readonly resources: readonly ControlPlaneResourceDto[];
  readonly counts: ResourceCatalogCounts;
  readonly warnings: readonly string[];
}

export interface ControlPlaneResourceDetailDto {
  readonly resource: ControlPlaneResourceDto | null;
  readonly warnings: readonly string[];
}

export interface ControlPlaneResourceDetailOptions extends ControlPlaneResourceQuery {
  readonly resourceId: string;
}

export interface ControlPlaneAgentTarget {
  readonly capability: Capability;
  readonly scope: Scope;
  readonly path: string;
}

export interface ControlPlaneAgentDto {
  readonly id: string;
  readonly displayName: string;
  readonly adapterKind: "built-in" | "custom";
  readonly supported: true;
  readonly detected: boolean;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly detectionEvidence: { readonly root?: string };
  readonly capabilities: readonly Capability[];
  readonly capabilityScopes: Readonly<Record<Capability, readonly Scope[]>>;
  readonly targets: readonly ControlPlaneAgentTarget[];
  readonly validationIssues: readonly ControlPlaneValidationIssue[];
}

export interface ControlPlaneAgentOptions {
  readonly storeRoot: string;
  readonly scope: Scope;
  readonly dir?: string;
  readonly agents?: readonly string[];
}

export interface ControlPlaneAgentListDto {
  readonly storeRoot: string;
  readonly scope: Scope;
  readonly dir?: string;
  readonly agents: readonly ControlPlaneAgentDto[];
  readonly warnings: readonly string[];
}

export interface ControlPlaneAgentDetailOptions extends ControlPlaneAgentOptions {
  readonly agentId: string;
}

export interface ControlPlaneAgentDetailDto {
  readonly agent: ControlPlaneAgentDto | null;
  readonly warnings: readonly string[];
}

export interface ControlPlaneCollectionDto {
  readonly name: string;
  readonly description?: string;
  readonly isDefault: boolean;
  readonly resourceIds: readonly string[];
}

export interface ControlPlaneCollectionListDto {
  readonly revision: number;
  readonly collections: readonly ControlPlaneCollectionDto[];
}

export interface ControlPlaneCollectionDetailDto {
  readonly revision: number;
  readonly collection: ControlPlaneCollectionDto | null;
}

export interface ControlPlaneStoreOptions {
  readonly storeRoot: string;
}

export interface ControlPlaneCollectionDetailOptions extends ControlPlaneStoreOptions {
  readonly collectionName: string;
}

export interface ControlPlaneConfigDto {
  readonly revision: number;
  readonly config: CellarerConfig;
}

export type ControlPlaneConfigValidationDto =
  | { readonly valid: true; readonly config: CellarerConfig; readonly issues: readonly [] }
  | {
      readonly valid: false;
      readonly issues: readonly ControlPlaneValidationIssue[];
    };

export interface ControlPlaneDiffDto {
  readonly storeRevision: number;
  readonly status: "converged" | "diverged";
  readonly items: readonly DesiredAppliedItem[];
}

export interface ControlPlaneStatusDto {
  readonly generatedAt: string;
  readonly items: Awaited<ReturnType<typeof status>>;
}

export type ControlPlaneVerifyDto = VerificationReport;
export type ControlPlaneSummaryDto = Awaited<ReturnType<typeof dashboardSummary>>;
export type ControlPlaneDiscoverySummaryDto = DiscoverySummaryResult;

export interface ControlPlaneOperationSummaryDto {
  readonly operationId: string;
  readonly planId: string;
  readonly operation: OperationReceipt["operation"];
  readonly baseRevision: number;
  readonly resultingRevision: number;
  readonly outcome: OperationReceipt["outcome"];
  readonly actionCount: number;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface ControlPlaneOperationListOptions extends ControlPlaneStoreOptions {
  readonly limit?: number;
}

export interface ControlPlaneOperationListDto {
  readonly operations: readonly ControlPlaneOperationSummaryDto[];
}

export interface ControlPlaneOperationDetailOptions extends ControlPlaneStoreOptions {
  readonly operationId: string;
}

export interface ControlPlaneOperationDetailDto {
  readonly operation:
    | (OperationReceipt & {
        readonly recoveryStatus: "clean" | "manual-recovery-required";
      })
    | null;
}

export async function listControlPlaneResources(
  env: Env,
  opts: ControlPlaneResourceQuery,
): Promise<ControlPlaneResourceListDto> {
  const [catalog, config] = await Promise.all([
    resourceCatalog(env, opts),
    loadConfig(env, opts.storeRoot),
  ]);
  const selectedCollections = opts.collections?.length
    ? [...opts.collections]
    : config.defaults.collections;
  const resources = catalog.resources
    .map((resource) => resourceDto(resource, selectedCollections))
    .filter((resource) => !opts.states?.length || matchesResourceState(resource, opts.states))
    .filter((resource) => !opts.sources?.length || opts.sources.includes(resource.source));
  return {
    generatedAt: catalog.generatedAt,
    resources,
    counts: countResources(resources),
    warnings: catalog.warnings,
  };
}

function matchesResourceState(
  resource: ControlPlaneResourceDto,
  states: readonly ResourceState[],
): boolean {
  return (
    states.includes(resource.state) ||
    resource.usage.applied.some((target) => states.includes(target.state))
  );
}

export async function showControlPlaneResource(
  env: Env,
  opts: ControlPlaneResourceDetailOptions,
): Promise<ControlPlaneResourceDetailDto> {
  const { resourceId, ...query } = opts;
  const result = await listControlPlaneResources(env, query);
  return {
    resource: result.resources.find((resource) => resource.id === resourceId) ?? null,
    warnings: result.warnings,
  };
}

export async function listControlPlaneAgents(
  env: Env,
  opts: ControlPlaneAgentOptions,
): Promise<ControlPlaneAgentListDto> {
  const [report, config, packaged] = await Promise.all([
    doctor(env, { ...opts, agents: opts.agents ? [...opts.agents] : undefined }),
    loadConfig(env, opts.storeRoot),
    packagedConfigText(env).then(parsePackagedConfigForSettings),
  ]);
  const builtinIds = new Set(Object.keys(packaged.builtinAdapters));
  return {
    storeRoot: opts.storeRoot,
    scope: opts.scope,
    ...(opts.dir ? { dir: opts.dir } : {}),
    agents: report.agents.map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      adapterKind: builtinIds.has(agent.id) ? "built-in" : "custom",
      supported: true,
      detected: agent.detected,
      configured:
        Object.hasOwn(config.adapterOverrides, agent.id) ||
        Object.hasOwn(config.customAdapters, agent.id),
      enabled: agent.enabled,
      detectionEvidence: agent.root ? { root: agent.root } : {},
      capabilities: agent.supportedCapabilities,
      capabilityScopes: agent.capabilities,
      targets: agentTargets(agent.scope, agent.paths),
      validationIssues: [
        ...agent.warnings.map((message) => ({ path: agent.id, message })),
        ...agent.checks
          .filter((check) => check.status !== "ok")
          .map((check) => ({ path: check.path ?? check.id, message: check.message })),
      ],
    })),
    warnings: report.warnings,
  };
}

export async function showControlPlaneAgent(
  env: Env,
  opts: ControlPlaneAgentDetailOptions,
): Promise<ControlPlaneAgentDetailDto> {
  const { agentId, ...query } = opts;
  const result = await listControlPlaneAgents(env, { ...query, agents: [agentId] });
  return {
    agent: result.agents.find((agent) => agent.id === agentId) ?? null,
    warnings: result.warnings,
  };
}

export async function listControlPlaneCollections(
  env: Env,
  opts: ControlPlaneStoreOptions,
): Promise<ControlPlaneCollectionListDto> {
  const [config, revision] = await Promise.all([
    loadConfig(env, opts.storeRoot),
    readStoreRevision(env, opts.storeRoot),
  ]);
  return { revision, collections: collectionDtos(config) };
}

export async function showControlPlaneCollection(
  env: Env,
  opts: ControlPlaneCollectionDetailOptions,
): Promise<ControlPlaneCollectionDetailDto> {
  const result = await listControlPlaneCollections(env, opts);
  return {
    revision: result.revision,
    collection:
      result.collections.find((collection) => collection.name === opts.collectionName) ?? null,
  };
}

export async function showControlPlaneConfig(
  env: Env,
  opts: ControlPlaneStoreOptions,
): Promise<ControlPlaneConfigDto> {
  const [config, revision] = await Promise.all([
    loadConfig(env, opts.storeRoot),
    readStoreRevision(env, opts.storeRoot),
  ]);
  return { revision, config: projectPublicControlPlaneConfig(config) };
}

export function validateControlPlaneConfig(input: unknown): ControlPlaneConfigValidationDto {
  try {
    const config = projectPublicControlPlaneConfig(parseConfigValue(input));
    return { valid: true, config, issues: [] };
  } catch (error) {
    if (!(error instanceof ZodError)) {
      return { valid: false, issues: [{ path: "$", message: errorMessage(error) }] };
    }
    return { valid: false, issues: zodIssues(error) };
  }
}

export async function diffControlPlane(
  env: Env,
  opts: VerificationOptions,
): Promise<ControlPlaneDiffDto> {
  const report = await verify(env, opts);
  return {
    storeRevision: report.storeRevision,
    status: report.desiredVsApplied.status,
    items: report.desiredVsApplied.items,
  };
}

export async function statusControlPlane(
  env: Env,
  opts: StatusOptions,
): Promise<ControlPlaneStatusDto> {
  return { generatedAt: env.now().toISOString(), items: await status(env, opts) };
}

export function verifyControlPlane(
  env: Env,
  opts: VerificationOptions,
): Promise<ControlPlaneVerifyDto> {
  return verify(env, opts);
}

export function summaryControlPlane(
  env: Env,
  opts: Parameters<typeof dashboardSummary>[1],
): Promise<ControlPlaneSummaryDto> {
  return dashboardSummary(env, opts);
}

export function discoverySummaryControlPlane(
  env: Env,
  opts: DiscoverySummaryOptions,
): Promise<ControlPlaneDiscoverySummaryDto> {
  return discoverySummary(env, opts);
}

export async function listControlPlaneOperations(
  env: Env,
  opts: ControlPlaneOperationListOptions,
): Promise<ControlPlaneOperationListDto> {
  const receipts = await listOperationReceipts(env, opts.storeRoot);
  const selected = opts.limit === undefined ? receipts : receipts.slice(0, opts.limit);
  return { operations: selected.map(operationSummary) };
}

export async function showControlPlaneOperation(
  env: Env,
  opts: ControlPlaneOperationDetailOptions,
): Promise<ControlPlaneOperationDetailDto> {
  const receipt = await readOperationReceipt(env, opts.storeRoot, opts.operationId);
  return {
    operation: receipt
      ? {
          ...receipt,
          recoveryStatus:
            receipt.outcome === "manual-recovery-required" ? "manual-recovery-required" : "clean",
        }
      : null,
  };
}

function resourceDto(
  resource: ResourceCatalogItem,
  selectedCollections: readonly string[],
): ControlPlaneResourceDto {
  const selected = resource.collections.filter((collection) =>
    selectedCollections.includes(collection),
  );
  const issues: ControlPlaneValidationIssue[] = resource.syncTargets
    .filter((target) => target.state !== "synced")
    .map((target) => ({
      path: target.target,
      message: target.reason ?? `target is ${target.state}`,
    }));
  if (resource.state === "blocked" && issues.length === 0) {
    issues.push({ path: resource.id, message: "resource discovery is blocked" });
  }
  const validationStatus =
    resource.state === "blocked" ? "invalid" : issues.length > 0 ? "warning" : "valid";
  return {
    id: resource.id,
    kind: resource.kind,
    name: resource.name,
    source: resourceSource(resource),
    state: resource.state,
    ...(resource.provenance ? { provenance: resource.provenance } : {}),
    ...(resource.discovered ? { discovered: resource.discovered } : {}),
    membership: { collections: resource.collections },
    selection: { desired: selected.length > 0, collections: selected },
    validation: { status: validationStatus, issues },
    secretReferenceNames: resource.secretRefs,
    usage: {
      desired: selected.map((collection) => ({ collection })),
      applied: resource.syncTargets,
    },
    ...(resource.lastActivityAt ? { lastActivityAt: resource.lastActivityAt } : {}),
  };
}

function resourceSource(resource: ResourceCatalogItem): string {
  return (
    resource.discovered?.source ??
    resource.provenance?.resolvedUrl ??
    resource.provenance?.source ??
    resource.sourcePath ??
    `store:${resource.id}`
  );
}

function countResources(resources: readonly ControlPlaneResourceDto[]): ResourceCatalogCounts {
  const counts: ResourceCatalogCounts = {
    managed: 0,
    discovered: 0,
    synced: 0,
    drifted: 0,
    missing: 0,
    blocked: 0,
  };
  for (const resource of resources) {
    counts[resource.state] += 1;
    for (const target of resource.usage.applied) counts[target.state] += 1;
  }
  return counts;
}

function agentTargets(
  scope: Scope,
  paths: { readonly rules?: string; readonly mcp?: string; readonly skillsDir?: string },
): ControlPlaneAgentTarget[] {
  return [
    ...(paths.rules ? [{ capability: "rules" as const, scope, path: paths.rules }] : []),
    ...(paths.mcp ? [{ capability: "mcp" as const, scope, path: paths.mcp }] : []),
    ...(paths.skillsDir ? [{ capability: "skills" as const, scope, path: paths.skillsDir }] : []),
  ];
}

function collectionDtos(config: CellarerConfig): ControlPlaneCollectionDto[] {
  const names = new Set([
    ...Object.keys(config.collections),
    ...config.defaults.collections,
    ...Object.values(config.artifacts).flatMap((artifact) => artifact.collections),
  ]);
  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      name,
      ...(config.collections[name]?.description
        ? { description: config.collections[name]?.description }
        : {}),
      isDefault: config.defaults.collections.includes(name),
      resourceIds: Object.entries(config.artifacts)
        .filter(([, artifact]) => artifact.collections.includes(name))
        .map(([resourceId]) => resourceId)
        .sort((left, right) => left.localeCompare(right)),
    }));
}

function operationSummary(receipt: OperationReceipt): ControlPlaneOperationSummaryDto {
  return {
    operationId: receipt.operationId,
    planId: receipt.planId,
    operation: receipt.operation,
    baseRevision: receipt.baseRevision,
    resultingRevision: receipt.resultingRevision,
    outcome: receipt.outcome,
    actionCount: receipt.actionReceipts.length,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
  };
}

function zodIssues(error: ZodError): ControlPlaneValidationIssue[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        path: [...issue.path, key].map(String).join(".") || "$",
        message: issue.message,
      }));
    }
    return [{ path: issue.path.map(String).join(".") || "$", message: issue.message }];
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
