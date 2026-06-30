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
  {
    // Gemini CLI:GEMINI.md;MCP 在 settings.json 的 mcpServers(本机另有 config/mcp_config.json,
    // v1 统一写 settings.json 一处,避免双源歧义,见计划 §8 开放问题)。无 skills 目录。
    id: "gemini-cli",
    displayName: "Gemini CLI",
    detect: { global: ["~/.gemini"] },
    rules: { global: "~/.gemini/GEMINI.md", project: "{dir}/AGENTS.md", format: "markdown" },
    mcp: {
      global: "~/.gemini/settings.json",
      project: "{dir}/.gemini/settings.json",
      format: "json",
      serversKey: "mcpServers",
    },
    capabilities: { rules: ["global", "project"], mcp: ["global", "project"], skills: [] },
  },
  {
    // opencode:AGENTS.md;MCP 顶层键 `mcp`,字段方言 command[](首元 cmd,余为 args)+ environment。
    id: "opencode",
    displayName: "opencode",
    detect: { global: ["~/.config/opencode"] },
    rules: {
      global: "~/.config/opencode/AGENTS.md",
      project: "{dir}/AGENTS.md",
      format: "markdown",
    },
    mcp: {
      global: "~/.config/opencode/opencode.json",
      project: "{dir}/opencode.json",
      format: "json",
      serversKey: "mcp",
      // opencode 方言:command[]、environment,且 server 必带 type:"local"/"remote"(否则 opencode 拒载)。
      dialect: {
        commandStyle: "array",
        envKey: "environment",
        typeField: "type",
        stdioType: "local",
        remoteType: "remote",
      },
    },
    skills: { global: "~/.config/opencode/skills", project: "{dir}/.agents/skills", format: "dir" },
    capabilities: {
      rules: ["global", "project"],
      mcp: ["global", "project"],
      skills: ["global", "project"],
    },
  },
  {
    // windsurf:remote MCP 用 serverUrl 字段方言;rules 仅 project(workspace AGENTS.md)。
    // 全局 rules 路径不确定(计划 §4 标注),不声明 global rules,避免写一个 windsurf 不读的文件。
    id: "windsurf",
    displayName: "Windsurf",
    detect: { global: ["~/.codeium/windsurf"] },
    rules: {
      project: "{dir}/AGENTS.md",
      format: "markdown",
    },
    mcp: {
      global: "~/.codeium/windsurf/mcp_config.json",
      project: "{dir}/.codeium/windsurf/mcp_config.json",
      format: "json",
      serversKey: "mcpServers",
      dialect: { urlKey: "serverUrl" },
    },
    skills: {
      global: "~/.codeium/windsurf/skills",
      project: "{dir}/.agents/skills",
      format: "dir",
    },
    capabilities: {
      rules: ["project"],
      mcp: ["global", "project"],
      skills: ["global", "project"],
    },
  },
];

export function builtinAdapters(): AgentAdapter[] {
  return SPECS.map(specToAdapter);
}
