// 库房读写(布局见 kickoff §7.1)。M1 仅 rules 制品;M2 扩展 mcp/skills。
import { join } from "node:path";
import type { RuleFragment } from "../adapters/types.js";
import type { Env } from "../env.js";
import { readdirOrEmpty, readFileOrNull } from "../fs/probe.js";
import type { Artifact } from "../model/index.js";

// 库房根:CELLARER_HOME 覆盖,否则 ~/.cellarer。
export function resolveStoreRoot(env: Env): string {
  const override = env.env.CELLARER_HOME;
  if (override && override.length > 0) return override;
  return join(env.homedir(), ".cellarer");
}

// 初始库房配置模板(注释 + 与 config.ts schema 默认一致的字段)。
// 单一来源在 core,CLI init 不再内联,避免与 schema 默认漂移(不变量 1)。
export const DEFAULT_CONFIG_TOML = `# cellarer 库房配置
[defaults]
method = "symlink"
channels = ["common"]
secret_mode = "env"

[defaults.os.win32]
method = "copy"

[channels.common]
description = "通用"
`;

export interface InitResult {
  storeRoot: string;
  createdConfig: boolean; // 是否新建了 cellarer.toml(已存在则不覆盖)
}

// 初始化库房骨架:建 store/rules + adapters 目录;cellarer.toml 不存在才写(幂等)。
export async function initStore(env: Env, storeRoot: string): Promise<InitResult> {
  await env.fs.mkdir(join(storeRoot, "store", "rules"), { recursive: true });
  await env.fs.mkdir(join(storeRoot, "adapters"), { recursive: true });
  const tomlPath = join(storeRoot, "cellarer.toml");
  const existing = await readFileOrNull(env, tomlPath);
  if (existing !== null) {
    return { storeRoot, createdConfig: false };
  }
  await env.fs.writeFile(tomlPath, DEFAULT_CONFIG_TOML);
  return { storeRoot, createdConfig: true };
}

function rulesDir(storeRoot: string): string {
  return join(storeRoot, "store", "rules");
}

// 列出 rules 制品(store/rules/*.md);按名字母序;非 .md 跳过。
export async function listRuleArtifacts(env: Env, storeRoot: string): Promise<Artifact[]> {
  const dir = rulesDir(storeRoot);
  const entries = await readdirOrEmpty(env, dir);
  const names = entries
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -".md".length))
    .sort((a, b) => a.localeCompare(b));
  return names.map((name) => ({
    id: `rules/${name}`,
    kind: "rules",
    name,
    sourcePath: join(dir, `${name}.md`),
    channels: [],
  }));
}

// 读取单个 rule 制品为 fragment(relPath 相对 store/,POSIX 化交由 markers 处理)。
export async function readRuleArtifact(
  env: Env,
  storeRoot: string,
  artifactId: string,
): Promise<RuleFragment> {
  const name = artifactId.replace(/^rules\//, "");
  const abs = join(rulesDir(storeRoot), `${name}.md`);
  const content = await env.fs.readFile(abs);
  return { relPath: `rules/${name}.md`, content };
}
