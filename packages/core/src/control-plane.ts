import { ZodError } from "zod";
import {
  type CompatibilityMatrix,
  describeCompatibility,
  loadCompatibility,
} from "./adapters/compatibility.js";
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
import type { Scope } from "./model/index.js";
import type {
  AssertExact,
  ControlPlaneAgentDto,
  ControlPlaneAgentListDto,
  ControlPlaneAgentTarget,
  ControlPlaneResourceDto,
  ControlPlaneResourceListDto,
  ControlPlaneValidationIssue,
  ExactContract,
} from "./protocol/client-types.js";
import { listOperationReceipts, readOperationReceipt } from "./protocol/journal.js";
import type { OperationReceipt } from "./protocol/models.js";
import { readStoreRevision } from "./protocol/store-revision.js";
import {
  type ResourceCatalogCounts,
  type ResourceCatalogItem,
  type ResourceCatalogOptions,
  type ResourceState,
  resourceCatalog,
} from "./resources/catalog.js";
import type { CellarerConfig } from "./store/config.js";
import {
  loadConfig,
  packagedConfigText,
  parseConfigValue,
  parsePackagedConfigForSettings,
  projectPublicControlPlaneConfig,
} from "./store/config.js";
import { observeStoreConfigSnapshot } from "./store/snapshot.js";

export type {
  ControlPlaneAgentDto,
  ControlPlaneAgentListDto,
  ControlPlaneAgentTarget,
  ControlPlaneResourceDesiredUsage,
  ControlPlaneResourceDto,
  ControlPlaneResourceListDto,
  ControlPlaneResourceValidation,
  ControlPlaneValidationIssue,
} from "./protocol/client-types.js";

type ReadonlyProducer<Value> = { readonly [Key in keyof Value]: Value[Key] };

function readonlyProducer<Value>(value: Value): ReadonlyProducer<Value> {
  return value as ReadonlyProducer<Value>;
}

function readonlyList<Value>(values: Value[]): readonly Value[] {
  return values;
}

export interface ControlPlaneResourceQuery extends ResourceCatalogOptions {
  readonly states?: readonly ResourceState[];
  readonly sources?: readonly string[];
}

export interface ControlPlaneResourceDetailDto {
  readonly resource: ControlPlaneResourceDto | null;
  readonly warnings: readonly string[];
}

export interface ControlPlaneResourceDetailOptions extends ControlPlaneResourceQuery {
  readonly resourceId: string;
}

export interface ControlPlaneAgentOptions {
  readonly storeRoot: string;
  readonly scope: Scope;
  readonly dir?: string;
  readonly agents?: readonly string[];
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

async function listControlPlaneResourcesImplementation(env: Env, opts: ControlPlaneResourceQuery) {
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
  return readonlyProducer({
    generatedAt: catalog.generatedAt,
    resources: readonlyList(resources),
    counts: countResources(resources),
    warnings: readonlyList(catalog.warnings),
  });
}

export async function listControlPlaneResources(
  env: Env,
  opts: ControlPlaneResourceQuery,
): Promise<ControlPlaneResourceListDto> {
  return listControlPlaneResourcesImplementation(env, opts);
}

export type ControlPlaneResourceListProducerContract = AssertExact<
  ExactContract<
    Awaited<ReturnType<typeof listControlPlaneResourcesImplementation>>,
    ControlPlaneResourceListDto
  >
>;

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

async function listControlPlaneAgentsImplementation(env: Env, opts: ControlPlaneAgentOptions) {
  const [report, config, packaged, compatibility] = await Promise.all([
    doctor(env, { ...opts, agents: opts.agents ? [...opts.agents] : undefined }),
    loadConfig(env, opts.storeRoot),
    packagedConfigText(env).then(parsePackagedConfigForSettings),
    loadCompatibility(env),
  ]);
  const builtinIds = new Set(Object.keys(packaged.builtinAdapters));
  const agents = report.agents.map((agent) => agentDto(agent, config, builtinIds, compatibility));
  return readonlyProducer({
    storeRoot: opts.storeRoot,
    scope: opts.scope,
    ...(opts.dir ? { dir: opts.dir } : {}),
    agents: readonlyList(agents),
    warnings: readonlyList(report.warnings),
  });
}

export async function listControlPlaneAgents(
  env: Env,
  opts: ControlPlaneAgentOptions,
): Promise<ControlPlaneAgentListDto> {
  return listControlPlaneAgentsImplementation(env, opts);
}

function agentDto(
  agent: Awaited<ReturnType<typeof doctor>>["agents"][number],
  config: Awaited<ReturnType<typeof loadConfig>>,
  builtinIds: ReadonlySet<string>,
  compatibility: CompatibilityMatrix,
) {
  const detectionEvidence: { readonly root?: string } = agent.root ? { root: agent.root } : {};
  const adapterKind =
    builtinIds.has(agent.id) && !Object.hasOwn(config.customAdapters, agent.id)
      ? ("built-in" as const)
      : ("custom" as const);
  return readonlyProducer({
    id: agent.id,
    displayName: agent.displayName,
    adapterKind,
    supported: true as const,
    detected: agent.detected,
    configured:
      Object.hasOwn(config.adapterOverrides, agent.id) ||
      Object.hasOwn(config.customAdapters, agent.id),
    enabled: agent.enabled,
    detectionEvidence,
    compatibility: readonlyList(
      describeCompatibility(
        compatibility,
        adapterKind === "custom" ? "" : agent.id,
        agent.scope,
        config.adapterOverrides[agent.id],
      ).map((cell) =>
        readonlyProducer({
          ...cell,
          sources: readonlyList(cell.sources),
          prerequisites: readonlyList(cell.prerequisites),
        }),
      ),
    ),
    capabilities: readonlyList(agent.supportedCapabilities),
    capabilityScopes: readonlyProducer({
      rules: readonlyList(agent.capabilities.rules),
      mcp: readonlyList(agent.capabilities.mcp),
      skills: readonlyList(agent.capabilities.skills),
    }),
    targets: readonlyList(agentTargets(agent.scope, agent.paths)),
    validationIssues: readonlyList(
      [
        ...agent.warnings.map((message) => ({ path: agent.id, message })),
        ...agent.checks
          .filter((check) => check.status !== "ok")
          .map((check) => ({ path: check.path ?? check.id, message: check.message })),
      ].map((issue) => readonlyProducer(issue)),
    ),
  });
}

export type ControlPlaneAgentDtoProducerContract = AssertExact<
  ExactContract<ReturnType<typeof agentDto>, ControlPlaneAgentDto>
>;

export type ControlPlaneAgentListProducerContract = AssertExact<
  ExactContract<
    Awaited<ReturnType<typeof listControlPlaneAgentsImplementation>>,
    ControlPlaneAgentListDto
  >
>;

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
  const observation = await observeStoreConfigSnapshot(env, opts.storeRoot);
  if (!observation.ok) {
    throw Object.assign(
      new Error(`control-plane configuration observation failed: ${observation.error.code}`),
      observation.error,
    );
  }
  return {
    revision: observation.snapshot.revision,
    config: projectPublicControlPlaneConfig(observation.snapshot.configuration),
  };
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

function resourceDto(resource: ResourceCatalogItem, selectedCollections: readonly string[]) {
  const selected = resource.collections.filter((collection) =>
    selectedCollections.includes(collection),
  );
  const issues = resource.syncTargets
    .filter((target) => target.state !== "synced")
    .map((target) => validationIssue(target.target, target.reason ?? `target is ${target.state}`));
  if (resource.state === "blocked" && issues.length === 0) {
    issues.push(validationIssue(resource.id, "resource discovery is blocked"));
  }
  for (const finding of resource.discovered?.findings ?? []) {
    issues.push(
      validationIssue(finding.sourceId ?? resource.id, `${finding.code}: ${finding.remediation}`),
    );
  }
  const validationStatus: "valid" | "warning" | "invalid" =
    resource.state === "blocked" ? "invalid" : issues.length > 0 ? "warning" : "valid";
  const desiredUsage = selected.map((collection) => readonlyProducer({ collection }));
  return readonlyProducer({
    id: resource.id,
    kind: resource.kind,
    name: resource.name,
    source: resourceSource(resource),
    state: resource.state,
    ...(resource.currentRevision ? { currentRevision: resource.currentRevision } : {}),
    ...(resource.provenance ? { provenance: resource.provenance } : {}),
    ...(resource.discovered ? { discovered: resource.discovered } : {}),
    membership: readonlyProducer({ collections: readonlyList(resource.collections) }),
    selection: readonlyProducer({
      desired: selected.length > 0,
      collections: readonlyList(selected),
      ...(resource.discovered ? { inventoryDefault: resource.discovered.defaultSelected } : {}),
    }),
    validation: readonlyProducer({ status: validationStatus, issues: readonlyList(issues) }),
    secretReferenceNames: readonlyList(resource.secretRefs),
    usage: readonlyProducer({
      desired: readonlyList(desiredUsage),
      applied: readonlyList(resource.syncTargets),
    }),
    ...(resource.lastActivityAt ? { lastActivityAt: resource.lastActivityAt } : {}),
  });
}

export type ControlPlaneResourceDtoProducerContract = AssertExact<
  ExactContract<ReturnType<typeof resourceDto>, ControlPlaneResourceDto>
>;

function resourceSource(resource: ResourceCatalogItem): string {
  const provenance = resource.provenance;
  return (
    resource.discovered?.source ??
    (provenance?.type === "git" ? provenance.repositoryUrl : undefined) ??
    (provenance?.type === "url" ? provenance.url : undefined) ??
    (provenance?.type === "local-snapshot" ? provenance.capturedFrom : undefined) ??
    resource.sourcePath ??
    `store:${resource.id}`
  );
}

function countResources(resources: readonly ControlPlaneResourceDto[]) {
  const counts = {
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

export type ControlPlaneResourceCountsProducerContract = AssertExact<
  ExactContract<ReturnType<typeof countResources>, ResourceCatalogCounts>
>;

function agentTargets(
  scope: Scope,
  paths: { readonly rules?: string; readonly mcp?: string; readonly skillsDir?: string },
) {
  return [
    ...(paths.rules ? [agentTarget("rules", scope, paths.rules)] : []),
    ...(paths.mcp ? [agentTarget("mcp", scope, paths.mcp)] : []),
    ...(paths.skillsDir ? [agentTarget("skills", scope, paths.skillsDir)] : []),
  ];
}

function agentTarget(capability: "rules" | "mcp" | "skills", scope: Scope, path: string) {
  return readonlyProducer({ capability, scope, path });
}

export type ControlPlaneAgentTargetProducerContract = AssertExact<
  ExactContract<ReturnType<typeof agentTarget>, ControlPlaneAgentTarget>
>;

function validationIssue(path: string, message: string) {
  return readonlyProducer({ path, message });
}

export type ControlPlaneValidationIssueProducerContract = AssertExact<
  ExactContract<ReturnType<typeof validationIssue>, ControlPlaneValidationIssue>
>;

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

export type ClientSyncProfileContract = AssertExact<
  ExactContract<
    import("./sync/profiles.js").SyncProfile,
    import("./protocol/client-types.js").ClientSyncProfile
  >
>;
export type ClientSyncProfileDesiredContract = AssertExact<
  ExactContract<
    import("./sync/profiles.js").SyncProfileDesiredState,
    import("./protocol/client-types.js").ClientSyncProfileDesiredState
  >
>;
