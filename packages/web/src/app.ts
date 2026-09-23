// @cellarer/web —— 内嵌 Hono server,把 @cellarer/core 暴露为本地 HTTP(Hono RPC 端到端类型)。
// 安全约束:
//   - 仅监听 127.0.0.1(见 server.ts)，并强制显式组合 bearer 或 browser-session 认证。
//   - 密钥不明文回显:web 一律以 secretMode="env" 调 core —— 即便 vault 模式也绝不在 HTTP 响应里解出真值;
//     plan 的 preview 在 env 模式下只含 ${ENV} 占位,secret-scan 护栏命中还会清空 preview。
//   - core-first(不变量 1):路由只解析参数 + 调 core,不写业务逻辑。
import {
  type ActivityAction,
  AGENT_ID_PATTERN,
  type AppliedInventorySecretAdoption,
  applyControlPlaneMutationPlan,
  applyDeploymentBaselinePlan,
  applyInventorySecretAdoptionPlan,
  applyInventoryStoreImportPlan,
  applyMutationPlan,
  applyResourceBundleImportPlan,
  applyResourceExportPlan,
  applyResourceRemovePlan,
  applyResourceRenamePlan,
  applyResourceUpdatePlan,
  applyRevertMutationPlan,
  applySyncProfileMutationPlan,
  applySyncProfilePlan,
  applySyncProfileUninstallPlan,
  type Capability,
  CLIENT_API_CONTRACT_ID,
  CLIENT_API_MAX_REQUEST_BODY_BYTES,
  CLIENT_API_VERSION,
  ControlPlaneValidationError,
  checkResourceUpdate,
  clientErrorFromMutationConflict,
  clientFailure,
  clientSuccess,
  createSafeObservableKnownValueSource,
  createSyncProfile,
  type Destination,
  deleteSyncProfile,
  diagnoseMutationRecovery,
  diffControlPlane,
  type Env,
  getClientReadiness,
  InventorySecretAdoptionPlanningError,
  type InventorySecretFieldSelector,
  InventoryStoreImportPlanningError,
  listActivity,
  listControlPlaneAgents,
  listControlPlaneCollections,
  listControlPlaneOperations,
  listControlPlaneResources,
  listSyncProfiles,
  type MutationConflict,
  type MutationPlan,
  mutateAgentAdapter,
  mutateBuiltinAgent,
  mutateCollection,
  mutateControlPlaneSettings,
  mutateCustomAdapter,
  type PlannedControlPlaneMutationDto,
  type PlannedInventorySecretAdoption,
  parseAgentAdapterMutationBody,
  parseAgentEnabledMutationBody,
  parseCollectionCreateMutationBody,
  parseCollectionDefaultsMutationBody,
  parseCollectionMembersMutationBody,
  parseCollectionUpdateMutationBody,
  parseControlPlaneSettingsMutationBody,
  planApplyMutation,
  planAvailableResourceUpdate,
  planDeploymentBaseline,
  planInventorySecretAdoption,
  planInventoryStoreImport,
  planResourceBundleImport,
  planResourceExport,
  planResourceRemove,
  planResourceRename,
  planRevertMutation,
  planSyncProfile,
  planSyncProfileUninstall,
  recoverInterruptedOperation,
  refreshInventory,
  resolveClientRequestId,
  resourceDependencyReport,
  type Scope,
  StoreMutationConflictError,
  type SyncProfileDesiredState,
  serializeSafeWebObservable,
  settingsSummary,
  showControlPlaneAgent,
  showControlPlaneCollection,
  showControlPlaneConfig,
  showControlPlaneOperation,
  showSyncProfile,
  statusControlPlane,
  summaryControlPlane,
  updateSyncProfile,
  VerificationInputError,
  validateControlPlaneConfig,
  validateResourceBundle,
  verifyControlPlane,
  verifySyncProfile,
} from "@cellarer/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { CLIENT_API_ROUTES, createClientOpenApiDocument } from "./api-contract.js";
import { hostGuard, safeEqual } from "./security.js";

export interface AppDeps {
  env: Env;
  storeRoot: string;
  auth: AppAuthentication;
  inventorySecretAdoption?: InventorySecretAdoptionService;
}

export interface InventorySecretAdoptionService {
  plan(input: InventorySecretAdoptionPlanBody): Promise<PlannedInventorySecretAdoption>;
  apply(mutationPlan: MutationPlan): Promise<AppliedInventorySecretAdoption>;
}

export type AppAuthentication =
  | { readonly mode: "trusted-embedded" }
  | { readonly mode: "bearer"; readonly token: string }
  | { readonly mode: "browser-session"; readonly sessionId: string };

const AGENT_ID_RE = new RegExp(AGENT_ID_PATTERN);

// 解析下发请求体(web → core DistributeOptions 子集)。
interface DistributeBody {
  agents?: string[];
  scope?: Scope;
  dir?: string;
  collections?: string[];
  capabilities?: Capability[];
  method?: "symlink" | "copy";
  mcpStrategy?: "merge" | "overwrite";
  replaceUnowned?: string[];
  overrideDrift?: string[];
  snapshotPassphrase?: string;
}

interface SyncBody {
  agents?: string[];
  destination?: Destination;
  dir?: string;
  resources?: {
    ids?: string[];
    kinds?: Capability[];
    collections?: string[];
  };
  method?: "symlink" | "copy";
  mcpStrategy?: "merge" | "overwrite";
  replaceUnowned?: string[];
  overrideDrift?: string[];
  snapshotPassphrase?: string;
}

interface RevertBody {
  scope?: Scope;
  dir?: string;
  agents?: string[];
  artifactIds?: string[];
  acknowledgements?: string[];
  snapshotPassphrase?: string;
  keepBackups?: boolean;
  dryRun?: boolean;
}

interface RevertPlanApplyBody extends RevertBody {
  mutationPlan: MutationPlan;
}

interface RecoveryApplyBody {
  operationId: string;
  snapshotPassphrase?: string;
}

interface ResourceIdBody {
  resourceId: string;
}

interface ResourceRenameBody extends ResourceIdBody {
  newName: string;
  mode: "rename" | "local-fork";
  mutationPlan?: MutationPlan;
  dryRun?: boolean;
}

interface ResourceRemoveBody extends ResourceIdBody {
  cascade: boolean;
  mutationPlan?: MutationPlan;
  dryRun?: boolean;
}

interface ResourceExportBody extends ResourceIdBody {
  bundlePath: string;
  mutationPlan?: MutationPlan;
  dryRun?: boolean;
}

interface ResourceBundleBody {
  bundlePath: string;
  mutationPlan?: MutationPlan;
  dryRun?: boolean;
}

interface ResourceUpdateApplyBody {
  mutationPlan: MutationPlan;
}

interface ResourceRenameApplyBody extends ResourceRenameBody {
  mutationPlan: MutationPlan;
}

interface ResourceRemoveApplyBody extends ResourceRemoveBody {
  mutationPlan: MutationPlan;
}

interface ResourceExportApplyBody extends ResourceExportBody {
  mutationPlan: MutationPlan;
}

interface ResourceBundleApplyBody extends ResourceBundleBody {
  mutationPlan: MutationPlan;
}

interface ProfileInvocationBody {
  workspaceRoot?: string;
  replaceUnowned?: string[];
  overrideDrift?: string[];
  snapshotPassphrase?: string;
}

interface ProfileApplyBody extends ProfileInvocationBody {
  mutationPlan: MutationPlan;
}

interface ProfileUninstallBody extends ProfileInvocationBody {
  mutationPlan?: MutationPlan;
  acknowledgements?: string[];
  dryRun?: boolean;
}

interface ProfileUninstallApplyBody extends ProfileInvocationBody {
  mutationPlan: MutationPlan;
  targetKeys: string[];
  acknowledgements?: string[];
}

interface ControlPlanePlanApplyBody {
  mutationPlan: MutationPlan;
}

interface SyncPlanApplyBody {
  mutationPlan: MutationPlan;
}

interface InventoryStoreImportPlanBody {
  candidateIds: string[];
  agentId?: string;
  dir?: string;
  intoCollection?: string;
}

interface InventoryStoreImportApplyBody {
  mutationPlan: MutationPlan;
}

interface InventorySecretAdoptionPlanBody {
  candidateId: string;
  selector: InventorySecretFieldSelector;
  provider: "vault" | "keychain";
  agentId?: string;
  dir?: string;
}

interface InventorySecretAdoptionApplyBody {
  mutationPlan: MutationPlan;
}

type AgentPlanBody =
  | { action: "set-enabled"; agentId: string; enabled: boolean }
  | { action: "upsert-adapter"; agentId: string; kind: "builtin" | "custom"; adapter: unknown }
  | { action: "remove-adapter"; agentId: string };

interface SettingsPlanBody {
  settings: unknown;
}

type ProfilePlanBody =
  | { action: "create" | "update"; profileId: string; desired: SyncProfileDesiredState }
  | { action: "delete"; profileId: string };

interface ProfileMutationApplyBody {
  mutationPlan: MutationPlan;
}

interface CollectionPlanBody {
  action: "create" | "update" | "delete" | "set-members" | "set-defaults";
  collectionName?: string;
  description?: string;
  resourceIds?: string[];
  collectionNames?: string[];
}

class ClientApiInputError extends Error {
  constructor(
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ClientApiInputError";
  }
}

async function parseJsonBody<T>(parse: () => Promise<T>): Promise<T> {
  try {
    return await parse();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ClientApiInputError("request body is not valid JSON", { fields: ["body"] });
    }
    throw error;
  }
}

function parseInventoryDir(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.length === 0) {
    throw new ClientApiInputError("Inventory project root is invalid", { fields: ["dir"] });
  }
  return raw;
}

function parseInventoryAgentId(raw: string): string {
  if (!AGENT_ID_RE.test(raw)) {
    throw new ClientApiInputError("Inventory agent ID is invalid", { fields: ["agentId"] });
  }
  return raw;
}

function parseInventoryImportCandidateIds(raw: unknown): string[] {
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.some((candidateId) => typeof candidateId !== "string" || candidateId.length === 0)
  ) {
    throw new ClientApiInputError("Inventory candidate IDs are invalid", {
      fields: ["candidateIds"],
    });
  }
  return raw as string[];
}

function parseInventorySecretAdoptionPlanBody(raw: unknown): InventorySecretAdoptionPlanBody {
  const body = exactObject(raw, ["candidateId", "selector", "provider", "agentId", "dir"]);
  if (typeof body.candidateId !== "string" || body.candidateId.length === 0) {
    throw new ClientApiInputError("Inventory candidate ID is invalid", {
      fields: ["candidateId"],
    });
  }
  const selector = parseInventorySecretFieldSelector(body.selector);
  if (body.provider !== "vault" && body.provider !== "keychain") {
    throw new ClientApiInputError("Inventory adoption provider is invalid", {
      fields: ["provider"],
    });
  }
  const agentId =
    body.agentId === undefined
      ? undefined
      : typeof body.agentId === "string"
        ? parseInventoryAgentId(body.agentId)
        : (() => {
            throw new ClientApiInputError("Inventory agent ID is invalid", {
              fields: ["agentId"],
            });
          })();
  const dir =
    body.dir === undefined
      ? undefined
      : typeof body.dir === "string"
        ? parseInventoryDir(body.dir)
        : (() => {
            throw new ClientApiInputError("Inventory project root is invalid", {
              fields: ["dir"],
            });
          })();
  return {
    candidateId: body.candidateId,
    selector,
    provider: body.provider,
    ...(agentId ? { agentId } : {}),
    ...(dir ? { dir } : {}),
  };
}

function parseInventorySecretAdoptionApplyBody(raw: unknown): InventorySecretAdoptionApplyBody {
  const body = exactObject(raw, ["mutationPlan"]);
  if (typeof body.mutationPlan !== "object" || body.mutationPlan === null) {
    throw new ClientApiInputError("Inventory adoption plan is invalid", {
      fields: ["mutationPlan"],
    });
  }
  return { mutationPlan: body.mutationPlan as MutationPlan };
}

function parseInventorySecretFieldSelector(raw: unknown): InventorySecretFieldSelector {
  const kind =
    typeof raw === "object" && raw !== null && "kind" in raw
      ? (raw as { readonly kind?: unknown }).kind
      : undefined;
  const selector = exactObject(
    raw,
    kind === "argument" ? ["kind", "server", "name", "index", "style"] : ["kind", "server", "name"],
  );
  if (
    typeof selector.server !== "string" ||
    selector.server.length === 0 ||
    typeof selector.name !== "string" ||
    selector.name.length === 0
  ) {
    throw new ClientApiInputError("Inventory adoption selector is invalid", {
      fields: ["selector"],
    });
  }
  if (["environment", "header", "url-query"].includes(String(selector.kind))) {
    return {
      kind: selector.kind as "environment" | "header" | "url-query",
      server: selector.server,
      name: selector.name,
    };
  }
  if (
    selector.kind === "argument" &&
    typeof selector.index === "number" &&
    Number.isSafeInteger(selector.index) &&
    selector.index >= 0 &&
    (selector.style === "assignment" || selector.style === "value")
  ) {
    return {
      kind: "argument",
      server: selector.server,
      name: selector.name,
      index: selector.index,
      style: selector.style,
    };
  }
  throw new ClientApiInputError("Inventory adoption selector is invalid", {
    fields: ["selector"],
  });
}

function exactObject(raw: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ClientApiInputError("request body must be an object", { fields: ["body"] });
  }
  const record = raw as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length > 0) {
    throw new ClientApiInputError("request body has unsupported fields", {
      fields: unexpected.sort(),
    });
  }
  return record;
}

// project scope 必须带 dir,否则 core 会以 server cwd 为工程根,把文件写进进程启动目录(且无 .gitignore 守护)。
// Project-scoped routes require an explicit root so writes cannot fall back to the server cwd.
function requireDirForProject(scope: Scope | undefined, dir: string | undefined): void {
  if ((scope ?? "global") === "project" && !dir) {
    throw new ClientApiInputError('scope "project" requires "dir"', { fields: ["dir"] });
  }
}

function parseDestination(raw: string | undefined): Destination | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "user" || raw === "project") return raw;
  throw new ClientApiInputError("destination is invalid", { fields: ["destination"] });
}

function scopeForDestination(destination: string | undefined): Scope {
  const parsed = parseDestination(destination);
  return parsed === "project" ? "project" : "global";
}

function requireDirForDestination(destination: string | undefined, dir: string | undefined): void {
  if (parseDestination(destination) === "project" && !dir) {
    throw new ClientApiInputError('destination "project" requires "dir"', { fields: ["dir"] });
  }
}

function distributeOpts(deps: AppDeps, b: DistributeBody) {
  requireDirForProject(b.scope, b.dir);
  return {
    storeRoot: deps.storeRoot,
    scope: (b.scope ?? "global") as Scope,
    dir: b.dir,
    agents: b.agents ?? [],
    collections: b.collections,
    capabilities: b.capabilities,
    method: b.method,
    mcpStrategy: b.mcpStrategy,
    replaceUnowned: b.replaceUnowned,
    overrideDrift: b.overrideDrift,
    snapshotPassphrase: b.snapshotPassphrase,
    // 安全红线:web 永远 env 模式,绝不在 HTTP 路径解出真值。
    secretMode: "env" as const,
  };
}

function revertOpts(deps: AppDeps, body: RevertBody) {
  requireDirForProject(body.scope, body.dir);
  return {
    storeRoot: deps.storeRoot,
    scope: body.scope,
    dir: body.dir,
    agents: body.agents,
    artifactIds: body.artifactIds,
    acknowledgements: body.acknowledgements,
    snapshotPassphrase: body.snapshotPassphrase,
    keepBackups: body.keepBackups,
  };
}

function syncOpts(deps: AppDeps, body: SyncBody) {
  if (
    body.resources?.ids !== undefined &&
    (!Array.isArray(body.resources.ids) ||
      body.resources.ids.length === 0 ||
      body.resources.ids.some(
        (id) => typeof id !== "string" || !/^(rules|mcp|skills)\/[A-Za-z0-9._-]+$/.test(id),
      ))
  ) {
    throw new ClientApiInputError("Exact resource selection requires non-empty resource IDs", {
      fields: ["resources.ids"],
    });
  }
  if (body.resources?.ids && body.resources.collections !== undefined) {
    throw new ClientApiInputError("Exact IDs and Collection selection are separate modes", {
      fields: ["resources"],
    });
  }
  requireDirForDestination(body.destination, body.dir);
  return {
    storeRoot: deps.storeRoot,
    scope: scopeForDestination(body.destination),
    dir: body.dir,
    agents: body.agents ?? [],
    collections: body.resources?.collections,
    resourceIds: body.resources?.ids,
    capabilities: body.resources?.kinds,
    method: body.method,
    mcpStrategy: body.mcpStrategy,
    replaceUnowned: body.replaceUnowned,
    overrideDrift: body.overrideDrift,
    snapshotPassphrase: body.snapshotPassphrase,
    secretMode: "env" as const,
  };
}

function parseScope(raw: string | undefined): Scope | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "global" || raw === "project") return raw;
  throw new ClientApiInputError("scope is invalid", { fields: ["scope"] });
}

function parseCapabilities(raw: string | undefined): Capability[] | undefined {
  const values = parseCsv(raw);
  if (!values) return undefined;
  for (const value of values) {
    if (value !== "rules" && value !== "mcp" && value !== "skills") {
      throw new ClientApiInputError("capability is invalid", { fields: ["capabilities"] });
    }
  }
  return values as Capability[];
}

function parseActivityActions(raw: string | undefined): ActivityAction[] | undefined {
  const values = parseCsv(raw);
  if (!values) return undefined;
  for (const value of values) {
    if (value !== "apply" && value !== "scan-import" && value !== "revert") {
      throw new ClientApiInputError("activity action is invalid", { fields: ["actions"] });
    }
  }
  return values as ActivityAction[];
}

function parseCsv(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new ClientApiInputError("limit is invalid", { fields: ["limit"] });
  }
  return value;
}

function summaryOpts(deps: AppDeps, query: (name: string) => string | undefined) {
  const scope = parseScope(query("scope"));
  const dir = query("dir");
  requireDirForProject(scope, dir);
  return {
    storeRoot: deps.storeRoot,
    scope,
    dir,
    agents: parseCsv(query("agents")),
    collections: parseCsv(query("collections")),
    capabilities: parseCapabilities(query("capabilities")),
    activityLimit: parseLimit(query("limit")),
  };
}

function activityFilter(query: (name: string) => string | undefined) {
  const scope = parseScope(query("scope"));
  const dir = query("dir");
  requireDirForProject(scope, dir);
  return {
    limit: parseLimit(query("limit")),
    actions: parseActivityActions(query("actions")),
    scope,
    agents: parseCsv(query("agents")),
  };
}

function profileInvocationOpts(deps: AppDeps, profileId: string, body: ProfileInvocationBody) {
  return {
    storeRoot: deps.storeRoot,
    profileId,
    workspaceRoot: body.workspaceRoot,
    replaceUnowned: body.replaceUnowned,
    overrideDrift: body.overrideDrift,
    snapshotPassphrase: body.snapshotPassphrase,
    secretMode: "env" as const,
  };
}

function clientMutationFailure(requestId: string, conflict: MutationConflict) {
  const error = clientErrorFromMutationConflict(conflict);
  const status: 400 | 409 | 500 =
    error.code === "DOMAIN_VALIDATION_FAILED"
      ? 400
      : error.code === "PARTIAL_FAILURE" || error.code === "EXECUTION_FAILED"
        ? 500
        : 409;
  return { body: clientFailure(requestId, error), status };
}

export function createApp(inputDeps: AppDeps) {
  const {
    secretStore: _secretStore,
    inventorySecretAdoptionProvider: _inventorySecretAdoptionProvider,
    ...webEnv
  } = inputDeps.env;
  const deps: AppDeps = {
    ...inputDeps,
    env: webEnv,
  };
  const app = new Hono();
  const requestId = (c: { req: { header(name: string): string | undefined } }): string =>
    resolveClientRequestId(c.req.header("x-request-id"), deps.env.randomId);
  const responseKnownValueSources = new WeakMap<Response, object>();
  const responseCorePayloads = new WeakMap<Response, object>();
  const authenticationKnownValueSource =
    deps.auth.mode === "trusted-embedded"
      ? undefined
      : createSafeObservableKnownValueSource([
          deps.auth.mode === "bearer" ? deps.auth.token : deps.auth.sessionId,
        ]);
  const withCorePayload = <T>(response: T, payload: object): T => {
    responseCorePayloads.set(response as Response, payload);
    return response;
  };

  // 统一错误处理:HTTPException 按其状态码;其余(如 JSON 解析失败、core 抛错)→ 400 JSON,不裸 500/栈。
  app.onError((err, c) => {
    if (c.req.path.startsWith("/api/v1/")) {
      const id = requestId(c);
      if (err instanceof ClientApiInputError || err instanceof VerificationInputError) {
        return c.json(
          clientFailure(id, {
            code: "INVALID_INPUT",
            message: "Request input is invalid",
            ...(err instanceof ClientApiInputError && err.details ? { details: err.details } : {}),
          }),
          400,
        );
      }
      if (err instanceof HTTPException) {
        return c.json(
          clientFailure(id, {
            code: "INVALID_INPUT",
            message: "Request input is invalid",
          }),
          err.status,
        );
      }
      if (err instanceof StoreMutationConflictError) {
        const failure = clientMutationFailure(id, err.conflict);
        return c.json(failure.body, failure.status);
      }
      if (err instanceof ControlPlaneValidationError) {
        return c.json(
          clientFailure(id, {
            code: "DOMAIN_VALIDATION_FAILED",
            message: "Request did not satisfy the operation contract",
            details: err.details,
          }),
          400,
        );
      }
      if (err instanceof InventoryStoreImportPlanningError) {
        return c.json(
          clientFailure(id, {
            code: err.code,
            message: err.message,
            details: { reason: err.reason },
          }),
          400,
        );
      }
      if (err instanceof InventorySecretAdoptionPlanningError) {
        return c.json(
          clientFailure(id, {
            code: err.code,
            message: err.message,
            details: { reason: err.reason },
          }),
          400,
        );
      }
      return c.json(
        clientFailure(id, { code: "INTERNAL_ERROR", message: "Unexpected internal failure" }),
        500,
      );
    }
    return c.notFound();
  });

  // Host 白名单(纵深防御:阻止 DNS rebinding —— 攻击者域名解析到 127.0.0.1 借浏览器打本地 API)。
  app.use("*", hostGuard);

  // One response boundary protects every current and future API route, including thin-shell
  // callers that accidentally return a sensitive field from Core.
  app.use("/api/v1/*", async (c, next) => {
    await next();
    if (!c.res.headers.get("content-type")?.includes("application/json")) return;
    const payload = await c.res
      .clone()
      .json()
      .catch(() => undefined);
    if (payload === undefined) return;
    const headers = new Headers(c.res.headers);
    const observablePayload = responseCorePayloads.get(c.res) ?? payload;
    const serialized = await serializeSafeWebObservable(
      deps.env,
      deps.storeRoot,
      observablePayload,
      {
        knownValueSources: [
          responseKnownValueSources.get(c.res),
          authenticationKnownValueSource,
        ].filter((source): source is object => source !== undefined),
      },
    );
    c.res = new Response(serialized, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });
  });

  app.use("/api/v1/*", async (c, next) => {
    if (c.req.path === "/api/v1/health") return next();
    const auth = deps.auth;
    if (c.req.path === "/api/v1/auth/session") {
      if (auth.mode !== "browser-session") {
        return c.json(
          clientFailure(requestId(c), {
            code: "POLICY_VIOLATION",
            message: "Authentication mode does not permit browser bootstrap",
          }),
          403,
        );
      }
      const origin = c.req.header("origin");
      const site = c.req.header("sec-fetch-site");
      const expected = exactLoopbackOrigin(c.req.header("host"), c.req.url);
      if (origin !== expected || (site !== "same-origin" && site !== "none")) {
        return c.json(
          clientFailure(requestId(c), {
            code: "POLICY_VIOLATION",
            message: "Browser session bootstrap was rejected",
          }),
          403,
        );
      }
      return next();
    }
    if (auth.mode === "trusted-embedded") return next();
    if (auth.mode === "bearer") {
      if (!safeEqual(c.req.header("authorization") ?? "", `Bearer ${auth.token}`)) {
        return c.json(
          clientFailure(requestId(c), {
            code: "POLICY_VIOLATION",
            message: "Authentication required",
          }),
          401,
        );
      }
      return next();
    }
    if (!safeEqual(readCookie(c.req.header("cookie"), "cellarer_session") ?? "", auth.sessionId)) {
      return c.json(
        clientFailure(requestId(c), {
          code: "POLICY_VIOLATION",
          message: "Authentication required",
        }),
        401,
      );
    }
    if (isMutationMethod(c.req.method)) {
      const expected = exactLoopbackOrigin(c.req.header("host"), c.req.url);
      if (c.req.header("origin") !== expected) {
        return c.json(
          clientFailure(requestId(c), {
            code: "POLICY_VIOLATION",
            message: "Mutation origin was rejected",
          }),
          403,
        );
      }
    }
    return next();
  });

  app.use(
    "/api/v1/*",
    bodyLimit({
      maxSize: CLIENT_API_MAX_REQUEST_BODY_BYTES,
      onError: (c) =>
        c.json(
          clientFailure(requestId(c), {
            code: "DOMAIN_VALIDATION_FAILED",
            message: "Request body exceeds the local client API budget",
            details: { maxBytes: CLIENT_API_MAX_REQUEST_BODY_BYTES },
          }),
          413,
        ),
    }),
  );

  const api = app
    .get("/api/v1/version", (c) =>
      c.json(
        clientSuccess(requestId(c), {
          apiVersion: CLIENT_API_VERSION,
          contractId: CLIENT_API_CONTRACT_ID,
        }),
      ),
    )
    .get("/api/v1/openapi.json", (c) => {
      const payload = clientSuccess(
        requestId(c),
        createClientOpenApiDocument(
          deps.auth.mode === "trusted-embedded" ? undefined : deps.auth.mode,
        ),
      );
      return withCorePayload(c.json(payload), payload);
    })
    .get("/api/v1/health", (c) => c.json(clientSuccess(requestId(c), { live: true })))
    .post("/api/v1/auth/session", (c) => {
      const auth = deps.auth;
      if (auth.mode !== "browser-session") {
        throw new Error("browser session route reached without browser authentication");
      }
      return c.json(
        clientSuccess(requestId(c), {
          authenticated: true,
          authMode: "browser-session" as const,
        }),
        200,
        {
          "set-cookie": browserSessionCookie(auth.sessionId),
          "cache-control": "no-store",
        },
      );
    })
    .get("/api/v1/capabilities", (c) =>
      c.json(
        clientSuccess(requestId(c), {
          apiVersion: CLIENT_API_VERSION,
          contractId: CLIENT_API_CONTRACT_ID,
          operations: CLIENT_API_ROUTES.map((route) => route.operationId),
        }),
      ),
    )
    .get("/api/v1/readiness", async (c) => {
      const readiness = await getClientReadiness(deps.env, deps.storeRoot);
      return c.json(clientSuccess(requestId(c), readiness), readiness.ready ? 200 : 503);
    })
    .get("/api/v1/resources", async (c) => {
      const destination = parseDestination(c.req.query("destination")) ?? "user";
      const dir = c.req.query("dir");
      requireDirForDestination(destination, dir);
      const data = await listControlPlaneResources(deps.env, {
        storeRoot: deps.storeRoot,
        agents: parseCsv(c.req.query("agents")),
        collections: parseCsv(c.req.query("collections")),
        destination,
        dir,
        includeDiscovered: c.req.query("includeDiscovered") !== "false",
      });
      return c.json(clientSuccess(requestId(c), data));
    })
    .get("/api/v1/resources/:kind", async (c) => {
      const kind = c.req.param("kind");
      if (kind !== "rules" && kind !== "mcp" && kind !== "skills") {
        return c.json(
          clientFailure(requestId(c), {
            code: "INVALID_INPUT",
            message: "Request input is invalid",
            details: { fields: ["kind"] },
          }),
          400,
        );
      }
      const destination = parseDestination(c.req.query("destination")) ?? "user";
      const dir = c.req.query("dir");
      requireDirForDestination(destination, dir);
      const data = await listControlPlaneResources(deps.env, {
        storeRoot: deps.storeRoot,
        kind,
        agents: parseCsv(c.req.query("agents")),
        collections: parseCsv(c.req.query("collections")),
        destination,
        dir,
        includeDiscovered: c.req.query("includeDiscovered") !== "false",
      });
      return c.json(clientSuccess(requestId(c), data));
    })
    .get("/api/v1/agents", async (c) => {
      const scope = parseScope(c.req.query("scope")) ?? "global";
      const dir = c.req.query("dir");
      requireDirForProject(scope, dir);
      const data = await listControlPlaneAgents(deps.env, {
        storeRoot: deps.storeRoot,
        scope,
        ...(dir ? { dir } : {}),
        ...(parseCsv(c.req.query("agents")) ? { agents: parseCsv(c.req.query("agents")) } : {}),
      });
      return c.json(clientSuccess(requestId(c), data));
    })
    .get("/api/v1/agents/:id", async (c) => {
      const scope = parseScope(c.req.query("scope")) ?? "global";
      const dir = c.req.query("dir");
      requireDirForProject(scope, dir);
      return c.json(
        clientSuccess(
          requestId(c),
          await showControlPlaneAgent(deps.env, {
            storeRoot: deps.storeRoot,
            scope,
            ...(dir ? { dir } : {}),
            agentId: c.req.param("id"),
          }),
        ),
      );
    })
    .post("/api/v1/agents/plan", async (c) => {
      const body = await parseJsonBody(() => c.req.json<AgentPlanBody>());
      let planned: PlannedControlPlaneMutationDto;
      if (body.action === "set-enabled") {
        const parsed = parseAgentEnabledMutationBody({ enabled: body.enabled, dryRun: true });
        planned = await mutateBuiltinAgent(deps.env, {
          storeRoot: deps.storeRoot,
          agentId: body.agentId,
          action: parsed.enabled ? "enable" : "disable",
          dryRun: true,
        });
      } else if (body.action === "upsert-adapter") {
        const parsed = parseAgentAdapterMutationBody({
          kind: body.kind,
          adapter: body.adapter,
          dryRun: true,
        });
        planned = await mutateAgentAdapter(deps.env, {
          storeRoot: deps.storeRoot,
          agentId: body.agentId,
          ...parsed,
        });
      } else {
        planned = await mutateCustomAdapter(deps.env, {
          storeRoot: deps.storeRoot,
          agentId: body.agentId,
          action: "remove",
          dryRun: true,
        });
      }
      const payload = clientSuccess(requestId(c), planned);
      return withCorePayload(c.json(payload), payload);
    })
    .get("/api/v1/collections", async (c) =>
      c.json(
        clientSuccess(
          requestId(c),
          await listControlPlaneCollections(deps.env, { storeRoot: deps.storeRoot }),
        ),
      ),
    )
    .get("/api/v1/collections/:name", async (c) =>
      c.json(
        clientSuccess(
          requestId(c),
          await showControlPlaneCollection(deps.env, {
            storeRoot: deps.storeRoot,
            collectionName: c.req.param("name"),
          }),
        ),
      ),
    )
    .post("/api/v1/collections/plan", async (c) => {
      const body = await parseJsonBody(() => c.req.json<CollectionPlanBody>());
      let planned: PlannedControlPlaneMutationDto;
      if (body.action === "create") {
        const parsed = parseCollectionCreateMutationBody({
          collectionName: body.collectionName,
          description: body.description,
          resourceIds: body.resourceIds,
          dryRun: true,
        });
        planned = await mutateCollection(deps.env, {
          storeRoot: deps.storeRoot,
          action: "create",
          ...parsed,
        });
      } else if (body.action === "update") {
        if (!body.collectionName) {
          throw new ControlPlaneValidationError("collection name is required", {
            fields: ["collectionName"],
          });
        }
        const parsed = parseCollectionUpdateMutationBody({
          description: body.description,
          dryRun: true,
        });
        planned = await mutateCollection(deps.env, {
          storeRoot: deps.storeRoot,
          action: "update",
          collectionName: body.collectionName,
          ...parsed,
        });
      } else if (body.action === "set-members") {
        if (!body.collectionName) {
          throw new ControlPlaneValidationError("collection name is required", {
            fields: ["collectionName"],
          });
        }
        const parsed = parseCollectionMembersMutationBody({
          resourceIds: body.resourceIds,
          dryRun: true,
        });
        planned = await mutateCollection(deps.env, {
          storeRoot: deps.storeRoot,
          action: "set-members",
          collectionName: body.collectionName,
          ...parsed,
        });
      } else if (body.action === "set-defaults") {
        const parsed = parseCollectionDefaultsMutationBody({
          collectionNames: body.collectionNames,
          dryRun: true,
        });
        planned = await mutateCollection(deps.env, {
          storeRoot: deps.storeRoot,
          action: "set-defaults",
          ...parsed,
        });
      } else {
        if (!body.collectionName) {
          throw new ControlPlaneValidationError("collection name is required", {
            fields: ["collectionName"],
          });
        }
        planned = await mutateCollection(deps.env, {
          storeRoot: deps.storeRoot,
          action: "delete",
          collectionName: body.collectionName,
          dryRun: true,
        });
      }
      const payload = clientSuccess(requestId(c), planned);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/revert/plan", async (c) => {
      const body = await parseJsonBody(() => c.req.json<RevertBody>());
      const planned = await planRevertMutation(deps.env, revertOpts(deps, body));
      const payload = clientSuccess(requestId(c), planned);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/revert/apply", async (c) => {
      const body = await parseJsonBody(() => c.req.json<RevertPlanApplyBody>());
      const options = revertOpts(deps, body);
      const applied = await applyRevertMutationPlan(deps.env, body.mutationPlan, {
        storeRoot: deps.storeRoot,
        options,
        snapshotPassphrase: body.snapshotPassphrase,
        keepBackups: body.keepBackups,
      });
      if (!applied.operation.ok) {
        const failure = clientMutationFailure(requestId(c), applied.operation.conflict);
        return c.json(failure.body, failure.status);
      }
      const payload = clientSuccess(requestId(c), applied);
      return withCorePayload(c.json(payload), payload);
    })
    .get("/api/v1/recovery", async (c) => {
      const payload = clientSuccess(
        requestId(c),
        await diagnoseMutationRecovery(deps.env, deps.storeRoot),
      );
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/recovery/apply", async (c) => {
      const body = await parseJsonBody(() => c.req.json<RecoveryApplyBody>());
      const operation = await recoverInterruptedOperation(deps.env, deps.storeRoot, body);
      if (!operation.ok) {
        const failure = clientMutationFailure(requestId(c), operation.conflict);
        return c.json(failure.body, failure.status);
      }
      const payload = clientSuccess(requestId(c), { operation });
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/mutations/apply", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ControlPlanePlanApplyBody>());
      const applied = await applyControlPlaneMutationPlan(deps.env, body.mutationPlan, {
        storeRoot: deps.storeRoot,
      });
      if (!applied.operation.ok) {
        const failure = clientMutationFailure(requestId(c), applied.operation.conflict);
        return c.json(failure.body, failure.status);
      }
      const payload = clientSuccess(requestId(c), applied);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/deployments/baseline/plan", async (c) => {
      const body = await parseJsonBody(() =>
        c.req.json<{ deploymentId: string; selectors: string[] }>(),
      );
      const planned = await planDeploymentBaseline(deps.env, {
        ...body,
        storeRoot: deps.storeRoot,
      });
      const payload = clientSuccess(requestId(c), planned);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/deployments/baseline/apply", async (c) => {
      const body = await parseJsonBody(() =>
        c.req.json<{ deploymentId: string; selectors: string[]; mutationPlan: MutationPlan }>(),
      );
      const applied = await applyDeploymentBaselinePlan(deps.env, body.mutationPlan, {
        storeRoot: deps.storeRoot,
        deploymentId: body.deploymentId,
        selectors: body.selectors,
      });
      if (!applied.operation.ok) {
        const failure = clientMutationFailure(requestId(c), applied.operation.conflict);
        return c.json(failure.body, failure.status);
      }
      const payload = clientSuccess(requestId(c), applied);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/sync/plan", async (c) => {
      const body = await parseJsonBody(() => c.req.json<SyncBody>());
      const prepared = await planApplyMutation(deps.env, syncOpts(deps, body));
      const payload = clientSuccess(requestId(c), prepared);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/sync/apply", async (c) => {
      const body = await parseJsonBody(() => c.req.json<SyncPlanApplyBody>());
      const applied = await applyMutationPlan(deps.env, body.mutationPlan, {
        storeRoot: deps.storeRoot,
        secretMode: "env",
      });
      if (!applied.operation.ok) {
        const failure = clientMutationFailure(requestId(c), applied.operation.conflict);
        return c.json(failure.body, failure.status);
      }
      const payload = clientSuccess(requestId(c), applied);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/resources/dependencies", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ResourceIdBody>());
      const payload = clientSuccess(
        requestId(c),
        await resourceDependencyReport(deps.env, {
          storeRoot: deps.storeRoot,
          resourceId: body.resourceId,
        }),
      );
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/resources/update/check", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ResourceIdBody>());
      const payload = clientSuccess(
        requestId(c),
        await checkResourceUpdate(deps.env, {
          storeRoot: deps.storeRoot,
          resourceId: body.resourceId,
        }),
      );
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/resources/update/plan", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ResourceIdBody>());
      const planned = await planAvailableResourceUpdate(deps.env, {
        storeRoot: deps.storeRoot,
        resourceId: body.resourceId,
      });
      const payload = clientSuccess(requestId(c), planned);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/resources/update/apply", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ResourceUpdateApplyBody>());
      const applied = await applyResourceUpdatePlan(deps.env, body.mutationPlan, {
        storeRoot: deps.storeRoot,
      });
      if (!applied.operation.ok) {
        const failure = clientMutationFailure(requestId(c), applied.operation.conflict);
        return c.json(failure.body, failure.status);
      }
      const payload = clientSuccess(requestId(c), applied);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/resources/rename/plan", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ResourceRenameBody>());
      const planned = await planResourceRename(deps.env, {
        storeRoot: deps.storeRoot,
        resourceId: body.resourceId,
        newName: body.newName,
        mode: body.mode,
      });
      const payload = clientSuccess(requestId(c), planned);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/resources/rename/apply", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ResourceRenameApplyBody>());
      const options = {
        storeRoot: deps.storeRoot,
        resourceId: body.resourceId,
        newName: body.newName,
        mode: body.mode,
      };
      const applied = await applyResourceRenamePlan(deps.env, body.mutationPlan, {
        storeRoot: deps.storeRoot,
        options,
      });
      if (!applied.operation.ok) {
        const failure = clientMutationFailure(requestId(c), applied.operation.conflict);
        return c.json(failure.body, failure.status);
      }
      const payload = clientSuccess(requestId(c), applied);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/resources/remove/plan", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ResourceRemoveBody>());
      const planned = await planResourceRemove(deps.env, {
        storeRoot: deps.storeRoot,
        resourceId: body.resourceId,
        cascade: body.cascade,
      });
      const payload = clientSuccess(requestId(c), planned);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/resources/remove/apply", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ResourceRemoveApplyBody>());
      const options = {
        storeRoot: deps.storeRoot,
        resourceId: body.resourceId,
        cascade: body.cascade,
      };
      const applied = await applyResourceRemovePlan(deps.env, body.mutationPlan, {
        storeRoot: deps.storeRoot,
        options,
      });
      if (!applied.operation.ok) {
        const failure = clientMutationFailure(requestId(c), applied.operation.conflict);
        return c.json(failure.body, failure.status);
      }
      const payload = clientSuccess(requestId(c), applied);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/resources/export/plan", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ResourceExportBody>());
      const planned = await planResourceExport(deps.env, {
        storeRoot: deps.storeRoot,
        resourceId: body.resourceId,
        bundlePath: body.bundlePath,
      });
      const payload = clientSuccess(requestId(c), planned);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/resources/export/apply", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ResourceExportApplyBody>());
      const options = {
        storeRoot: deps.storeRoot,
        resourceId: body.resourceId,
        bundlePath: body.bundlePath,
      };
      const applied = await applyResourceExportPlan(deps.env, body.mutationPlan, {
        storeRoot: deps.storeRoot,
        options,
      });
      if (!applied.operation.ok) {
        const failure = clientMutationFailure(requestId(c), applied.operation.conflict);
        return c.json(failure.body, failure.status);
      }
      const payload = clientSuccess(requestId(c), applied);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/resources/bundle/validate", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ResourceBundleBody>());
      const payload = clientSuccess(
        requestId(c),
        await validateResourceBundle(deps.env, { bundlePath: body.bundlePath }),
      );
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/resources/bundle-import/plan", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ResourceBundleBody>());
      const planned = await planResourceBundleImport(deps.env, {
        storeRoot: deps.storeRoot,
        bundlePath: body.bundlePath,
      });
      const payload = clientSuccess(requestId(c), planned);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/resources/bundle-import/apply", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ResourceBundleApplyBody>());
      const options = { storeRoot: deps.storeRoot, bundlePath: body.bundlePath };
      const applied = await applyResourceBundleImportPlan(deps.env, body.mutationPlan, {
        storeRoot: deps.storeRoot,
        options,
      });
      if (!applied.operation.ok) {
        const failure = clientMutationFailure(requestId(c), applied.operation.conflict);
        return c.json(failure.body, failure.status);
      }
      const payload = clientSuccess(requestId(c), applied);
      return withCorePayload(c.json(payload), payload);
    })
    .get("/api/v1/profiles", async (c) =>
      c.json(
        clientSuccess(requestId(c), {
          profiles: await listSyncProfiles(deps.env, { storeRoot: deps.storeRoot }),
        }),
      ),
    )
    .post("/api/v1/profiles/plan", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ProfilePlanBody>());
      const options = {
        storeRoot: deps.storeRoot,
        profileId: body.profileId,
        dryRun: true,
      };
      const planned =
        body.action === "create"
          ? await createSyncProfile(deps.env, { ...options, desired: body.desired })
          : body.action === "update"
            ? await updateSyncProfile(deps.env, { ...options, desired: body.desired })
            : await deleteSyncProfile(deps.env, options);
      const payload = clientSuccess(requestId(c), planned);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/profiles/apply", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ProfileMutationApplyBody>());
      const applied = await applySyncProfileMutationPlan(deps.env, body.mutationPlan, {
        storeRoot: deps.storeRoot,
      });
      if (!applied.operation.ok) {
        const failure = clientMutationFailure(requestId(c), applied.operation.conflict);
        return c.json(failure.body, failure.status);
      }
      const payload = clientSuccess(requestId(c), applied);
      return withCorePayload(c.json(payload), payload);
    })
    .get("/api/v1/profiles/:id", async (c) =>
      c.json(
        clientSuccess(
          requestId(c),
          await showSyncProfile(deps.env, {
            storeRoot: deps.storeRoot,
            profileId: c.req.param("id"),
          }),
        ),
      ),
    )
    .post("/api/v1/profiles/:id/sync/plan", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ProfileInvocationBody>());
      const planned = await planSyncProfile(
        deps.env,
        profileInvocationOpts(deps, c.req.param("id"), body),
      );
      const payload = clientSuccess(requestId(c), planned);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/profiles/:id/sync/apply", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ProfileApplyBody>());
      const applied = await applySyncProfilePlan(
        deps.env,
        body.mutationPlan,
        profileInvocationOpts(deps, c.req.param("id"), body),
      );
      if (!applied.operation.ok) {
        const failure = clientMutationFailure(requestId(c), applied.operation.conflict);
        return c.json(failure.body, failure.status);
      }
      const payload = clientSuccess(requestId(c), applied);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/profiles/:id/verify", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ProfileInvocationBody>());
      const payload = clientSuccess(
        requestId(c),
        await verifySyncProfile(deps.env, profileInvocationOpts(deps, c.req.param("id"), body)),
      );
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/profiles/:id/uninstall/plan", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ProfileUninstallBody>());
      const planned = await planSyncProfileUninstall(deps.env, {
        ...profileInvocationOpts(deps, c.req.param("id"), body),
        acknowledgements: body.acknowledgements,
      });
      const payload = clientSuccess(requestId(c), planned);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/profiles/:id/uninstall/apply", async (c) => {
      const body = await parseJsonBody(() => c.req.json<ProfileUninstallApplyBody>());
      const applied = await applySyncProfileUninstallPlan(deps.env, body.mutationPlan, {
        ...profileInvocationOpts(deps, c.req.param("id"), body),
        targetKeys: body.targetKeys,
        acknowledgements: body.acknowledgements,
      });
      if (!applied.operation.ok) {
        const failure = clientMutationFailure(requestId(c), applied.operation.conflict);
        return c.json(failure.body, failure.status);
      }
      const payload = clientSuccess(requestId(c), applied);
      return withCorePayload(c.json(payload), payload);
    })
    .get("/api/v1/config", async (c) => {
      const payload = clientSuccess(
        requestId(c),
        await showControlPlaneConfig(deps.env, { storeRoot: deps.storeRoot }),
      );
      return withCorePayload(c.json(payload), payload);
    })
    .get("/api/v1/settings", async (c) =>
      c.json(
        clientSuccess(requestId(c), await settingsSummary(deps.env, { storeRoot: deps.storeRoot })),
      ),
    )
    .post("/api/v1/settings/plan", async (c) => {
      const body = await parseJsonBody(() => c.req.json<SettingsPlanBody>());
      const parsed = parseControlPlaneSettingsMutationBody({
        settings: body.settings,
        dryRun: true,
      });
      const planned = await mutateControlPlaneSettings(deps.env, {
        storeRoot: deps.storeRoot,
        action: "update",
        settings: parsed.settings,
        dryRun: true,
      });
      const payload = clientSuccess(requestId(c), planned);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/config/validate", async (c) => {
      const payload = clientSuccess(
        requestId(c),
        validateControlPlaneConfig(await parseJsonBody(() => c.req.json())),
      );
      return withCorePayload(c.json(payload), payload);
    })
    .get("/api/v1/inventory", async (c) => {
      const projectRoot = parseInventoryDir(c.req.query("dir"));
      return c.json(
        clientSuccess(
          requestId(c),
          await refreshInventory(deps.env, {
            storeRoot: deps.storeRoot,
            ...(projectRoot ? { projectRoot } : {}),
          }),
        ),
      );
    })
    .get("/api/v1/inventory/:agentId", async (c) => {
      const projectRoot = parseInventoryDir(c.req.query("dir"));
      return c.json(
        clientSuccess(
          requestId(c),
          await refreshInventory(deps.env, {
            storeRoot: deps.storeRoot,
            agentId: parseInventoryAgentId(c.req.param("agentId")),
            ...(projectRoot ? { projectRoot } : {}),
          }),
        ),
      );
    })
    .post("/api/v1/inventory/import/plan", async (c) => {
      const body = await parseJsonBody(() => c.req.json<InventoryStoreImportPlanBody>());
      const candidateIds = parseInventoryImportCandidateIds(body.candidateIds);
      const agentId = body.agentId === undefined ? undefined : parseInventoryAgentId(body.agentId);
      const projectRoot = parseInventoryDir(body.dir);
      const planned = await planInventoryStoreImport(deps.env, {
        storeRoot: deps.storeRoot,
        candidateIds,
        refresh: {
          ...(agentId ? { agentId } : {}),
          ...(projectRoot ? { projectRoot } : {}),
        },
        ...(body.intoCollection ? { intoCollection: body.intoCollection } : {}),
      });
      const payload = clientSuccess(requestId(c), planned);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/inventory/import/apply", async (c) => {
      const body = await parseJsonBody(() => c.req.json<InventoryStoreImportApplyBody>());
      const applied = await applyInventoryStoreImportPlan(deps.env, body.mutationPlan, {
        storeRoot: deps.storeRoot,
      });
      if (!applied.operation.ok) {
        const failure = clientMutationFailure(requestId(c), applied.operation.conflict);
        return c.json(failure.body, failure.status);
      }
      const payload = clientSuccess(requestId(c), applied);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/inventory/adoption/plan", async (c) => {
      const service = requireInventorySecretAdoptionService(deps);
      const body = parseInventorySecretAdoptionPlanBody(await parseJsonBody(() => c.req.json()));
      const planned = await service.plan(body);
      const payload = clientSuccess(requestId(c), planned);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/inventory/adoption/apply", async (c) => {
      const service = requireInventorySecretAdoptionService(deps);
      const body = parseInventorySecretAdoptionApplyBody(await parseJsonBody(() => c.req.json()));
      const applied = await service.apply(body.mutationPlan);
      const payload = clientSuccess(requestId(c), applied);
      return withCorePayload(c.json(payload), payload);
    })
    .post("/api/v1/diff", async (c) => {
      const body = await parseJsonBody(() => c.req.json<DistributeBody>());
      return c.json(
        clientSuccess(requestId(c), await diffControlPlane(deps.env, distributeOpts(deps, body))),
      );
    })
    .get("/api/v1/status", async (c) =>
      c.json(
        clientSuccess(
          requestId(c),
          await statusControlPlane(deps.env, {
            storeRoot: deps.storeRoot,
            scope: parseScope(c.req.query("scope")) ?? "global",
            dir: c.req.query("dir"),
          }),
        ),
      ),
    )
    .post("/api/v1/verify", async (c) => {
      const body = await parseJsonBody(() => c.req.json<DistributeBody>());
      return c.json(
        clientSuccess(requestId(c), await verifyControlPlane(deps.env, distributeOpts(deps, body))),
      );
    })
    .get("/api/v1/summary", async (c) =>
      c.json(
        clientSuccess(
          requestId(c),
          await summaryControlPlane(deps.env, summaryOpts(deps, c.req.query.bind(c.req))),
        ),
      ),
    )
    .get("/api/v1/activity", async (c) =>
      c.json(
        clientSuccess(
          requestId(c),
          await listActivity(deps.env, deps.storeRoot, activityFilter(c.req.query.bind(c.req))),
        ),
      ),
    )
    .get("/api/v1/operations", async (c) =>
      c.json(
        clientSuccess(
          requestId(c),
          await listControlPlaneOperations(deps.env, {
            storeRoot: deps.storeRoot,
            ...(parseLimit(c.req.query("limit"))
              ? { limit: parseLimit(c.req.query("limit")) }
              : {}),
          }),
        ),
      ),
    )
    .get("/api/v1/operations/:id", async (c) =>
      c.json(
        clientSuccess(
          requestId(c),
          await showControlPlaneOperation(deps.env, {
            storeRoot: deps.storeRoot,
            operationId: c.req.param("id"),
          }),
        ),
      ),
    );

  return api;
}

export function bindInventorySecretAdoptionService(
  env: Env,
  storeRoot: string,
): InventorySecretAdoptionService {
  return Object.freeze({
    plan: (input: InventorySecretAdoptionPlanBody) =>
      planInventorySecretAdoption(env, {
        storeRoot,
        candidateId: input.candidateId,
        selector: input.selector,
        provider: input.provider,
        refresh: {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(input.dir ? { projectRoot: input.dir } : {}),
        },
      }),
    apply: (mutationPlan: MutationPlan) =>
      applyInventorySecretAdoptionPlan(env, mutationPlan, { storeRoot }),
  });
}

function requireInventorySecretAdoptionService(deps: AppDeps): InventorySecretAdoptionService {
  if (!deps.inventorySecretAdoption) {
    throw new ClientApiInputError("Inventory secret adoption is unavailable", {
      capability: "inventory-secret-adoption",
    });
  }
  return deps.inventorySecretAdoption;
}

function exactLoopbackOrigin(hostHeader: string | undefined, requestUrl: string): string {
  const host = hostHeader ?? new URL(requestUrl).host;
  return `http://${host}`;
}

function browserSessionCookie(sessionId: string): string {
  return `cellarer_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/api/v1`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const item of header?.split(";") ?? []) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function isMutationMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

// RPC 类型导出:前端 `hc<AppType>(...)` 拿端到端类型。
export type AppType = ReturnType<typeof createApp>;
