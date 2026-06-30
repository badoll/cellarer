// AgentSpec → AgentAdapter 工厂(不变量 4 的落地:内置与声明式共用同一构造路径,
// 引擎绝不散写 if (agent.id === ...))。
// 内置适配器 = 用 TS 写的 AgentSpec;声明式适配器 = 从 TOML 解析出的同形 AgentSpec。
import { isAbsolute, join } from "node:path";
import type { Env } from "../env.js";
import type { Capability, Scope } from "../model/index.js";
import { markdownRulesCodec } from "./codec.js";
import type { AgentAdapter, AgentPaths, DetectResult } from "./types.js";

// 路径模板:支持 ~(家目录)与 {dir}(工程根)占位符。
export interface PathTemplate {
  global?: string;
  project?: string;
}

export interface AgentSpec {
  id: string;
  displayName: string;
  // 探测:命中任一目录即视为已安装(空则回退到 rules 路径父目录)。
  detect?: { global?: string[]; project?: string[] };
  rules?: PathTemplate & { format?: "markdown" };
  mcp?: PathTemplate & { format?: "json" | "toml"; serversKey?: string };
  skills?: PathTemplate & { format?: "dir" };
  capabilities: Record<Capability, Scope[]>;
}

// 展开模板:~ → homedir;{dir} → 工程根;非占位的相对路径相对 base 解析为绝对。
// 保证返回绝对路径(PlanAction.target 契约):base 为 project 工程根 / global 家目录。
function expand(env: Env, template: string, scope: Scope, dir?: string): string {
  if (template === "~") return env.homedir();
  if (template.startsWith("~/")) return join(env.homedir(), template.slice(2));

  // base:project = 工程根(--dir,可能是相对值);global = 家目录。先把 base 自身 absolutize。
  const rawBase = scope === "project" ? (dir ?? env.cwd()) : env.homedir();
  const base = isAbsolute(rawBase) ? rawBase : join(env.cwd(), rawBase);

  // {dir} 替换用函数 replacer,避免 base 中的 $$ / $& / $` / $' 被 String.replace 重新解释。
  const out = template.includes("{dir}") ? template.replace(/\{dir\}/g, () => base) : template;

  // 仍是相对(无占位符的相对模板)→ 相对 base 解析为绝对。
  return isAbsolute(out) ? out : join(base, out);
}

function pickTemplate(t: PathTemplate | undefined, scope: Scope): string | undefined {
  if (!t) return undefined;
  return scope === "global" ? t.global : t.project;
}

export function specToAdapter(spec: AgentSpec): AgentAdapter {
  function paths(env: Env, scope: Scope, dir?: string): AgentPaths {
    const rulesT = pickTemplate(spec.rules, scope);
    const mcpT = pickTemplate(spec.mcp, scope);
    const skillsT = pickTemplate(spec.skills, scope);
    return {
      rules: rulesT ? expand(env, rulesT, scope, dir) : undefined,
      mcp: mcpT ? expand(env, mcpT, scope, dir) : undefined,
      skillsDir: skillsT ? expand(env, skillsT, scope, dir) : undefined,
    };
  }

  async function detect(env: Env, scope: Scope, dir?: string): Promise<DetectResult> {
    // 候选探测目录:显式 detect 模板,否则回退到 rules 文件所在目录/工程根。
    const explicit = scope === "global" ? spec.detect?.global : spec.detect?.project;
    const candidates: string[] = [];
    if (explicit && explicit.length > 0) {
      for (const c of explicit) candidates.push(expand(env, c, scope, dir));
    } else if (scope === "project") {
      candidates.push(dir ?? env.cwd());
    } else {
      const r = paths(env, scope, dir).rules;
      if (r) candidates.push(join(r, "..")); // rules 文件父目录
    }
    for (const c of candidates) {
      try {
        await env.fs.stat(c);
        return { installed: true, root: c };
      } catch {
        // 继续探测下一候选
      }
    }
    return { installed: false, root: candidates[0] ?? dir ?? env.cwd() };
  }

  return {
    id: spec.id,
    displayName: spec.displayName,
    capabilities: spec.capabilities,
    rules: spec.rules ? markdownRulesCodec : undefined,
    paths,
    detect,
  };
}
