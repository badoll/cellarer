// mcp planner(下发期):库房 mcp 制品 → 按 agent 原生格式 merge/overwrite,产出 PlanAction。
//
// 密钥处理(安全红线,见计划 §10/§7.6):
//   - env 模式(默认):库房占位符 ${CELLARER_SECRET:NAME} 渲染为 ${NAME}(env 引用);零明文落盘。
//   - vault/keychain 模式:把占位符解析为真值注入(「故意明文」,§10.2 必须明文的 agent)。
//   - 任何字段里的「非占位符且命中密钥规则」的值 = 库房脏数据(违反零明文),视为「意外明文」。
//
// 密钥渲染与 agent 无关(只取决于 secretMode + 库房 server),故在 plan() 顶层渲染一次、各 agent 共享
// (避免每 agent 重复 scrypt 解密 vault / 重复正则扫描)。planMcp 只做 per-agent 的 target/merge。
//
// 下发前 secret-scan 护栏(§10.3):意外明文(脏库房)无条件中止;故意注入的明文仅 git 跟踪
// (project)中止,global 放行(§10.2 逃生通道)。渲染文本的通用高置信扫描在 plan() 统一后置(覆盖所有能力)。
import type { AgentAdapter } from "../adapters/types.js";
import type { Env } from "../env.js";
import { readFileOrNull } from "../fs/probe.js";
import { applyMerge } from "../mcp/codec.js";
import type { MergeStrategy } from "../mcp/merge.js";
import type { McpServer, McpServerSet } from "../mcp/model.js";
import type { Artifact, PlanAction } from "../model/index.js";
import { detectSecret } from "../secrets/detector.js";
import { envPlaceholder, parseSecretRef } from "../secrets/redactor.js";
import { resolveSecretValue, type SecretMode } from "../secrets/resolver.js";
import { readMcpArtifact } from "../store/store.js";

// 渲染后的 incoming 集合(agent 无关,plan() 顶层算一次)。
export interface RenderedMcp {
  incoming: McpServerSet;
  refs: string[];
  resolvedPlaintext: boolean; // 故意注入了真值(vault/keychain)
  accidentalPlaintext: boolean; // 库房脏数据:非占位符却命中高置信密钥规则
  warnings: string[]; // 解析失败等(已脱敏,不含真值)
}

export interface RenderMcpOptions {
  env: Env;
  storeRoot: string;
  servers: { name: string; server: McpServer }[];
  secretMode: SecretMode;
  vaultPassphrase?: string;
  vaultData?: Record<string, string>; // 预加载明文,避免重复解密
}

export interface McpPlanContext {
  scope: "global" | "project";
  dir?: string;
  env: Env;
  selectedMcp: Artifact[];
  rendered: RenderedMcp;
  strategyOverride?: MergeStrategy;
}

// 读取 + 通道过滤后的 mcp 制品集合(plan() 顶层调用一次,各 agent 共享)。
export async function loadSelectedMcp(
  env: Env,
  storeRoot: string,
  selected: Artifact[],
): Promise<{ name: string; server: McpServer }[]> {
  return Promise.all(selected.map((a) => readMcpArtifact(env, storeRoot, a.id)));
}

// 单字段渲染上下文(累积 refs/标志/warnings,供 env/headers/args/url 各处复用)。
interface RenderAcc {
  refs: string[];
  resolved: boolean;
  accidental: boolean;
  warnings: string[];
}

// 渲染单个值的密钥占位符:env 引用降级 / vault 解析真值 / 失败降级为 env 引用 + warning。
// 返回渲染后的字符串;非占位符原样返回(命中高置信密钥规则则标 accidental)。
async function renderValue(
  opts: RenderMcpOptions,
  acc: RenderAcc,
  serverName: string,
  field: string,
  value: string,
): Promise<string> {
  const ref = parseSecretRef(value);
  if (!ref) {
    // 非占位符:库房本应零明文。命中「高置信」密钥规则 → 意外明文(脏库房),无条件拦。
    // 仅 high 严重度才硬拦:high-entropy(warning)对 git SHA / 构建哈希等会误报。
    if (detectSecret(value, field)?.severity === "high") acc.accidental = true;
    return value;
  }
  acc.refs.push(ref.name);
  if (opts.secretMode === "env") {
    // env 模式:CELLARER_SECRET 引用降级为 env 引用名;env 引用原样保留。零明文。
    return ref.kind === "env" ? value : envPlaceholder(ref.name);
  }
  // vault/keychain 模式:解析真值。
  const outcome = await resolveSecretValue(opts.env, opts.storeRoot, value, {
    mode: opts.secretMode,
    vaultPassphrase: opts.vaultPassphrase,
    vaultData: opts.vaultData,
  });
  if (outcome.resolved && outcome.value !== undefined && parseSecretRef(outcome.value) === null) {
    acc.resolved = true;
    return outcome.value;
  }
  // 解析失败:降级为 env 引用 ${NAME}(agent 可识别),并告警 ——
  // 绝不写回 ${CELLARER_SECRET:..} 内部字面量(agent 不认,产生静默坏配置)。
  acc.warnings.push(
    `mcp "${serverName}.${field}": secret "${ref.name}" unresolved (${outcome.reason}); wrote env reference \${${ref.name}} instead`,
  );
  return envPlaceholder(ref.name);
}

// 渲染一个 map 字段(env / headers)。
async function renderMap(
  opts: RenderMcpOptions,
  acc: RenderAcc,
  serverName: string,
  fields: Record<string, string>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [field, value] of Object.entries(fields)) {
    out[field] = await renderValue(opts, acc, serverName, field, value);
  }
  return out;
}

// 渲染单个 server 的全部密钥承载字段:stdio 的 env/args,remote 的 headers/url。
// (args/url 的整值占位符也会被解析,补齐「密钥只在 env/headers」的旧缺口。)
async function renderServerSecrets(
  opts: RenderMcpOptions,
  serverName: string,
  server: McpServer,
  acc: RenderAcc,
): Promise<McpServer> {
  if (server.kind === "stdio") {
    const env = server.env ? await renderMap(opts, acc, serverName, server.env) : undefined;
    const args = server.args
      ? await Promise.all(
          server.args.map((a, i) => renderValue(opts, acc, serverName, `args[${i}]`, a)),
        )
      : undefined;
    return { ...server, ...(env ? { env } : {}), ...(args ? { args } : {}) };
  }
  if (server.kind === "remote") {
    const headers = server.headers
      ? await renderMap(opts, acc, serverName, server.headers)
      : undefined;
    const url = await renderValue(opts, acc, serverName, "url", server.url);
    return { ...server, url, ...(headers ? { headers } : {}) };
  }
  return server; // custom:原样(未知结构不动;其明文由 plan() 通用扫描兜底)。
}

// 渲染整组 server 的密钥(agent 无关,plan() 顶层算一次)。
export async function renderMcp(opts: RenderMcpOptions): Promise<RenderedMcp> {
  const incoming: McpServerSet = {};
  const acc: RenderAcc = { refs: [], resolved: false, accidental: false, warnings: [] };
  for (const { name, server } of opts.servers) {
    incoming[name] = await renderServerSecrets(opts, name, server, acc);
  }
  return {
    incoming,
    refs: [...new Set(acc.refs)],
    resolvedPlaintext: acc.resolved,
    accidentalPlaintext: acc.accidental,
    warnings: acc.warnings,
  };
}

// 为单个 agent 产出 mcp PlanAction(无 mcp 能力/无制品 → 无产出)。
export async function planMcp(ctx: McpPlanContext, adapter: AgentAdapter): Promise<PlanAction[]> {
  const target = adapter.paths(ctx.env, ctx.scope, ctx.dir).mcp;
  if (!target || !adapter.mcp || ctx.selectedMcp.length === 0) return [];

  const strategy: MergeStrategy = ctx.strategyOverride ?? adapter.mcp.defaultStrategy;
  const existing = await readFileOrNull(ctx.env, target);
  const content = applyMerge(
    adapter.mcp.codec,
    existing,
    ctx.rendered.incoming,
    adapter.mcp.serversKey,
    strategy,
    target,
  );

  const action: PlanAction = {
    artifact: ctx.selectedMcp.map((a) => a.id).join(", ") || "mcp/*",
    artifactIds: ctx.selectedMcp.map((artifact) => artifact.id),
    agent: adapter.id,
    scope: ctx.scope,
    capability: "mcp",
    target,
    method: "copy", // mcp 是渲染写入,非软链;method 仅信息字段(op 才是真相)。
    op: strategy,
    reason: ctx.selectedMcp.map((a) => a.id).join(", "),
    preview: { before: existing ?? undefined, after: content },
    secretRefs: ctx.rendered.refs,
    // 故意解析的真值(vault/keychain)是 §10.2 的「必须明文」逃生通道:标记后让 plan() 的
    // 通用护栏在 global 放行、project(git 跟踪)拦截。意外明文(脏库房)另标 accidentalPlaintext,无逃生。
    allowResolvedPlaintext: ctx.rendered.resolvedPlaintext && !ctx.rendered.accidentalPlaintext,
    accidentalPlaintext: ctx.rendered.accidentalPlaintext,
  };

  return [action];
}
