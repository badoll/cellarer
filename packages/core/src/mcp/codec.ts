// McpCodec:把 canonical server 集合编入/读出某 agent 的原生 mcp 文件(JSON / TOML)。
// 关键约束(不变量 4):格式 + 字段方言全部在 codec 内自洽,引擎只给 canonical + 策略。
// 关键约束(不变量 5 幂等):内容未变时 encode 必须产出与既有字节一致的文本(由 apply 短路依赖)。
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { findServersKey, type MergeStrategy, mergeServerSets } from "./merge.js";
import {
  isPlainObject,
  type McpDialect,
  type McpServerSet,
  serverSetFromRaw,
  serverSetToRaw,
} from "./model.js";

// 读出既有文件里的 servers 段(canonical)。文件不存在/空 → 空集合。
export interface McpDecodeResult {
  servers: McpServerSet;
  // 整个文档对象(servers 段之外的字段,overwrite/merge 都要保留)。
  doc: Record<string, unknown>;
  // 实际使用的 servers 键名(写回时沿用,避免改动用户既有键)。
  serversKey: string;
}

export interface McpCodec {
  format: "json" | "toml";
  dialect?: McpDialect;
  // 解析既有文件内容(null = 不存在)为 canonical + 文档余量。
  decode(content: string | null, preferredKey: string): McpDecodeResult;
  // 把合并后的 servers 段写回文档,渲染为文件文本。
  encode(decoded: McpDecodeResult, merged: McpServerSet): string;
}

// merge/overwrite 的纯逻辑:在 canonical 层合并,再交给 codec 渲染。返回渲染后的文件文本。
// 既有文件解析失败(用户手改出语法错/注释)→ 抛带 label 的可操作错误,而非裸 SyntaxError 崩整批。
export function applyMerge(
  codec: McpCodec,
  existingContent: string | null,
  incoming: McpServerSet,
  preferredKey: string,
  strategy: MergeStrategy,
  label?: string,
): string {
  let decoded: McpDecodeResult;
  try {
    decoded = codec.decode(existingContent, preferredKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `invalid existing ${codec.format} mcp config${label ? ` at ${label}` : ""}: ${msg}. Fix or remove the file to proceed.`,
    );
  }
  const merged = mergeServerSets(decoded.servers, incoming, strategy);
  return codec.encode(decoded, merged);
}

// JSON codec 工厂(claude/cursor/gemini=standard;opencode/windsurf 传 dialect)。
function makeJsonCodec(dialect?: McpDialect): McpCodec {
  return {
    format: "json",
    dialect,
    decode(content, preferredKey) {
      if (content === null || content.trim().length === 0) {
        return { servers: {}, doc: {}, serversKey: preferredKey };
      }
      const parsed: unknown = JSON.parse(content);
      const doc = isPlainObject(parsed) ? parsed : {};
      const serversKey = findServersKey(doc, preferredKey);
      const rawServers = isPlainObject(doc[serversKey]) ? doc[serversKey] : {};
      return { servers: serverSetFromRaw(rawServers, dialect), doc, serversKey };
    },
    encode(decoded, merged) {
      // 保留 servers 段之外的文档字段;只替换 servers 段。
      const out: Record<string, unknown> = { ...decoded.doc };
      out[decoded.serversKey] = serverSetToRaw(merged, dialect ?? {});
      return `${JSON.stringify(out, null, 2)}\n`;
    },
  };
}

// TOML codec(codex,[mcp_servers.*] 内嵌表)。
// 注:smol-toml stringify 不保留注释(见计划 §6);非 server 字段(model 等)会保留但注释丢失 ——
//     这是 codex config.toml 写回的已知取舍,文档已记。
function makeTomlCodec(dialect?: McpDialect): McpCodec {
  return {
    format: "toml",
    dialect,
    decode(content, preferredKey) {
      if (content === null || content.trim().length === 0) {
        return { servers: {}, doc: {}, serversKey: preferredKey };
      }
      const parsed = parseToml(content) as Record<string, unknown>;
      const doc = isPlainObject(parsed) ? parsed : {};
      const serversKey = findServersKey(doc, preferredKey);
      const rawServers = isPlainObject(doc[serversKey]) ? doc[serversKey] : {};
      return { servers: serverSetFromRaw(rawServers, dialect), doc, serversKey };
    },
    encode(decoded, merged) {
      const out: Record<string, unknown> = { ...decoded.doc };
      out[decoded.serversKey] = serverSetToRaw(merged, dialect ?? {});
      // smol-toml 对空对象不产出表头;servers 段为空时清掉键,避免渲染异常。
      if (Object.keys(merged).length === 0) delete out[decoded.serversKey];
      const text = stringifyToml(out);
      return text.endsWith("\n") ? text : `${text}\n`;
    },
  };
}

// 标准方言单例(绝大多数 agent 共用,避免重复构造)。
export const jsonMcpCodec: McpCodec = makeJsonCodec();
export const tomlMcpCodec: McpCodec = makeTomlCodec();

// 按 format + 可选方言取 codec。无方言(或 standard)复用单例;有方言则构造带方言的实例。
export function mcpCodecFor(format: "json" | "toml", dialect?: McpDialect): McpCodec {
  if (!dialect) return format === "toml" ? tomlMcpCodec : jsonMcpCodec;
  return format === "toml" ? makeTomlCodec(dialect) : makeJsonCodec(dialect);
}
