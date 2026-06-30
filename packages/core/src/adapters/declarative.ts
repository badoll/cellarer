// 声明式适配器:从 TOML 解析为 AgentSpec(kickoff §6.6)。
// zod 校验;非法配置由调用方(registry)跳过并告警,不抛断整个加载。
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { Capability, Scope } from "../model/index.js";
import type { AgentSpec } from "./spec.js";

const scopeArray = z.array(z.enum(["global", "project"]));
const pathTemplate = z.object({ global: z.string().optional(), project: z.string().optional() });

const declSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1).optional(),
    detect: z
      .object({ global: z.array(z.string()).optional(), project: z.array(z.string()).optional() })
      .optional(),
    rules: pathTemplate.extend({ format: z.literal("markdown").optional() }).optional(),
    mcp: pathTemplate
      .extend({
        format: z.enum(["json", "toml"]).optional(),
        servers_key: z.string().optional(),
        merge_strategy: z.enum(["merge", "overwrite"]).optional(),
      })
      .optional(),
    skills: pathTemplate.extend({ format: z.literal("dir").optional() }).optional(),
    capabilities: z
      .object({
        rules: scopeArray.optional(),
        mcp: scopeArray.optional(),
        skills: scopeArray.optional(),
      })
      .optional(),
  })
  // 至少声明一条能力路径(rules/mcp/skills 之一)。
  .refine((d) => d.rules || d.mcp || d.skills, {
    message: "adapter must declare at least one of rules/mcp/skills",
  });

// 推断某能力支持的 scope:显式 capabilities 优先;否则从路径模板已声明的 scope 推断
// (声明了 rules.global 即视为支持 rules/global)。
// 这样即便用户把 inline `capabilities = {...}` 误写在 [rules] 表之后(TOML 会归入 rules.capabilities),
// 也能从路径模板兜底,行为符合直觉。
function inferScopes(
  explicit: Scope[] | undefined,
  template: { global?: string; project?: string } | undefined,
): Scope[] {
  if (explicit) return explicit;
  if (!template) return [];
  const scopes: Scope[] = [];
  if (template.global) scopes.push("global");
  if (template.project) scopes.push("project");
  return scopes;
}

function caps(
  declared: { rules?: Scope[]; mcp?: Scope[]; skills?: Scope[] } | undefined,
  spec: {
    rules?: { global?: string; project?: string };
    mcp?: { global?: string; project?: string };
    skills?: { global?: string; project?: string };
  },
): Record<Capability, Scope[]> {
  return {
    rules: inferScopes(declared?.rules, spec.rules),
    mcp: inferScopes(declared?.mcp, spec.mcp),
    skills: inferScopes(declared?.skills, spec.skills),
  };
}

// 解析单个声明式适配器 TOML 文本为 AgentSpec;非法则抛错(调用方捕获)。
export function parseDeclarativeAdapter(text: string): AgentSpec {
  const raw = parseToml(text);
  const d = declSchema.parse(raw);
  const mcp = d.mcp
    ? { ...d.mcp, serversKey: d.mcp.servers_key, mergeStrategy: d.mcp.merge_strategy }
    : undefined;
  return {
    id: d.id,
    displayName: d.displayName ?? d.id,
    detect: d.detect,
    rules: d.rules,
    mcp,
    skills: d.skills,
    capabilities: caps(d.capabilities, { rules: d.rules, mcp: d.mcp, skills: d.skills }),
  };
}
