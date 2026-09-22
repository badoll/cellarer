// AgentAdapter:新增 agent 的扩展点(架构不变量 4)。
// 引擎只调接口,绝不散写 if (agent.id === ...) —— 这是 ruler apply-engine 的反面教材。
import type { Env } from "../env.js";
import type { McpCodec } from "../mcp/codec.js";
import type { MergeStrategy } from "../mcp/merge.js";
import type { Capability, Scope } from "../model/index.js";

// 一个 agent 在某 scope/目录下的三类制品落点。
export interface AgentPaths {
  rules?: string; // 例:~/.claude/CLAUDE.md / ./AGENTS.md
  mcp?: string; // 例:~/.codex/config.toml / ./.cursor/mcp.json
  skillsDir?: string; // 例:~/.claude/skills / .agents/skills
}

/** Discovery is an independent, bounded read contract; paths() remains placement only. */
export interface DiscoveryDescriptor {
  readonly sourceId: string;
  readonly scope: Scope;
  readonly kind: Capability;
  readonly path: string;
  readonly locator: "file" | "tree";
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly precedence: {
    readonly policy: "unknown" | "ranked" | "cumulative";
    readonly rank?: number;
    readonly evidence: string;
  };
}

export interface DetectResult {
  installed: boolean;
  root: string; // 该 agent 在此 scope 下的根目录(绝对路径)
}

// 库房中一个待 concat 的 rule 片段。
export interface RuleFragment {
  // 相对库房 store 的路径(POSIX),用于 source marker。
  relPath: string;
  content: string;
}

/** @deprecated Rules execution uses the single built-in markdown renderer. */
export interface RulesCodec {
  render(fragments: RuleFragment[]): string;
}

// mcp 编解码绑定:codec(JSON/TOML)+ 该 agent 的 servers 键名 + 默认合并策略。
// 格式方言全部在 codec 内自洽(不变量 4),引擎只给 canonical + 策略。
export interface AdapterMcp {
  codec: McpCodec;
  serversKey: string; // 例:mcpServers / mcp_servers
  defaultStrategy: MergeStrategy; // 默认 merge;可被 config.json / CLI 覆盖
  // 目标原生支持的引用种类;缺少某种引用支持时,planning 拒绝而不明文化。
  supportedSecretReferences: ("environment" | "cellarer")[];
}

/** @deprecated Skills execution is path-and-capability driven and supports directories only. */
export interface SkillsCodec {
  format: "dir";
}

export interface AgentAdapter {
  id: string; // 'claude-code' | 'codex' | 'cursor' | 'agents-md' | ...
  displayName: string;
  detect(env: Env, scope: Scope, dir?: string): Promise<DetectResult>;
  paths(env: Env, scope: Scope, dir?: string): AgentPaths;
  discovery?(env: Env, scope: Scope, dir?: string): readonly DiscoveryDescriptor[];
  // 各能力在各 scope 下是否支持;未列出 → 下发时跳过并告警。
  capabilities: Record<Capability, Scope[]>;
  /** @deprecated Compatibility descriptor; execution does not dispatch through this field. */
  rules?: RulesCodec;
  mcp?: AdapterMcp;
  /** @deprecated Compatibility descriptor; execution does not dispatch through this field. */
  skills?: SkillsCodec;
}
