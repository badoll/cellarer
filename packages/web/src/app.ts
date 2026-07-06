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
  collectLedgerSecretRefStats,
  collectLedgerSecretRefs,
  createRealEnv,
  type DiffIdentity,
  dashboardSummary,
  diffTarget,
  doctor,
  type Env,
  inspectAgents,
  listActivity,
  listMcpArtifacts,
  listRuleArtifacts,
  listSkillArtifacts,
  loadConfig,
  loadLedger,
  loadRegistry,
  plan,
  resolveStoreRoot,
  revert,
  type ScanSelection,
  type Scope,
  scanPlan,
  status,
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
  channels?: string[];
  capabilities?: Capability[];
  method?: "symlink" | "copy";
  mcpStrategy?: "merge" | "overwrite";
}

interface ScanBody {
  agent: string;
  scope?: Scope;
  dir?: string;
  capabilities?: Capability[];
  conflict?: ConflictStrategy;
  select?: string[];
  selectItems?: ScanSelection[];
  intoChannel?: string;
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
  keepBackups?: boolean;
  dryRun?: boolean;
}

interface DiffBody {
  identity: DiffIdentity;
  dir?: string;
  channels?: string[];
}

// project scope 必须带 dir,否则 core 会以 server cwd 为工程根,把文件写进进程启动目录(且无 .gitignore 守护)。
// plan/apply/scan 三个 project 路由共用此守卫(拦在路由层)。
function requireDirForProject(scope: Scope | undefined, dir: string | undefined): void {
  if ((scope ?? "global") === "project" && !dir) {
    throw new HTTPException(400, { message: 'scope "project" requires "dir"' });
  }
}

function distributeOpts(deps: AppDeps, b: DistributeBody) {
  requireDirForProject(b.scope, b.dir);
  return {
    storeRoot: deps.storeRoot,
    scope: (b.scope ?? "global") as Scope,
    dir: b.dir,
    agents: b.agents ?? [],
    channels: b.channels,
    capabilities: b.capabilities,
    method: b.method,
    mcpStrategy: b.mcpStrategy,
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
    conflict: b.conflict,
    select: b.select,
    selectItems: b.selectItems,
    intoChannel: b.intoChannel,
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

function summaryOpts(deps: AppDeps, query: (name: string) => string | undefined) {
  const scope = parseScope(query("scope"));
  const dir = query("dir");
  requireDirForProject(scope, dir);
  return {
    storeRoot: deps.storeRoot,
    scope,
    dir,
    agents: parseCsv(query("agents")),
    channels: parseCsv(query("channels")),
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

export function createApp(deps: AppDeps) {
  const app = new Hono();

  // 统一错误处理:HTTPException 按其状态码;其余(如 JSON 解析失败、core 抛错)→ 400 JSON,不裸 500/栈。
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  });

  // Host 白名单(纵深防御:阻止 DNS rebinding —— 攻击者域名解析到 127.0.0.1 借浏览器打本地 API)。
  app.use("*", hostGuard);

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
    // 库房制品总览(三类 + 通道标签)。
    .get("/api/artifacts", async (c) => {
      const [config, rules, mcp, skills] = await Promise.all([
        loadConfig(deps.env, deps.storeRoot),
        listRuleArtifacts(deps.env, deps.storeRoot),
        listMcpArtifacts(deps.env, deps.storeRoot),
        listSkillArtifacts(deps.env, deps.storeRoot),
      ]);
      const tag = (id: string) => config.artifacts[id]?.channels ?? [];
      return c.json({
        rules: rules.map((a) => ({ id: a.id, name: a.name, channels: tag(a.id) })),
        mcp: mcp.map((a) => ({ id: a.id, name: a.name, channels: tag(a.id) })),
        skills: skills.map((a) => ({ id: a.id, name: a.name, channels: tag(a.id) })),
        channels: Object.keys(config.channels),
      });
    })
    // 可用 agent 适配器。
    .get("/api/agents", async (c) => {
      const reg = await loadRegistry(deps.env, deps.storeRoot);
      const agents = await Promise.all(
        reg.list().map(async (a) => {
          const d = await a.detect(deps.env, "global");
          return {
            id: a.id,
            displayName: a.displayName,
            capabilities: a.capabilities,
            detected: d.installed,
            root: d.root,
          };
        }),
      );
      return c.json({
        agents,
        warnings: reg.warnings,
      });
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
      const p = await plan(deps.env, distributeOpts(deps, body));
      return c.json(p);
    })
    // 执行下发。
    .post("/api/apply", async (c) => {
      const body = await c.req.json<DistributeBody>();
      const r = await apply(deps.env, distributeOpts(deps, body));
      return c.json(r);
    })
    // 扫描预览(只读;ScanItem 不含真值,secretRefs 只列名)。
    .post("/api/scan", async (c) => {
      const body = await c.req.json<ScanBody>();
      return c.json(await scanPlan(deps.env, scanOpts(deps, body)));
    })
    // 扫描导入:仍由 core 负责脱敏、冲突裁决、写前护栏与通道打标。
    .post("/api/scan/apply", async (c) => {
      const body = await c.req.json<ScanBody>();
      return c.json(await applyScan(deps.env, scanOpts(deps, body)));
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
          channels: body.channels,
        }),
      );
    })
    // 漂移检测。
    .get("/api/status", async (c) => {
      const items = await status(deps.env, { storeRoot: deps.storeRoot });
      return c.json({ items });
    })
    // 密钥引用名(只列名,绝不回显真值)——聚合口径走 core helper(不变量 1)。
    .get("/api/secrets", async (c) => {
      const led = await loadLedger(deps.env, deps.storeRoot);
      const refs = collectLedgerSecretRefStats(led);
      return c.json({ names: collectLedgerSecretRefs(led), refs });
    });

  return api;
}

// RPC 类型导出:前端 `hc<AppType>(...)` 拿端到端类型。
export type AppType = ReturnType<typeof createApp>;

// 用真实 Env 构造默认 app(server 入口用)。
export function createDefaultApp(token?: string) {
  const env = createRealEnv();
  return createApp({ env, storeRoot: resolveStoreRoot(env), token });
}
