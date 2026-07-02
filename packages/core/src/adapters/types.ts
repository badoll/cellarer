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

// rules 编解码:把库房多个 rule 片段渲染为该 agent 原生 rules 文件内容。
// 注:文件级「是否 cellarer 生成」的判定收敛在 markers.isGenerated(rules 全用同一 markdown 格式),
// backup 直接调用它,故 codec 不重复声明 isGenerated(避免 M1 留下的未用接口面)。
export interface RulesCodec {
  // 渲染:多片段 concat(含 source marker + generated header)→ 文件文本。
  render(fragments: RuleFragment[]): string;
}

// mcp 编解码绑定:codec(JSON/TOML)+ 该 agent 的 servers 键名 + 默认合并策略。
// 格式方言全部在 codec 内自洽(不变量 4),引擎只给 canonical + 策略。
export interface AdapterMcp {
  codec: McpCodec;
  serversKey: string; // 例:mcpServers / mcp_servers
  defaultStrategy: MergeStrategy; // 默认 merge;可被 config.json / CLI 覆盖
}

// skills 下发:目录级 link/copy(无格式转换,落地方式由 plan 的 method 决定)。
// 标记接口:存在即表示该 agent 支持 skills 目录下发。
export interface SkillsCodec {
  format: "dir";
}

export interface AgentAdapter {
  id: string; // 'claude-code' | 'codex' | 'cursor' | 'agents-md' | ...
  displayName: string;
  detect(env: Env, scope: Scope, dir?: string): Promise<DetectResult>;
  paths(env: Env, scope: Scope, dir?: string): AgentPaths;
  // 各能力在各 scope 下是否支持;未列出 → 下发时跳过并告警。
  capabilities: Record<Capability, Scope[]>;
  rules?: RulesCodec;
  mcp?: AdapterMcp;
  skills?: SkillsCodec;
}
