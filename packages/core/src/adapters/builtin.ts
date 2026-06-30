// 内置适配器(M1:rules 部分)。路径取自计划 §4 本机实测校准事实。
// 用 AgentSpec 声明 → specToAdapter 编译,与声明式适配器完全同构。

import { type AgentSpec, specToAdapter } from "./spec.js";
import type { AgentAdapter } from "./types.js";

const SPECS: AgentSpec[] = [
  {
    // 通用 AGENTS.md + ~/.agents/skills 共享技能池。无 mcp。
    id: "agents-md",
    displayName: "AGENTS.md (generic)",
    detect: { global: ["~/.agents"] },
    rules: { global: "~/.agents/AGENTS.md", project: "{dir}/AGENTS.md", format: "markdown" },
    skills: { global: "~/.agents/skills", project: "{dir}/.agents/skills", format: "dir" },
    capabilities: { rules: ["global", "project"], mcp: [], skills: ["global", "project"] },
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    detect: { global: ["~/.claude"] },
    rules: { global: "~/.claude/CLAUDE.md", project: "{dir}/CLAUDE.md", format: "markdown" },
    // M2:Claude MCP 双源(~/.claude/mcp.json + 内嵌 .claude.json)需快照测试固化。
    mcp: {
      global: "~/.claude/mcp.json",
      project: "{dir}/.mcp.json",
      format: "json",
      serversKey: "mcpServers",
    },
    skills: { global: "~/.claude/skills", project: "{dir}/.claude/skills", format: "dir" },
    capabilities: {
      rules: ["global", "project"],
      mcp: ["global", "project"],
      skills: ["global", "project"],
    },
  },
  {
    id: "codex",
    displayName: "Codex",
    detect: { global: ["~/.codex"] },
    rules: { global: "~/.codex/AGENTS.md", project: "{dir}/AGENTS.md", format: "markdown" },
    // M2:Codex MCP 内嵌 TOML 表 [mcp_servers.*]。
    mcp: {
      global: "~/.codex/config.toml",
      project: "{dir}/.codex/config.toml",
      format: "toml",
      serversKey: "mcp_servers",
    },
    skills: { global: "~/.codex/skills", project: "{dir}/.agents/skills", format: "dir" },
    capabilities: {
      rules: ["global", "project"],
      mcp: ["global", "project"],
      skills: ["global", "project"],
    },
  },
  {
    // Cursor:rules 用 .mdc;skills 目录名是 skills-cursor(非 skills)。
    id: "cursor",
    displayName: "Cursor",
    detect: { global: ["~/.cursor"] },
    rules: {
      global: "~/.cursor/rules/cellarer.mdc",
      project: "{dir}/.cursor/rules/cellarer.mdc",
      format: "markdown",
    },
    mcp: {
      global: "~/.cursor/mcp.json",
      project: "{dir}/.cursor/mcp.json",
      format: "json",
      serversKey: "mcpServers",
    },
    skills: { global: "~/.cursor/skills-cursor", project: "{dir}/.agents/skills", format: "dir" },
    capabilities: {
      rules: ["global", "project"],
      mcp: ["global", "project"],
      skills: ["global", "project"],
    },
  },
];

export function builtinAdapters(): AgentAdapter[] {
  return SPECS.map(specToAdapter);
}
