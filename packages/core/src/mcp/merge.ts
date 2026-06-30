// serversKey 别名归一(借 ruler MCP_SERVER_KEYS)+ merge 逻辑(格式无关,在 canonical 层)。
// codec 用这些工具从「整个配置文档对象」里取/放 servers 段,并做 merge/overwrite。
import type { McpServerSet } from "./model.js";

// 已知的 server 列表键别名(不同 agent 各异);归一时按此顺序探测既有键。
// claude/cursor/gemini=mcpServers,codex=mcp_servers,opencode=mcp,部分=servers/context_servers。
export const MCP_SERVER_KEYS = [
  "mcpServers",
  "mcp_servers",
  "servers",
  "mcp",
  "context_servers",
] as const;

// 在配置文档对象里找已有的 servers 键;优先精确匹配 preferred,否则取首个已知别名。
// 返回的 key 用于写回时保留原键名(不破坏用户既有结构)。
export function findServersKey(doc: Record<string, unknown>, preferred: string): string {
  if (preferred in doc) return preferred;
  for (const k of MCP_SERVER_KEYS) {
    if (k in doc) return k;
  }
  return preferred;
}

// 合并策略:
//   merge(默认):incoming 覆盖同名 server,保留 existing 中其余 server。
//   overwrite:incoming 整组替换 existing 的 servers 段(但 codec 仍保留 servers 段之外的文档字段)。
export type MergeStrategy = "merge" | "overwrite";

export function mergeServerSets(
  existing: McpServerSet,
  incoming: McpServerSet,
  strategy: MergeStrategy,
): McpServerSet {
  if (strategy === "overwrite") return { ...incoming };
  return { ...existing, ...incoming };
}
