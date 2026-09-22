// AgentSpec → AgentAdapter 工厂(不变量 4 的落地:built-in / override / custom 共用同一构造路径,
// 引擎绝不散写 if (agent.id === ...))。
// 默认/自定义适配器最终都归一为同形 AgentSpec。
import { isAbsolute, join } from "node:path";
import type { Env } from "../env.js";
import { isWithinRoot } from "../fs/safety.js";
import { mcpCodecFor } from "../mcp/codec.js";
import type { MergeStrategy } from "../mcp/merge.js";
import type { McpDialect } from "../mcp/model.js";
import type { Capability, Scope } from "../model/index.js";
import { markdownRulesCodec } from "./codec.js";
import type {
  AdapterMcp,
  AgentAdapter,
  AgentPaths,
  DetectResult,
  DiscoveryDescriptor,
} from "./types.js";

// 路径模板:支持 ~(家目录)与 {dir}(工程根)占位符。
export interface PathTemplate {
  global?: string;
  project?: string;
}

export interface AgentSpec {
  id: string;
  displayName: string;
  discovery?: readonly DiscoveryDescriptor[];
  // 探测:命中任一目录即视为已安装(空则回退到 rules 路径父目录)。
  detect?: { global?: string[]; project?: string[] };
  rules?: PathTemplate & { format?: "markdown" };
  mcp?: PathTemplate & {
    format?: "json" | "toml";
    serversKey?: string;
    mergeStrategy?: MergeStrategy;
    supportedSecretReferences: ("environment" | "cellarer")[];
    // 字段方言(opencode command[]/environment、windsurf serverUrl);缺省 standard。
    dialect?: McpDialect;
  };
  skills?: PathTemplate & { format?: "dir" };
  capabilities: Record<Capability, Scope[]>;
}

// 展开模板:~ → homedir;{dir} → 工程根;非占位的相对路径相对 base 解析为绝对。
// 保证返回绝对路径(PlanAction.target 契约):base 为 project 工程根 / global 家目录。
//
// 安全(§6.6 分享场景):配置适配器可来自团队/社区拷贝,恶意/失误的模板可能用
// `../` 或绝对路径逃逸,或用 `~/` 让 project 适配器越权写到家目录(如 `~/.ssh/authorized_keys`)。
// 故展开后校验结果必须落在**本 scope 的受管根**内:global→家目录,project→工程根。
// 不放行「home ∪ project」并集 —— 否则分享来的 project 适配器可借 `~/` 逃逸到家目录(作用域越权)。
// 默认适配器 global 全为 `~/...`(落在 home)、project 全为 `{dir}/...`(落在工程根),
// 校验后不受影响。
function expand(env: Env, template: string, scope: Scope, dir?: string): string {
  // base = 本 scope 的受管根:project = 工程根(--dir,可能是相对值);global = 家目录。先 absolutize。
  const rawBase = scope === "project" ? (dir ?? env.cwd()) : env.homedir();
  const base = isAbsolute(rawBase) ? rawBase : join(env.cwd(), rawBase);

  const resolved = resolveTemplate(env, template, base);

  // 越界护栏:必须落在本 scope 受管根之内(inclusive)。join 已归一化 `..`,故此判据可靠。
  if (!isWithinRoot(base, resolved)) {
    throw new Error(`adapter path escapes its ${scope} managed root "${base}": "${template}"`);
  }
  return resolved;
}

// 纯展开(不含越界校验):~ / {dir} / 相对 base。
function resolveTemplate(env: Env, template: string, base: string): string {
  if (template === "~") return env.homedir();
  if (template.startsWith("~/")) return join(env.homedir(), template.slice(2));

  // {dir} 替换用函数 replacer,避免 base 中的 $$ / $& / $` / $' 被 String.replace 重新解释。
  const out = template.includes("{dir}") ? template.replace(/\{dir\}/g, () => base) : template;

  // 仍是相对(无占位符的相对模板)→ 相对 base 解析为绝对。
  return isAbsolute(out) ? out : join(base, out);
}

function pickTemplate(t: PathTemplate | undefined, scope: Scope): string | undefined {
  if (!t) return undefined;
  return scope === "global" ? t.global : t.project;
}

// 从 AgentSpec.mcp 构造 mcp codec 绑定(format 缺省 json;serversKey 缺省 mcpServers;可带字段方言)。
function buildMcp(spec: AgentSpec): AdapterMcp | undefined {
  if (!spec.mcp) return undefined;
  const format = spec.mcp.format ?? "json";
  return {
    codec: mcpCodecFor(format, { ...spec.mcp.dialect, nativeId: spec.id }),
    serversKey: spec.mcp.serversKey ?? (format === "toml" ? "mcp_servers" : "mcpServers"),
    defaultStrategy: spec.mcp.mergeStrategy ?? "merge",
    supportedSecretReferences: spec.mcp.supportedSecretReferences,
  };
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
      // 全局回退:从已声明的能力路径推候选父目录(rules → mcp → skills),
      // 支持 mcp-only / skills-only 适配器(否则无 rules 时探测不到根)。
      const p = paths(env, scope, dir);
      const anchor = p.rules ?? p.mcp ?? p.skillsDir;
      if (anchor) candidates.push(join(anchor, ".."));
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
    mcp: buildMcp(spec),
    skills: spec.skills ? { format: "dir" } : undefined,
    paths,
    ...(spec.discovery
      ? {
          discovery: (env: Env, scope: Scope, dir?: string) =>
            (spec.discovery ?? [])
              .filter((source) => source.scope === scope)
              .map((source) => ({
                ...source,
                path: resolveTemplate(
                  env,
                  source.path,
                  scope === "project" ? (dir ?? env.cwd()) : env.homedir(),
                ),
              })),
        }
      : {}),
    detect,
  };
}
