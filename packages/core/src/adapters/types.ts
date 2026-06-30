// AgentAdapter:新增 agent 的扩展点(架构不变量 4)。
// 引擎只调接口,绝不散写 if (agent.id === ...) —— 这是 ruler apply-engine 的反面教材。
import type { Env } from "../env.js";
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

// rules 编解码:把库房多个 rule 片段渲染为该 agent 原生 rules 文件内容,并能反向读取。
export interface RulesCodec {
  // 渲染:多片段 concat(含 source marker + generated header)→ 文件文本。
  render(fragments: RuleFragment[]): string;
  // 读取已落地文件,返回是否由 cellarer 生成(靠首行 marker)。
  isGenerated(content: string): boolean;
}

export interface AgentAdapter {
  id: string; // 'claude-code' | 'codex' | 'cursor' | 'agents-md' | ...
  displayName: string;
  detect(env: Env, scope: Scope, dir?: string): Promise<DetectResult>;
  paths(env: Env, scope: Scope, dir?: string): AgentPaths;
  // 各能力在各 scope 下是否支持;未列出 → 下发时跳过并告警。
  capabilities: Record<Capability, Scope[]>;
  rules?: RulesCodec;
  // mcp / skills codec 在 M2 落地;M1 仅 rules。
}
