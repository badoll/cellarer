// .gitignore managed block(照抄 ruler GitignoreUtils 算法,改 marker 文案,见计划 §7.3)。
// 算法:整块替换;路径相对化 + POSIX + 前导 /;过滤库房自身/越界路径;.bak 一并 ignore。
// 注意:本文件只用 node:path(纯路径计算),fs 经 Env 注入。
import { isAbsolute, join } from "node:path";
import type { Env } from "../env.js";
import { BAK_SUFFIX } from "./backup.js";
import { readFileOrNull } from "./probe.js";
import { relativeInside } from "./safety.js";

export const GITIGNORE_START = "# START cellarer Generated Files";
export const GITIGNORE_END = "# END cellarer Generated Files";

export function gitignorePath(projectDir: string): string {
  if (!isAbsolute(projectDir)) {
    throw new TypeError("gitignore project root must be absolute");
  }
  return join(projectDir, ".gitignore");
}

// 把绝对路径相对化到 projectDir、POSIX 化、加前导 /;越界(库房真源等)返回 null 过滤掉。
function toIgnoreLine(absPath: string, projectDir: string): string | null {
  const rel = relativeInside(projectDir, absPath);
  if (rel === null) return null; // 在 project 之外 → 不写入 ignore
  return `/${rel.split(/[\\/]/).join("/")}`;
}

// 构造 managed block 文本(每个目标 + 其 .bak)。
function buildBlock(targets: string[], projectDir: string): string {
  const lines: string[] = [];
  for (const abs of targets) {
    const line = toIgnoreLine(abs, projectDir);
    if (line === null) continue;
    lines.push(line);
    lines.push(`${line}${BAK_SUFFIX}`);
  }
  // 去重保序。
  const unique = [...new Set(lines)];
  return [GITIGNORE_START, ...unique, GITIGNORE_END].join("\n");
}

// 从既有内容中剥离 managed block(含首尾 marker 行),返回剩余文本。
function stripBlock(content: string): string {
  const startIdx = content.indexOf(GITIGNORE_START);
  if (startIdx === -1) return content;
  const endIdx = content.indexOf(GITIGNORE_END, startIdx);
  if (endIdx === -1) return content;
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + GITIGNORE_END.length);
  // 拼接并归一多余空行:去掉 block 前后遗留的连续空行。
  const joined = `${before.replace(/\n+$/, "\n")}${after.replace(/^\n+/, "")}`;
  return joined;
}

export async function updateGitignore(
  env: Env,
  projectDir: string,
  targets: string[],
): Promise<void> {
  const giPath = gitignorePath(projectDir);
  const existing = (await readFileOrNull(env, giPath)) ?? "";
  const body = renderGitignore(existing, projectDir, targets);
  if (body === null) return;
  await env.fs.writeFile(giPath, body);
}

// 移除 managed block;若移除后内容为空则删除整个 .gitignore。
export async function removeManagedBlock(env: Env, projectDir: string): Promise<void> {
  const giPath = gitignorePath(projectDir);
  const existing = await readFileOrNull(env, giPath);
  if (existing === null) return; // 无 .gitignore → no-op
  const rendered = renderGitignore(existing, projectDir, []);
  if (rendered === null) {
    await env.fs.rm(giPath, { force: true });
    return;
  }
  await env.fs.writeFile(giPath, rendered);
}

export function renderGitignore(
  existing: string | null,
  projectDir: string,
  targets: readonly string[],
): string | null {
  if (targets.length === 0) {
    if (existing === null) return null;
    const stripped = stripBlock(existing).trim();
    return stripped.length === 0 ? null : `${stripped}\n`;
  }
  const withoutBlock = stripBlock(existing ?? "");
  const block = buildBlock([...targets], projectDir);
  // 用户区在前、managed block 在后;用户区非空则用一个空行隔开。
  const head = withoutBlock.trimEnd();
  return head.length > 0 ? `${head}\n\n${block}\n` : `${block}\n`;
}
