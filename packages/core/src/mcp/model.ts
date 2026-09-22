// MCP canonical 中间表示(判别式联合,借 mcpm §7.4)。
// 各 agent 的 mcp 配置先归一到这套 canonical,再由各 codec 渲染回原生格式 ——
// 引擎只跟 canonical 打交道,格式方言全部下沉到 codec(不变量 4)。
//
// 判别规则(借 mcpm from_client_format):有 command → stdio;有 url → remote;否则 custom 原样兜底。
// custom 保证未知/特殊条目不丢失(转换不可逆时也能 round-trip)。

export type McpServerKind = "stdio" | "remote" | "custom";

// 本地子进程型(stdio transport)。
export interface McpStdioServer {
  sourceDialect?: string;
  kind: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  // 该 server 上 command/args/env 之外的字段(disabled/type/cwd/timeout 等),原样保留以免 merge round-trip 丢失。
  extra?: Record<string, unknown>;
}

// 远程型(http/sse)。
export interface McpRemoteServer {
  sourceDialect?: string;
  transport?: "sse" | "streamable-http" | "unknown";
  kind: "remote";
  url: string;
  headers?: Record<string, string>;
  // url/headers 之外的字段,原样保留(同 stdio.extra)。
  extra?: Record<string, unknown>;
}

// 兜底:无法归入 stdio/remote 的条目,原样保留其字段(不丢弃)。
export interface McpCustomServer {
  sourceDialect?: string;
  kind: "custom";
  config: Record<string, unknown>;
}

export type McpServer = McpStdioServer | McpRemoteServer | McpCustomServer;

// 一组具名 server:name → server。canonical 库房与合并都用这个形态。
export type McpServerSet = Record<string, McpServer>;

// 字段方言(借 kickoff §7.4 矩阵):不同 agent 的原生字段名/形态差异。
// 默认 standard(claude/cursor/gemini/codex);opencode/windsurf 各有偏差。
export interface McpDialect {
  /** Adapter-owned provenance identity; configuration loaders supply this field. */
  nativeId?: string;
  expansionPositions?: ("command" | "args" | "env" | "url" | "headers")[];
  semanticDialect?: "standard" | "claude" | "gemini" | "codex";
  // command 形态:"scalar"(command + args[],主流)| "array"(command[0]=cmd,command[1:]=args,opencode)。
  commandStyle?: "scalar" | "array";
  // env 字段名(opencode 用 "environment")。
  envKey?: string;
  // remote url 字段名(windsurf 用 "serverUrl")。
  urlKey?: string;
  // type 判别字段(opencode 必填 type:"local"/"remote");设置后 serverToRaw 写入,serverFromRaw 不据此分类(仍按 command/url)。
  typeField?: string;
  stdioType?: string; // typeField 的 stdio 取值(opencode = "local")
  remoteType?: string; // typeField 的 remote 取值(opencode = "remote")
}

// 已解析方言:命令/键名有默认;type 判别字段无默认(undefined = 不写 type)。
type ResolvedDialect = Required<Pick<McpDialect, "commandStyle" | "envKey" | "urlKey">> &
  Pick<McpDialect, "typeField" | "stdioType" | "remoteType" | "semanticDialect">;

const STANDARD: Pick<McpDialect, "commandStyle" | "envKey" | "urlKey"> = {
  commandStyle: "scalar",
  envKey: "env",
  urlKey: "url",
};

function withDefaults(d?: McpDialect): ResolvedDialect {
  return { ...STANDARD, ...d } as ResolvedDialect;
}

// 普通对象守卫(排除 null / 数组)。mcp 解析与 codec 共用,避免各写一份。
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// 原生 server 对象(JSON/TOML 解析出的裸对象)→ canonical。dialect 缺省为 standard。
// 判别:有 command(标量或数组)→ stdio;有 url 字段(按方言键名)→ remote;否则 custom 原样兜底。
export function serverFromRaw(raw: unknown, dialect?: McpDialect): McpServer {
  if (!isPlainObject(raw)) {
    // 非对象(异常输入)→ custom 包裹,避免抛错丢数据。
    return { kind: "custom", config: { value: raw } };
  }
  if (!dialect && "$cellarerMcp" in raw) {
    const evidence = raw.$cellarerMcp;
    if (
      !isPlainObject(evidence) ||
      Object.keys(evidence).length !== 1 ||
      typeof evidence.sourceDialect !== "string"
    )
      throw new TypeError("invalid MCP provenance");
    const { $cellarerMcp: _evidence, ...body } = raw;
    return { ...serverFromRaw(body), sourceDialect: evidence.sourceDialect };
  }
  const dia = withDefaults(dialect);
  const source = dialect ? { sourceDialect: mcpDialectIdentity(dialect) } : {};
  const known: string[] = [];
  if (
    (Array.isArray(raw.command) && raw.command.some((value) => typeof value !== "string")) ||
    (raw.http_headers !== undefined && !isStringRecord(raw.http_headers)) ||
    (raw.args !== undefined &&
      (!Array.isArray(raw.args) || raw.args.some((value) => typeof value !== "string"))) ||
    (raw[dia.envKey] !== undefined && !isStringRecord(raw[dia.envKey])) ||
    (raw.headers !== undefined && !isStringRecord(raw.headers))
  )
    return { kind: "custom", config: { ...raw }, ...source };

  // command:标量方言取字符串;数组方言取首元为 command、其余为 args。
  let command: string | undefined;
  let argsFromCommand: string[] | undefined;
  if (dia.commandStyle === "array" && Array.isArray(raw.command) && raw.command.length > 0) {
    command = String(raw.command[0]);
    argsFromCommand = raw.command.slice(1).map(String);
    known.push("command");
  } else if (dia.commandStyle === "scalar" && typeof raw.command === "string") {
    command = raw.command;
    known.push("command", "args");
  }

  if (command !== undefined) {
    const server: McpStdioServer = { kind: "stdio", command, ...source };
    if (argsFromCommand && argsFromCommand.length > 0) {
      server.args = argsFromCommand;
    } else if (dia.commandStyle === "scalar" && Array.isArray(raw.args)) {
      server.args = raw.args.map(String);
    }
    const env = toStringRecord(raw[dia.envKey]);
    if (env) server.env = env;
    known.push(dia.envKey);
    // type 判别字段由 serverToRaw 重新生成,不进 extra(避免回写重复/陈旧)。
    if (dia.typeField) known.push(dia.typeField);
    if (raw.type === "stdio") known.push("type");
    const extra = extraFields(raw, known);
    if (extra) server.extra = extra;
    return server;
  }

  const urlKey =
    dia.semanticDialect === "gemini" && typeof raw.httpUrl === "string" ? "httpUrl" : dia.urlKey;
  if (typeof raw[urlKey] === "string") {
    const transport =
      raw.type === "sse"
        ? "sse"
        : ["http", "streamable-http"].includes(String(raw.type))
          ? "streamable-http"
          : dia.semanticDialect === "gemini"
            ? urlKey === "httpUrl"
              ? "streamable-http"
              : "sse"
            : dia.semanticDialect === "codex"
              ? "streamable-http"
              : undefined;
    const server: McpRemoteServer = {
      kind: "remote",
      url: raw[urlKey] as string,
      ...source,
      ...(transport ? { transport } : {}),
    };
    const headersKey = dia.semanticDialect === "codex" ? "http_headers" : "headers";
    const headers = toStringRecord(raw[headersKey]);
    if (headers) server.headers = headers;
    const knownRemote = [urlKey, headersKey];
    if (dia.typeField) knownRemote.push(dia.typeField);
    if (["sse", "http", "streamable-http"].includes(String(raw.type))) knownRemote.push("type");
    const extra = extraFields(raw, knownRemote);
    if (extra) server.extra = extra;
    return server;
  }
  return { kind: "custom", config: { ...raw }, ...source };
}

// canonical → 原生 server 对象(写回 agent 文件用)。dialect 缺省为 standard。
export function serverToRaw(server: McpServer, dialect?: McpDialect): Record<string, unknown> {
  const dia = withDefaults(dialect);
  const provenance =
    !dialect && server.sourceDialect
      ? { $cellarerMcp: { sourceDialect: server.sourceDialect } }
      : {};
  switch (server.kind) {
    case "stdio": {
      // extra 先铺底,再写 type(若方言要求)+ 规范字段(规范字段优先,顺序稳定)。
      const out: Record<string, unknown> = { ...server.extra, ...provenance };
      if (dia.typeField && dia.stdioType) out[dia.typeField] = dia.stdioType;
      if (dia.commandStyle === "array") {
        out.command = [server.command, ...(server.args ?? [])];
      } else {
        out.command = server.command;
        if (server.args && server.args.length > 0) out.args = server.args;
      }
      if (server.env && Object.keys(server.env).length > 0) out[dia.envKey] = server.env;
      return out;
    }
    case "remote": {
      const out: Record<string, unknown> = { ...server.extra, ...provenance };
      if (dia.typeField && dia.remoteType) out[dia.typeField] = dia.remoteType;
      const urlKey =
        dia.semanticDialect === "gemini" && server.transport === "streamable-http"
          ? "httpUrl"
          : dia.urlKey;
      out[urlKey] = server.url;
      if (
        server.transport &&
        server.transport !== "unknown" &&
        !["gemini", "codex"].includes(dia.semanticDialect ?? "")
      )
        out.type = server.transport === "streamable-http" ? "http" : "sse";
      if (server.headers && Object.keys(server.headers).length > 0)
        out[dia.semanticDialect === "codex" ? "http_headers" : "headers"] = server.headers;
      return out;
    }
    case "custom":
      return { ...server.config, ...provenance };
  }
}

// 解析一整组原生 servers(name → raw)→ canonical set。
export function serverSetFromRaw(raw: Record<string, unknown>, dialect?: McpDialect): McpServerSet {
  const set: McpServerSet = Object.create(null);
  for (const [name, value] of Object.entries(raw)) {
    set[name] = serverFromRaw(value, dialect);
  }
  return set;
}

// canonical set → 原生 servers 对象(name → raw)。
export function serverSetToRaw(set: McpServerSet, dialect?: McpDialect): Record<string, unknown> {
  const raw: Record<string, unknown> = Object.create(null);
  for (const [name, server] of Object.entries(set)) {
    raw[name] = serverToRaw(server, dialect);
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
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(raw)) {
    if (!known.includes(k)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function mcpDialectIdentity(dialect?: McpDialect): string {
  const d = withDefaults(dialect);
  return JSON.stringify([
    dialect?.nativeId ?? null,
    d.semanticDialect ?? "standard",
    d.commandStyle,
    d.envKey,
    d.urlKey,
    d.typeField ?? null,
    d.stdioType ?? null,
    d.remoteType ?? null,
    [...(dialect?.expansionPositions ?? [])].sort(),
  ]);
}
function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((item) => typeof item === "string");
}
