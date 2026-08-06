// @cellarer/web —— 内嵌 Hono server,把 @cellarer/core 暴露为本地 HTTP(Hono RPC 端到端类型)。
// 安全约束:
//   - 仅监听 127.0.0.1(见 server.ts);可选访问 token。
//   - 密钥不明文回显:web 一律以 secretMode="env" 调 core —— 即便 vault 模式也绝不在 HTTP 响应里解出真值;
//     plan 的 preview 在 env 模式下只含 ${ENV} 占位,secret-scan 护栏命中还会清空 preview。
//   - core-first(不变量 1):路由只解析参数 + 调 core,不写业务逻辑。
import {
  type ActivityAction,
  apply,
  applyScan,
  type Capability,
  type ConflictStrategy,
  ControlPlaneValidationError,
  collectLedgerSecretRefStats,
  collectLedgerSecretRefs,
  type Destination,
  type DiffIdentity,
  dashboardSummary,
  diffTarget,
  discoverySummaryControlPlane,
  doctor,
  type Env,
  inspectAgents,
  listActivity,
  listControlPlaneAgents,
  listControlPlaneResources,
  listMcpArtifacts,
  listRuleArtifacts,
  listSkillArtifacts,
  loadConfig,
  loadLedger,
  mutateAgentAdapter,
  mutateBuiltinAgent,
  mutateCollection,
  mutateControlPlaneSettings,
  mutateCustomAdapter,
  mutationPresentation,
  parseAgentAdapterMutationBody,
  parseAgentEnabledMutationBody,
  parseCollectionCreateMutationBody,
  parseCollectionDefaultsMutationBody,
  parseCollectionMembersMutationBody,
  parseCollectionUpdateMutationBody,
  parseControlPlaneSettingsMutationBody,
  planApplyMutation,
  revert,
  type ScanSelection,
  type Scope,
  StoreMutationConflictError,
  scanPlan,
  serializeSafeObservable,
  serializeSafeWebObservable,
  settingsSummary,
  status,
  verifyControlPlane,
} from "@cellarer/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { hostGuard, safeEqual } from "./security.js";

export interface AppDeps {
  env: Env;
  storeRoot: string;
  // 可选访问 token:设置后所有 /api 请求需带 `Authorization: Bearer <token>`。
  token?: string;
}

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

interface ScanBody {
  agent: string;
  scope?: Scope;
  dir?: string;
  capabilities?: Capability[];
  conflict?: ConflictStrategy;
  selectItems?: ScanSelection[];
  intoCollection?: string;
}

interface ImportBody {
  agent: string;
  destination?: Destination;
  dir?: string;
  capabilities?: Capability[];
  conflict?: ConflictStrategy;
  selectItems?: ScanSelection[];
  intoCollection?: string;
}

interface SyncBody {
  agents?: string[];
  destination?: Destination;
  dir?: string;
  resources?: {
    kinds?: Capability[];
    collections?: string[];
  };
  method?: "symlink" | "copy";
  mcpStrategy?: "merge" | "overwrite";
  replaceUnowned?: string[];
  overrideDrift?: string[];
  snapshotPassphrase?: string;
}

interface InspectBody {
  scope?: Scope;
  dir?: string;
  agents?: string[];
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

interface DiffBody {
  identity: DiffIdentity;
  dir?: string;
  collections?: string[];
}

// project scope 必须带 dir,否则 core 会以 server cwd 为工程根,把文件写进进程启动目录(且无 .gitignore 守护)。
// plan/apply/scan 三个 project 路由共用此守卫(拦在路由层)。
function requireDirForProject(scope: Scope | undefined, dir: string | undefined): void {
  if ((scope ?? "global") === "project" && !dir) {
    throw new HTTPException(400, { message: 'scope "project" requires "dir"' });
  }
}

function parseDestination(raw: string | undefined): Destination | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "user" || raw === "project") return raw;
  throw new HTTPException(400, { message: `invalid destination "${raw}"` });
}

function parseConflictStrategy(raw: string | undefined): ConflictStrategy | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "keep-theirs" || raw === "keep-mine" || raw === "copy") return raw;
  throw new HTTPException(400, { message: `invalid conflict "${raw}"` });
}

function scopeForDestination(destination: string | undefined): Scope {
  const parsed = parseDestination(destination);
  return parsed === "project" ? "project" : "global";
}

function requireDirForDestination(destination: string | undefined, dir: string | undefined): void {
  if (parseDestination(destination) === "project" && !dir) {
    throw new HTTPException(400, { message: 'destination "project" requires "dir"' });
  }
}

function validateScanRequestSelection(body: ScanBody | ImportBody): void {
  if (Object.hasOwn(body, "select")) {
    throw new HTTPException(400, {
      message: 'unexpected field "select"; use exact "selectItems" selectors',
    });
  }
  if (body.selectItems === undefined) return;
  if (!Array.isArray(body.selectItems)) {
    throw new HTTPException(400, { message: '"selectItems" must be an array' });
  }
  for (const [index, selection] of body.selectItems.entries()) {
    const keys =
      typeof selection === "object" && selection !== null && !Array.isArray(selection)
        ? Object.keys(selection).sort()
        : [];
    if (
      keys.join("\0") !== ["kind", "name", "source"].sort().join("\0") ||
      !["rules", "mcp", "skills"].includes(selection?.kind) ||
      typeof selection?.name !== "string" ||
      selection.name.length === 0 ||
      typeof selection?.source !== "string" ||
      selection.source.length === 0
    ) {
      throw new HTTPException(400, {
        message: `"selectItems[${index}]" must be an exact kind/name/source selector`,
      });
    }
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

function inspectOpts(deps: AppDeps, b: InspectBody) {
  requireDirForProject(b.scope, b.dir);
  return {
    storeRoot: deps.storeRoot,
    scope: (b.scope ?? "global") as Scope,
    dir: b.dir,
    agents: b.agents,
  };
}

function scanOpts(deps: AppDeps, b: ScanBody) {
  requireDirForProject(b.scope, b.dir);
  return {
    storeRoot: deps.storeRoot,
    agent: b.agent,
    scope: (b.scope ?? "global") as Scope,
    dir: b.dir,
    capabilities: b.capabilities,
    conflict: parseConflictStrategy(b.conflict),
    selectItems: b.selectItems,
    intoCollection: b.intoCollection,
    secretMode: "env" as const,
  };
}

function importOpts(deps: AppDeps, b: ImportBody) {
  requireDirForDestination(b.destination, b.dir);
  return {
    storeRoot: deps.storeRoot,
    agent: b.agent,
    scope: scopeForDestination(b.destination),
    dir: b.dir,
    capabilities: b.capabilities,
    conflict: parseConflictStrategy(b.conflict),
    selectItems: b.selectItems,
    intoCollection: b.intoCollection,
    secretMode: "env" as const,
  };
}

function syncOpts(deps: AppDeps, body: SyncBody) {
  requireDirForDestination(body.destination, body.dir);
  return {
    storeRoot: deps.storeRoot,
    scope: scopeForDestination(body.destination),
    dir: body.dir,
    agents: body.agents ?? [],
    collections: body.resources?.collections,
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
  throw new HTTPException(400, { message: `invalid scope "${raw}"` });
}

function parseCapabilities(raw: string | undefined): Capability[] | undefined {
  const values = parseCsv(raw);
  if (!values) return undefined;
  for (const value of values) {
    if (value !== "rules" && value !== "mcp" && value !== "skills") {
      throw new HTTPException(400, { message: `invalid capability "${value}"` });
    }
  }
  return values as Capability[];
}

function parseActivityActions(raw: string | undefined): ActivityAction[] | undefined {
  const values = parseCsv(raw);
  if (!values) return undefined;
  for (const value of values) {
    if (value !== "apply" && value !== "scan-import" && value !== "revert") {
      throw new HTTPException(400, { message: `invalid activity action "${value}"` });
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
    throw new HTTPException(400, { message: `invalid limit "${raw}"` });
  }
  return value;
}

function parseOptionalBoolean(raw: string | undefined, field: string): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new HTTPException(400, { message: `invalid ${field} "${raw}"` });
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

export function createApp(inputDeps: AppDeps) {
  const { secretStore: _secretStore, ...webEnv } = inputDeps.env;
  const deps: AppDeps = { ...inputDeps, env: webEnv };
  const app = new Hono();
  const responseKnownValueSources = new WeakMap<Response, object>();

  // 统一错误处理:HTTPException 按其状态码;其余(如 JSON 解析失败、core 抛错)→ 400 JSON,不裸 500/栈。
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json(redactWebPayload({ error: err.message }, [err]), err.status);
    }
    if (err instanceof StoreMutationConflictError) {
      return c.json(redactWebPayload({ error: err.message, conflict: err.conflict }, [err]), 409);
    }
    if (err instanceof ControlPlaneValidationError) {
      return c.json(
        redactWebPayload(
          {
            error: err.message,
            code: "DOMAIN_VALIDATION_FAILED",
            details: err.details,
          },
          [err],
        ),
        400,
      );
    }
    return c.json(
      redactWebPayload({ error: err instanceof Error ? err.message : String(err) }, [err]),
      400,
    );
  });

  // Host 白名单(纵深防御:阻止 DNS rebinding —— 攻击者域名解析到 127.0.0.1 借浏览器打本地 API)。
  app.use("*", hostGuard);

  // One response boundary protects every current and future API route, including thin-shell
  // callers that accidentally return a sensitive field from Core.
  app.use("/api/*", async (c, next) => {
    await next();
    if (!c.res.headers.get("content-type")?.includes("application/json")) return;
    const payload = await c.res
      .clone()
      .json()
      .catch(() => undefined);
    if (payload === undefined) return;
    const headers = new Headers(c.res.headers);
    const serialized = await serializeSafeWebObservable(deps.env, deps.storeRoot, payload, {
      knownValueSources: [responseKnownValueSources.get(c.res)].filter(
        (source): source is object => source !== undefined,
      ),
    });
    c.res = new Response(serialized, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });
  });

  // 访问 token 中间件(设置了才校验);仅保护 /api。用常量时间比较消除时序侧信道。
  app.use("/api/*", async (c, next) => {
    if (deps.token) {
      const auth = c.req.header("Authorization");
      if (!safeEqual(auth ?? "", `Bearer ${deps.token}`)) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }
    await next();
  });

  const api = app
    .get("/api/resources", async (c) => {
      const destination = parseDestination(c.req.query("destination")) ?? "user";
      const dir = c.req.query("dir");
      requireDirForDestination(destination, dir);
      return c.json(
        await listControlPlaneResources(deps.env, {
          storeRoot: deps.storeRoot,
          agents: parseCsv(c.req.query("agents")),
          collections: parseCsv(c.req.query("collections")),
          destination,
          dir,
          includeDiscovered: c.req.query("includeDiscovered") !== "false",
        }),
      );
    })
    .get("/api/resources/:kind", async (c) => {
      const kind = c.req.param("kind");
      if (kind !== "rules" && kind !== "mcp" && kind !== "skills") {
        throw new HTTPException(400, { message: `invalid resource kind "${kind}"` });
      }
      const destination = parseDestination(c.req.query("destination")) ?? "user";
      const dir = c.req.query("dir");
      requireDirForDestination(destination, dir);
      return c.json(
        await listControlPlaneResources(deps.env, {
          storeRoot: deps.storeRoot,
          kind,
          agents: parseCsv(c.req.query("agents")),
          collections: parseCsv(c.req.query("collections")),
          destination,
          dir,
          includeDiscovered: c.req.query("includeDiscovered") !== "false",
        }),
      );
    })
    .get("/api/discovery", async (c) => {
      const destination = parseDestination(c.req.query("destination")) ?? "user";
      const dir = c.req.query("dir");
      requireDirForDestination(destination, dir);
      return c.json(
        await discoverySummaryControlPlane(deps.env, {
          storeRoot: deps.storeRoot,
          agents: parseCsv(c.req.query("agents")),
          destination,
          dir,
        }),
      );
    })
    // 库房资源总览(三类 + collection 标签)。
    .get("/api/artifacts", async (c) => {
      const [config, rules, mcp, skills] = await Promise.all([
        loadConfig(deps.env, deps.storeRoot),
        listRuleArtifacts(deps.env, deps.storeRoot),
        listMcpArtifacts(deps.env, deps.storeRoot),
        listSkillArtifacts(deps.env, deps.storeRoot),
      ]);
      const tag = (id: string) => config.artifacts[id]?.collections ?? [];
      return c.json({
        rules: rules.map((a) => ({ id: a.id, name: a.name, collections: tag(a.id) })),
        mcp: mcp.map((a) => ({ id: a.id, name: a.name, collections: tag(a.id) })),
        skills: skills.map((a) => ({ id: a.id, name: a.name, collections: tag(a.id) })),
        collections: Object.keys(config.collections),
      });
    })
    // 可用 agent 适配器。
    .get("/api/agents", async (c) => {
      const scope = parseScope(c.req.query("scope")) ?? "global";
      const dir = c.req.query("dir");
      requireDirForProject(scope, dir);
      return c.json(
        await listControlPlaneAgents(deps.env, {
          storeRoot: deps.storeRoot,
          scope,
          ...(dir ? { dir } : {}),
          ...(parseCsv(c.req.query("agents")) ? { agents: parseCsv(c.req.query("agents")) } : {}),
        }),
      );
    })
    // Dashboard first-screen state. Core owns counts, coverage, readiness, and activity semantics.
    .get("/api/summary", async (c) => {
      return c.json(await dashboardSummary(deps.env, summaryOpts(deps, c.req.query.bind(c.req))));
    })
    // Append-only local operation history. Mutating core operations write events.
    .get("/api/activity", async (c) => {
      return c.json(
        await listActivity(deps.env, deps.storeRoot, activityFilter(c.req.query.bind(c.req))),
      );
    })
    // scope-aware agent diagnostics(比 /api/agents 丰富,供 dashboard/diagnostics 使用)。
    .post("/api/agents/inspect", async (c) => {
      const body = await c.req.json<InspectBody>();
      return c.json(await inspectAgents(deps.env, inspectOpts(deps, body)));
    })
    // 深度 doctor 检查:store/config/adapter/目标路径写权限。不含密钥真值。
    .post("/api/doctor", async (c) => {
      const body = await c.req.json<InspectBody>();
      return c.json(await doctor(deps.env, inspectOpts(deps, body)));
    })
    // 下发预览(dry-run plan)。preview 已是 env 模式渲染(无真值);护栏命中项 op=skip。
    .post("/api/plan", async (c) => {
      const body = await c.req.json<DistributeBody>();
      const prepared = await planApplyMutation(deps.env, distributeOpts(deps, body));
      const response = c.json({
        ...prepared.plan,
        mutation: mutationPresentation(prepared.mutationPlan),
      });
      responseKnownValueSources.set(response, prepared);
      return response;
    })
    // 执行下发。
    .post("/api/apply", async (c) => {
      const body = await c.req.json<DistributeBody>();
      const r = await apply(deps.env, distributeOpts(deps, body));
      const response = c.json(r);
      responseKnownValueSources.set(response, r);
      return response;
    })
    .post("/api/import/plan", async (c) => {
      const body = await c.req.json<ImportBody>();
      validateScanRequestSelection(body);
      const result = await scanPlan(deps.env, importOpts(deps, body));
      const response = c.json(result);
      responseKnownValueSources.set(response, result);
      return response;
    })
    .post("/api/import/apply", async (c) => {
      const body = await c.req.json<ImportBody>();
      validateScanRequestSelection(body);
      const result = await applyScan(deps.env, importOpts(deps, body));
      const response = c.json(result);
      responseKnownValueSources.set(response, result);
      return response;
    })
    .post("/api/sync/plan", async (c) => {
      const body = await c.req.json<SyncBody>();
      const prepared = await planApplyMutation(deps.env, syncOpts(deps, body));
      const response = c.json({
        ...prepared.plan,
        mutation: mutationPresentation(prepared.mutationPlan),
      });
      responseKnownValueSources.set(response, prepared);
      return response;
    })
    .post("/api/sync/apply", async (c) => {
      const body = await c.req.json<SyncBody>();
      const result = await apply(deps.env, syncOpts(deps, body));
      const response = c.json(result);
      responseKnownValueSources.set(response, result);
      return response;
    })
    // 扫描预览(只读;ScanItem 不含真值,secretRefs 只列名)。
    .post("/api/scan", async (c) => {
      const body = await c.req.json<ScanBody>();
      validateScanRequestSelection(body);
      const result = await scanPlan(deps.env, scanOpts(deps, body));
      const response = c.json(result);
      responseKnownValueSources.set(response, result);
      return response;
    })
    // 扫描导入:仍由 core 负责脱敏、冲突裁决、写前护栏与 collection 打标。
    .post("/api/scan/apply", async (c) => {
      const body = await c.req.json<ScanBody>();
      validateScanRequestSelection(body);
      const result = await applyScan(deps.env, scanOpts(deps, body));
      const response = c.json(result);
      responseKnownValueSources.set(response, result);
      return response;
    })
    // 台账回滚:前端要求 dry-run-first;core 负责受管根安全检查。
    .post("/api/revert", async (c) => {
      const body = await c.req.json<RevertBody>();
      requireDirForProject(body.scope, body.dir);
      return c.json(
        await revert(deps.env, {
          storeRoot: deps.storeRoot,
          scope: body.scope,
          dir: body.dir,
          agents: body.agents,
          artifactIds: body.artifactIds,
          acknowledgements: body.acknowledgements,
          snapshotPassphrase: body.snapshotPassphrase,
          keepBackups: body.keepBackups,
          dryRun: body.dryRun,
        }),
      );
    })
    // Drift diff. Only returns file content when core can reconstruct expected output safely.
    .post("/api/diff", async (c) => {
      const body = await c.req.json<DiffBody>();
      requireDirForProject(body.identity.scope, body.dir);
      return c.json(
        await diffTarget(deps.env, {
          storeRoot: deps.storeRoot,
          identity: body.identity,
          dir: body.dir,
          collections: body.collections,
        }),
      );
    })
    // 漂移检测。
    .get("/api/status", async (c) => {
      const items = await status(deps.env, { storeRoot: deps.storeRoot });
      return c.json({ items });
    })
    .post("/api/verify", async (c) => {
      const body = await c.req.json<DistributeBody>();
      const opts = distributeOpts(deps, body);
      return c.json(
        await verifyControlPlane(deps.env, {
          storeRoot: opts.storeRoot,
          scope: opts.scope,
          dir: opts.dir,
          agents: opts.agents,
          collections: opts.collections,
          capabilities: opts.capabilities,
          method: opts.method,
          mcpStrategy: opts.mcpStrategy,
        }),
      );
    })
    .get("/api/settings", async (c) => {
      return c.json(await settingsSummary(deps.env, { storeRoot: deps.storeRoot }));
    })
    .put("/api/settings", async (c) => {
      const body = parseControlPlaneSettingsMutationBody(await c.req.json<unknown>());
      return c.json(
        await mutateControlPlaneSettings(deps.env, {
          storeRoot: deps.storeRoot,
          action: "update",
          settings: body.settings,
          dryRun: body.dryRun,
        }),
      );
    })
    .post("/api/collections", async (c) => {
      const body = parseCollectionCreateMutationBody(await c.req.json<unknown>());
      return c.json(
        await mutateCollection(deps.env, {
          storeRoot: deps.storeRoot,
          action: "create",
          ...body,
        }),
      );
    })
    .put("/api/collections/defaults", async (c) => {
      const body = parseCollectionDefaultsMutationBody(await c.req.json<unknown>());
      return c.json(
        await mutateCollection(deps.env, {
          storeRoot: deps.storeRoot,
          action: "set-defaults",
          ...body,
        }),
      );
    })
    .put("/api/collections/:name/members", async (c) => {
      const body = parseCollectionMembersMutationBody(await c.req.json<unknown>());
      return c.json(
        await mutateCollection(deps.env, {
          storeRoot: deps.storeRoot,
          action: "set-members",
          collectionName: c.req.param("name"),
          ...body,
        }),
      );
    })
    .put("/api/collections/:name", async (c) => {
      const body = parseCollectionUpdateMutationBody(await c.req.json<unknown>());
      return c.json(
        await mutateCollection(deps.env, {
          storeRoot: deps.storeRoot,
          action: "update",
          collectionName: c.req.param("name"),
          ...body,
        }),
      );
    })
    .delete("/api/collections/:name", async (c) => {
      const dryRun = parseOptionalBoolean(c.req.query("dryRun"), "dryRun");
      return c.json(
        await mutateCollection(deps.env, {
          storeRoot: deps.storeRoot,
          action: "delete",
          collectionName: c.req.param("name"),
          dryRun,
        }),
      );
    })
    .put("/api/agents/:id/enabled", async (c) => {
      const body = parseAgentEnabledMutationBody(await c.req.json<unknown>());
      return c.json(
        await mutateBuiltinAgent(deps.env, {
          storeRoot: deps.storeRoot,
          agentId: c.req.param("id"),
          action: body.enabled ? "enable" : "disable",
          dryRun: body.dryRun,
        }),
      );
    })
    .put("/api/agents/:id/adapter", async (c) => {
      const body = parseAgentAdapterMutationBody(await c.req.json<unknown>());
      return c.json(
        await mutateAgentAdapter(deps.env, {
          storeRoot: deps.storeRoot,
          agentId: c.req.param("id"),
          ...body,
        }),
      );
    })
    .delete("/api/agents/:id/adapter", async (c) => {
      const dryRun = parseOptionalBoolean(c.req.query("dryRun"), "dryRun");
      return c.json(
        await mutateCustomAdapter(deps.env, {
          storeRoot: deps.storeRoot,
          agentId: c.req.param("id"),
          action: "remove",
          dryRun,
        }),
      );
    })
    // 密钥引用名(只列名,绝不回显真值)——聚合口径走 core helper(不变量 1)。
    .get("/api/secrets", async (c) => {
      const led = await loadLedger(deps.env, deps.storeRoot);
      const refs = collectLedgerSecretRefStats(led);
      return c.json({ names: collectLedgerSecretRefs(led), refs });
    });

  return api;
}

export function redactWebPayload(
  value: unknown,
  knownValueSources: readonly unknown[] = [value],
): never {
  return JSON.parse(serializeSafeObservable("web", value, { knownValueSources })) as never;
}

// RPC 类型导出:前端 `hc<AppType>(...)` 拿端到端类型。
export type AppType = ReturnType<typeof createApp>;
