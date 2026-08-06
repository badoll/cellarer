// 库房读写(布局见 kickoff §7.1)。rules(store/rules/*.md)/ mcp(store/mcp/*.json)/ skills(store/skills/<name>/)。
import { join } from "node:path";
import type { RuleFragment } from "../adapters/types.js";
import type { Env } from "../env.js";
import { atomicWrite } from "../fs/atomicWrite.js";
import { linkOrCopy } from "../fs/linkOrCopy.js";
import { lstatOrNull, readdirOrEmpty, readFileOrNull } from "../fs/probe.js";
import { type McpServer, serverFromRaw, serverToRaw } from "../mcp/model.js";
import type { Artifact } from "../model/index.js";
import {
  parseResourceRecord,
  type ResourceRecord,
  resolveCurrentResourceArtifact,
  resourceMetadataPath,
} from "../resources/model.js";
import { assertFinalSerializedSecretBytes } from "../secrets/final-bytes.js";
import { observableKnownValues } from "../secrets/observable.js";
import { captureSafeRecursiveSource, UnsafeRecursiveSourceError } from "../secrets/safe-tree.js";
import { CONFIG_FILENAME, initialConfigText } from "./config.js";

// 库房根:CELLARER_HOME 覆盖,否则 ~/.cellarer。
export function resolveStoreRoot(env: Env): string {
  const override = env.env.CELLARER_HOME;
  if (override && override.length > 0) return override;
  return join(env.homedir(), ".cellarer");
}

export interface InitResult {
  storeRoot: string;
  createdConfig: boolean; // 是否新建了 config.json(已存在则不覆盖)
}

// 初始化库房骨架:建 store/{rules,mcp,skills} 与 metadata;config.json 不存在才写(幂等)。
export async function initStore(env: Env, storeRoot: string): Promise<InitResult> {
  await env.fs.mkdir(join(storeRoot, "store", "rules"), { recursive: true });
  await env.fs.mkdir(join(storeRoot, "store", "mcp"), { recursive: true });
  await env.fs.mkdir(join(storeRoot, "store", "skills"), { recursive: true });
  await env.fs.mkdir(skillMetadataDir(storeRoot), { recursive: true });

  const jsonPath = join(storeRoot, CONFIG_FILENAME);
  const existing = await readFileOrNull(env, jsonPath);
  if (existing !== null) {
    return { storeRoot, createdConfig: false };
  }

  await env.fs.writeFile(jsonPath, await initialConfigText(env));
  return { storeRoot, createdConfig: true };
}

function rulesDir(storeRoot: string): string {
  return join(storeRoot, "store", "rules");
}
function mcpDir(storeRoot: string): string {
  return join(storeRoot, "store", "mcp");
}
function skillsDir(storeRoot: string): string {
  return join(storeRoot, "store", "skills");
}
function skillMetadataDir(storeRoot: string): string {
  return join(storeRoot, "store", "metadata", "skills");
}

// 列出 rules 制品(store/rules/*.md);按名字母序;非 .md 跳过。
export async function listRuleArtifacts(env: Env, storeRoot: string): Promise<Artifact[]> {
  const dir = rulesDir(storeRoot);
  const entries = await readdirOrEmpty(env, dir);
  const names = entries
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -".md".length))
    .sort((a, b) => a.localeCompare(b));
  return attachImmutableResourceIds(
    env,
    storeRoot,
    names.map((name) => ({
      id: `rules/${name}`,
      kind: "rules",
      name,
      sourcePath: join(dir, `${name}.md`),
      collections: [],
    })),
  );
}

// 读取单个 rule 制品为 fragment(relPath 相对 store/,POSIX 化交由 markers 处理)。
export async function readRuleArtifact(
  env: Env,
  storeRoot: string,
  artifactId: string,
): Promise<RuleFragment> {
  const name = artifactId.replace(/^rules\//, "");
  const abs = join(rulesDir(storeRoot), `${name}.md`);
  const snapshot = await captureSafeRecursiveSource(env, abs);
  if (snapshot.kind !== "file" || snapshot.files.length !== 1) {
    throw new UnsafeRecursiveSourceError(abs, "non-regular");
  }
  const content = snapshot.files[0]?.content ?? "";
  return { relPath: `rules/${name}.md`, content };
}

// 列出 mcp 制品(store/mcp/*.json);制品 id "mcp/<name>",server 名即 <name>。
export async function listMcpArtifacts(env: Env, storeRoot: string): Promise<Artifact[]> {
  const dir = mcpDir(storeRoot);
  const entries = await readdirOrEmpty(env, dir);
  const names = entries
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort((a, b) => a.localeCompare(b));
  return attachImmutableResourceIds(
    env,
    storeRoot,
    names.map((name) => ({
      id: `mcp/${name}`,
      kind: "mcp",
      name,
      sourcePath: join(dir, `${name}.json`),
      collections: [],
    })),
  );
}

// 读取单个 mcp 制品:库房 JSON 文件 → canonical server。
// 库房文件形态:单 server 对象({command,args,env} 或 {url,headers}),server 名 = 制品名。
export async function readMcpArtifact(
  env: Env,
  storeRoot: string,
  artifactId: string,
): Promise<{ name: string; server: McpServer }> {
  const name = artifactId.replace(/^mcp\//, "");
  const abs = join(mcpDir(storeRoot), `${name}.json`);
  const snapshot = await captureSafeRecursiveSource(env, abs);
  if (snapshot.kind !== "file" || snapshot.files.length !== 1) {
    throw new UnsafeRecursiveSourceError(abs, "non-regular");
  }
  const content = snapshot.files[0]?.content ?? "";
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    // 单个脏制品不应以裸 SyntaxError 崩掉整批下发;给出可定位文件的错误。
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid mcp artifact ${abs}: ${msg}`);
  }
  return { name, server: serverFromRaw(raw) };
}

// 列出 skills 制品(store/skills/<name>/ 目录);每个子目录是一个 skill。
export async function listSkillArtifacts(env: Env, storeRoot: string): Promise<Artifact[]> {
  const dir = skillsDir(storeRoot);
  const entries = await readdirOrEmpty(env, dir);
  // 并行 lstat(用 lstatOrNull 收敛「不存在→null」,与项目数据安全约定一致);仅目录算 skill。
  const stats = await Promise.all(entries.map((name) => lstatOrNull(env, join(dir, name))));
  const names = entries
    .filter((name, i) => name !== ".cellarer-revisions" && stats[i]?.isDirectory())
    .sort((a, b) => a.localeCompare(b));
  return attachImmutableResourceIds(
    env,
    storeRoot,
    names.map((name) => ({
      id: `skills/${name}`,
      kind: "skills",
      name,
      sourcePath: join(dir, name),
      collections: [],
    })),
  );
}

async function attachImmutableResourceIds(
  env: Env,
  storeRoot: string,
  artifacts: Artifact[],
): Promise<Artifact[]> {
  return Promise.all(
    artifacts.map(async (artifact) => {
      const current = await resolveCurrentResourceArtifact(env, storeRoot, artifact);
      return {
        ...current.artifact,
        id: current.record.resourceId,
        name: current.record.name,
      };
    }),
  );
}

// —— 扫描回写(M3):写入库房制品。文件名安全(防路径穿越);内容已脱敏由调用方保证。 ——

// 制品名安全校验:只允许字母数字/下划线/连字符/点(不含路径分隔与 ..),否则抛错。
// 防止扫描来的 server/skill 名带 ../ 把写入穿越到库房外。
function assertSafeName(name: string): void {
  if (name.length === 0 || !/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new Error(`unsafe artifact name "${name}" (allowed: letters, digits, . _ -)`);
  }
}

export function isSafeArtifactName(name: string): boolean {
  try {
    assertSafeName(name);
    return true;
  } catch {
    return false;
  }
}

// 写入 rule 制品(store/rules/<name>.md)。原子写。
export async function writeRuleArtifact(
  env: Env,
  storeRoot: string,
  name: string,
  content: string,
): Promise<string> {
  assertSafeName(name);
  const abs = join(rulesDir(storeRoot), `${name}.md`);
  assertFinalSerializedSecretBytes(content, observableKnownValues(env), abs);
  await atomicWrite(env, abs, content);
  return abs;
}

// 写入 mcp 制品(store/mcp/<name>.json,单 server 对象)。调用方须先脱敏(零明文红线)。
export async function writeMcpArtifact(
  env: Env,
  storeRoot: string,
  name: string,
  server: McpServer,
): Promise<string> {
  assertSafeName(name);
  const abs = join(mcpDir(storeRoot), `${name}.json`);
  const serialized = `${JSON.stringify(serverToRaw(server), null, 2)}\n`;
  assertFinalSerializedSecretBytes(serialized, observableKnownValues(env), abs);
  await atomicWrite(env, abs, serialized);
  return abs;
}

// 导入 skill 目录到库房(store/skills/<name>/),从 srcDir 拷贝(扫描回写恒用 copy:库房是真源,
// 不软链回 agent 目录,避免循环/破链)。
export async function importSkillArtifact(
  env: Env,
  storeRoot: string,
  name: string,
  srcDir: string,
): Promise<string> {
  assertSafeName(name);
  const abs = join(skillsDir(storeRoot), name);
  await linkOrCopy(env, srcDir, abs, {
    method: "copy",
    kind: "dir",
    // store import 的 collision policy 已由调用方决定；此处不是 agent target placement。
    replaceExisting: true,
  });
  return abs;
}

export function skillProvenancePath(storeRoot: string, name: string): string {
  return resourceMetadataPath(storeRoot, "skills", name);
}

export async function writeSkillProvenance(
  env: Env,
  storeRoot: string,
  name: string,
  provenance: ResourceRecord,
): Promise<string> {
  const abs = skillProvenancePath(storeRoot, name);
  const validated = parseResourceRecord(provenance);
  if (validated.kind !== "skills" || validated.name !== name) {
    throw new TypeError("skill provenance identity does not match target");
  }
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  assertFinalSerializedSecretBytes(serialized, observableKnownValues(env), abs);
  await env.fs.mkdir(skillMetadataDir(storeRoot), { recursive: true });
  await atomicWrite(env, abs, serialized);
  return abs;
}
