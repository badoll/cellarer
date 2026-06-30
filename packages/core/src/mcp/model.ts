// MCP canonical 中间表示(判别式联合,借 mcpm §7.4)。
// 各 agent 的 mcp 配置先归一到这套 canonical,再由各 codec 渲染回原生格式 ——
// 引擎只跟 canonical 打交道,格式方言全部下沉到 codec(不变量 4)。
//
// 判别规则(借 mcpm from_client_format):有 command → stdio;有 url → remote;否则 custom 原样兜底。
// custom 保证未知/特殊条目不丢失(转换不可逆时也能 round-trip)。

export type McpServerKind = "stdio" | "remote" | "custom";

// 本地子进程型(stdio transport)。
export interface McpStdioServer {
  kind: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  // 该 server 上 command/args/env 之外的字段(disabled/type/cwd/timeout 等),原样保留以免 merge round-trip 丢失。
  extra?: Record<string, unknown>;
}

// 远程型(http/sse)。
export interface McpRemoteServer {
  kind: "remote";
  url: string;
  headers?: Record<string, string>;
  // url/headers 之外的字段,原样保留(同 stdio.extra)。
  extra?: Record<string, unknown>;
}

// 兜底:无法归入 stdio/remote 的条目,原样保留其字段(不丢弃)。
export interface McpCustomServer {
  kind: "custom";
  config: Record<string, unknown>;
}

export type McpServer = McpStdioServer | McpRemoteServer | McpCustomServer;

// 一组具名 server:name → server。canonical 库房与合并都用这个形态。
export type McpServerSet = Record<string, McpServer>;

// 普通对象守卫(排除 null / 数组)。mcp 解析与 codec 共用,避免各写一份。
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// 原生 server 对象(JSON/TOML 解析出的裸对象)→ canonical。
// 标准方言:command/args/env(stdio)、url/headers(remote);其余转 custom 原样保留。
// 注:opencode 的 command[] 拆分、windsurf 的 serverUrl 等方言留待 M5 扩展(此处只认标准字段)。
export function serverFromRaw(raw: unknown): McpServer {
  if (!isPlainObject(raw)) {
    // 非对象(异常输入)→ custom 包裹,避免抛错丢数据。
    return { kind: "custom", config: { value: raw } };
  }
  if (typeof raw.command === "string") {
    const server: McpStdioServer = { kind: "stdio", command: raw.command };
    if (Array.isArray(raw.args)) server.args = raw.args.map(String);
    const env = toStringRecord(raw.env);
    if (env) server.env = env;
    const extra = extraFields(raw, ["command", "args", "env"]);
    if (extra) server.extra = extra;
    return server;
  }
  if (typeof raw.url === "string") {
    const server: McpRemoteServer = { kind: "remote", url: raw.url };
    const headers = toStringRecord(raw.headers);
    if (headers) server.headers = headers;
    const extra = extraFields(raw, ["url", "headers"]);
    if (extra) server.extra = extra;
    return server;
  }
  return { kind: "custom", config: { ...raw } };
}

// canonical → 原生 server 对象(写回 agent 文件用)。
export function serverToRaw(server: McpServer): Record<string, unknown> {
  switch (server.kind) {
    case "stdio": {
      // extra 先铺底,再写 command/args/env(规范字段优先,顺序稳定)。
      const out: Record<string, unknown> = { ...server.extra, command: server.command };
      if (server.args && server.args.length > 0) out.args = server.args;
      if (server.env && Object.keys(server.env).length > 0) out.env = server.env;
      return out;
    }
    case "remote": {
      const out: Record<string, unknown> = { ...server.extra, url: server.url };
      if (server.headers && Object.keys(server.headers).length > 0) out.headers = server.headers;
      return out;
    }
    case "custom":
      return { ...server.config };
  }
}

// 解析一整组原生 servers(name → raw)→ canonical set。
export function serverSetFromRaw(raw: Record<string, unknown>): McpServerSet {
  const set: McpServerSet = {};
  for (const [name, value] of Object.entries(raw)) {
    set[name] = serverFromRaw(value);
  }
  return set;
}

// canonical set → 原生 servers 对象(name → raw)。
export function serverSetToRaw(set: McpServerSet): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(set)) {
    raw[name] = serverToRaw(server);
  }
  return raw;
}

// 把对象的值都转成 string 记录;空/非对象返回 undefined(env/headers 的容错读取)。
function toStringRecord(v: unknown): Record<string, string> | undefined {
  if (!isPlainObject(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) out[k] = String(val);
  return Object.keys(out).length > 0 ? out : undefined;
}

// 取 raw 对象里 known 之外的字段(原样保留,避免 merge round-trip 丢失用户的 server 私有字段)。
function extraFields(
  raw: Record<string, unknown>,
  known: string[],
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!known.includes(k)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
