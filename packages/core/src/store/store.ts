// 库房读写(布局见 kickoff §7.1)。M1 仅 rules 制品;M2 扩展 mcp/skills。
import { join } from "node:path";
import type { RuleFragment } from "../adapters/types.js";
import type { Env } from "../env.js";
import type { Artifact } from "../model/index.js";

// 库房根:CELLARER_HOME 覆盖,否则 ~/.cellarer。
export function resolveStoreRoot(env: Env): string {
  const override = env.env.CELLARER_HOME;
  if (override && override.length > 0) return override;
  return join(env.homedir(), ".cellarer");
}

function rulesDir(storeRoot: string): string {
  return join(storeRoot, "store", "rules");
}

// 列出 rules 制品(store/rules/*.md);按名字母序;非 .md 跳过。
export async function listRuleArtifacts(env: Env, storeRoot: string): Promise<Artifact[]> {
  const dir = rulesDir(storeRoot);
  let entries: string[];
  try {
    entries = await env.fs.readdir(dir);
  } catch {
    return [];
  }
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
