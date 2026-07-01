// add:从源导入制品到库房(kickoff §13)。本迭代实现**本地路径**导入;
// owner/repo 与 URL 源给出友好「暂未实现」提示(非 unknown command)。
// 副作用经 Env(不变量 2);导入即过写前明文护栏(密钥零明文红线):命中明文拒绝入库。
import { basename, extname } from "node:path";
import type { Env } from "../env.js";
import { readdirOrEmpty, statOrNull } from "../fs/probe.js";
import { type McpServer, serverFromRaw } from "../mcp/model.js";
import type { ArtifactKind } from "../model/index.js";
import { detectSecret, scanTextForSecrets } from "../secrets/detector.js";
import {
  importSkillArtifact,
  listMcpArtifacts,
  listRuleArtifacts,
  listSkillArtifacts,
  writeMcpArtifact,
  writeRuleArtifact,
} from "../store/store.js";

export interface AddOptions {
  storeRoot: string;
  source: string;
  // 同名制品已存在时:false(默认)跳过并告警;true 覆盖。
  force?: boolean;
}

export interface AddResult {
  imported: { kind: ArtifactKind; name: string; path: string }[];
  skipped: { kind: ArtifactKind; name: string; reason: string }[];
  rejected: { kind: ArtifactKind; name: string; reason: string }[];
}

// 源类型判定:URL / owner/repo(git)/ 本地路径。本地优先(存在即本地),
// 避免把恰好形如 owner/repo 的本地相对目录误判为 git 源。
function classifySource(source: string): "url" | "git" {
  if (/^https?:\/\//i.test(source)) return "url";
  return "git"; // owner/repo 形态;非本地路径的兜底
}

// 按扩展名/目录推断制品类型:.md→rules;.json→mcp;目录→skills。
function inferKind(isDir: boolean, source: string): ArtifactKind {
  if (isDir) return "skills";
  const ext = extname(source).toLowerCase();
  if (ext === ".md") return "rules";
  if (ext === ".json") return "mcp";
  throw new Error(
    `unsupported source file type "${ext || "(none)"}" — supported: .md (rules), .json (mcp), directory (skills)`,
  );
}

// 制品名:取 basename 去扩展名。
function deriveName(source: string, isDir: boolean): string {
  return isDir ? basename(source) : basename(source, extname(source));
}

// 已存在同名制品?(dedup 判定,列库房制品比对 name)
async function nameExists(
  env: Env,
  storeRoot: string,
  kind: ArtifactKind,
  name: string,
): Promise<boolean> {
  const list =
    kind === "rules"
      ? await listRuleArtifacts(env, storeRoot)
      : kind === "mcp"
        ? await listMcpArtifacts(env, storeRoot)
        : await listSkillArtifacts(env, storeRoot);
  return list.some((a) => a.name === name);
}

// 收集目录下所有文件文本(用于 skills 写前明文护栏);经 Env.fs 遍历。
async function collectDirText(env: Env, dir: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const name of await readdirOrEmpty(env, d)) {
      const full = `${d}/${name}`;
      const st = await env.fs.lstat(full);
      if (st.isDirectory()) await walk(full);
      else if (st.isFile()) parts.push(await env.fs.readFile(full));
    }
  };
  await walk(dir);
  return parts.join("\n");
}

// skill 目录内是否含符号链接(任意深度)。含则拒绝导入:
// collectDirText 用 lstat 不跟随软链 → 软链内容不被扫描,而 importSkillArtifact 的 cp 会原样拷软链,
// 造成「护栏放行但库房出现指向宿主机(可能是密钥)的软链」的红线绕过。故一律拒绝含软链的 skill。
async function findSymlink(env: Env, dir: string): Promise<string | null> {
  for (const name of await readdirOrEmpty(env, dir)) {
    const full = `${dir}/${name}`;
    const st = await env.fs.lstat(full);
    if (st.isSymbolicLink()) return full;
    if (st.isDirectory()) {
      const nested = await findSymlink(env, full);
      if (nested) return nested;
    }
  }
  return null;
}

// mcp 结构化密钥检测(名字启发 + 高熵,强于纯文本的 high-value 前缀扫描):
// 递归遍历 server 的所有字符串叶子(env/headers/url/args/extra/custom.config 全覆盖),
// 用**裸字段名**喂 detectSecret(SECRET_NAME_RE 以 ^ _ - 为边界,前缀点号会破坏名字启发),
// 命中返回**带路径的**标签(不含真值),供拒绝入库(add 语义是拒绝而非静默脱敏,促使用户改用占位符)。
function mcpSecretFields(server: McpServer): string[] {
  const hits: string[] = [];
  // path 是给用户看的定位标签(如 env.API_KEY);leaf 是裸键名(如 API_KEY),用于名字启发。
  const walk = (value: unknown, path: string, leaf: string): void => {
    if (typeof value === "string") {
      if (detectSecret(value, leaf)) hits.push(path);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(v, `${path}[${i}]`, leaf);
      });
    } else if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, k);
    }
  };

  if (server.kind === "stdio") {
    walk(server.env, "env", "env");
    walk(server.args, "args", "args");
    walk(server.extra, "", ""); // extra 顶层键即字段名
  } else if (server.kind === "remote") {
    if (detectSecret(server.url, "url")) hits.push("url");
    walk(server.headers, "headers", "headers");
    walk(server.extra, "", "");
  } else {
    walk(server.config, "", ""); // custom:递归全部字符串叶子
  }
  return hits;
}

export async function add(env: Env, opts: AddOptions): Promise<AddResult> {
  const result: AddResult = { imported: [], skipped: [], rejected: [] };

  // 本地优先:存在即按本地导入;否则按源格式给友好桩。
  const st = await statOrNull(env, opts.source);
  if (st === null) {
    const kind = classifySource(opts.source);
    const hint =
      kind === "url"
        ? "URL 源导入暂未实现,请先下载到本地后用本地路径导入。"
        : "git(owner/repo)源导入暂未实现,请先 clone 到本地后用本地路径导入。";
    throw new Error(`${hint}(source: "${opts.source}")`);
  }

  const isDir = st.isDirectory();
  const kind = inferKind(isDir, opts.source);
  const name = deriveName(opts.source, isDir);

  // dedup:同名已存在且未 --force → 跳过。
  if (!opts.force && (await nameExists(env, opts.storeRoot, kind, name))) {
    result.skipped.push({ kind, name, reason: "already exists (use --force to overwrite)" });
    return result;
  }

  const reject = (reason: string): AddResult => {
    result.rejected.push({ kind, name, reason });
    return result;
  };

  // skills:含符号链接一律拒绝(软链内容不被扫描却会被 cp 原样拷入库房 → 红线绕过,见 findSymlink 注释)。
  if (kind === "skills") {
    const link = await findSymlink(env, opts.source);
    if (link !== null) {
      return reject(`skill contains a symlink (${link}) — symlinks are not safely importable`);
    }
  }

  // 写前明文护栏 1(零明文红线):内容含高置信明文密钥(前缀格式)→ 拒绝。覆盖 rules/skills 自由文本。
  const payloadText = isDir
    ? await collectDirText(env, opts.source)
    : await env.fs.readFile(opts.source);
  const textHits = scanTextForSecrets(payloadText);
  if (textHits.length > 0) {
    return reject(
      `plaintext secret(s) [${textHits.map((h) => h.rule).join(", ")}] — replace with \${ENV} or \${CELLARER_SECRET:name} before importing`,
    );
  }

  // 落库(store 写入器内部 assertSafeName;mcp 经 serverFromRaw 规范化)。
  let path: string;
  if (kind === "rules") {
    path = await writeRuleArtifact(env, opts.storeRoot, name, payloadText);
  } else if (kind === "mcp") {
    let raw: unknown;
    try {
      raw = JSON.parse(payloadText);
    } catch (err) {
      throw new Error(
        `invalid mcp source ${opts.source}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const server = serverFromRaw(raw);
    // 写前明文护栏 2(mcp 结构化):env/headers/args/url/custom 字段按名字启发+高熵检测。
    // 强于纯文本前缀扫描 —— 非前缀格式的结构化密钥(如 32-hex 的 API_KEY)在此拦下(对齐 scan 脱敏口径)。
    const fieldHits = mcpSecretFields(server);
    if (fieldHits.length > 0) {
      return reject(
        `plaintext secret in mcp field(s) [${fieldHits.join(", ")}] — replace with \${ENV} or \${CELLARER_SECRET:name} before importing`,
      );
    }
    path = await writeMcpArtifact(env, opts.storeRoot, name, server);
  } else {
    path = await importSkillArtifact(env, opts.storeRoot, name, opts.source);
  }

  result.imported.push({ kind, name, path });
  return result;
}
