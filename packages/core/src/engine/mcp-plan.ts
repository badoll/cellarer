// mcp planner(下发期):库房 mcp 制品 → 按 agent 原生格式 merge/overwrite,产出 PlanAction。
//
// 密钥处理(安全红线):支持的引用 token 原样保留,renderer 不接收也不解析真值。
// 非占位符且命中密钥规则的值是库房脏数据,由统一 plan guard 阻断。
import type { AgentAdapter } from "../adapters/types.js";
import type { Env } from "../env.js";
import { readFileOrNull } from "../fs/probe.js";
import { applyMerge } from "../mcp/codec.js";
import type { MergeStrategy } from "../mcp/merge.js";
import type { McpServer, McpServerSet } from "../mcp/model.js";
import type { Artifact, PlanAction } from "../model/index.js";
import { isSensitiveSecretFieldName } from "../secrets/detector.js";
import {
  parseSecretReference,
  type SecretReference,
  secretReferenceToken,
} from "../secrets/reference.js";
import { sha256 } from "../store/checksum.js";
import { readMcpArtifact } from "../store/store.js";

// 渲染后的 incoming 集合(agent 无关,plan() 顶层算一次)。
export interface RenderedMcp {
  incoming: McpServerSet;
  references: SecretReference[];
  accidentalPlaintext: boolean; // 库房脏数据:非占位符却命中高置信密钥规则
}

export interface RenderMcpOptions {
  servers: { name: string; server: McpServer }[];
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

// 单字段渲染上下文(累积 refs/标志,供 env/headers/args/url 各处复用)。
interface RenderAcc {
  references: SecretReference[];
  accidental: boolean;
}

// 渲染单个值的密钥占位符:两类 typed reference 都原样保留。
// 返回渲染后的字符串;非占位符原样返回(命中高置信密钥规则则标 accidental)。
function renderValue(acc: RenderAcc, field: string, value: string): string {
  const ref = parseSecretReference(value);
  if (!ref) {
    // Pattern matches are handled by the versioned staged-tree guard and may have an exact
    // source-bound suppression. A non-placeholder in a structurally sensitive field is a
    // separate unconditional violation and cannot be suppressed.
    if (isSensitiveSecretFieldName(field)) acc.accidental = true;
    return value;
  }
  acc.references.push(ref);
  return secretReferenceToken(ref);
}

function renderNestedValue(acc: RenderAcc, value: unknown, field: string): unknown {
  if (typeof value === "string") return renderValue(acc, field, value);
  if (Array.isArray(value)) {
    return value.map((item, index) => renderNestedValue(acc, item, `${field}[${index}]`));
  }
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = renderNestedValue(acc, child, key);
  }
  return out;
}

// Extension/custom configuration is intentionally round-tripped as unknown structured data.
// Reference compatibility nevertheless applies to every legal nested string, not only the
// normalized env/args/url/header fields.
function renderServerSecrets(server: McpServer, acc: RenderAcc): McpServer {
  return renderNestedValue(acc, server, "") as McpServer;
}

// 渲染整组 server 的密钥(agent 无关,plan() 顶层算一次)。
export async function renderMcp(opts: RenderMcpOptions): Promise<RenderedMcp> {
  const incoming: McpServerSet = {};
  const acc: RenderAcc = { references: [], accidental: false };
  for (const { name, server } of opts.servers) {
    incoming[name] = renderServerSecrets(server, acc);
  }
  return {
    incoming,
    references: [
      ...new Map(
        acc.references.map((reference) => [secretReferenceToken(reference), reference]),
      ).values(),
    ],
    accidentalPlaintext: acc.accidental,
  };
}

// 为单个 agent 产出 mcp PlanAction(无 mcp 能力/无制品 → 无产出)。
export async function planMcp(ctx: McpPlanContext, adapter: AgentAdapter): Promise<PlanAction[]> {
  if (!adapter.mcp || ctx.selectedMcp.length === 0) return [];
  const unsupportedReference = ctx.rendered.references.find(
    (reference) => !adapter.mcp?.supportedSecretReferences.includes(reference.kind),
  );
  if (unsupportedReference) {
    throw new Error(
      `adapter "${adapter.id}" is incompatible with reference-only secrets: target does not support ${unsupportedReference.kind} reference "${secretReferenceToken(unsupportedReference)}" and would require cellarer plaintext materialization`,
    );
  }
  const target = adapter.paths(ctx.env, ctx.scope, ctx.dir).mcp;
  if (!target) return [];

  const strategy: MergeStrategy = ctx.strategyOverride ?? adapter.mcp.defaultStrategy;
  // Desired-state evidence must depend only on the current selection/configuration. Render the
  // selected server set into an empty document before reading the target used for merge preview.
  const desiredContent = applyMerge(
    adapter.mcp.codec,
    null,
    ctx.rendered.incoming,
    adapter.mcp.serversKey,
    "overwrite",
  );
  const contentFingerprint = sha256(desiredContent);
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
    desiredEvidence: {
      method: "write",
      contentFingerprint,
    },
    secretRefs: [...new Set(ctx.rendered.references.map((reference) => reference.name))],
    accidentalPlaintext: ctx.rendered.accidentalPlaintext,
  };

  return [action];
}
