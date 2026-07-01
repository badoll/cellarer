// 目录内容指纹(sha256):文件相对路径 + 内容,用于 skills 的内容级漂移检测(横评 §5.2)。
// copy 落地的 skill 目录被手改后,hashDir(target) 会与台账记录的 hashDir(source) 不符 → status 报 drifted。
// 经 Env.fs 遍历(不变量 2:core 不直接 import node:fs);符号链接不跟随(只对真实目录用)。
import { relative } from "node:path";
import type { Env } from "../env.js";
import { sha256 } from "../store/checksum.js";

// 递归列出 dir 下所有文件的「相对 base 的正斜杠路径」,已排序(保证指纹稳定、跨平台一致)。
async function listFilesSorted(env: Env, dir: string, base: string): Promise<string[]> {
  const names = (await env.fs.readdir(dir)).sort();
  const files: string[] = [];
  for (const name of names) {
    const full = `${dir}/${name}`;
    const st = await env.fs.lstat(full);
    if (st.isDirectory()) {
      files.push(...(await listFilesSorted(env, full, base)));
    } else if (st.isFile()) {
      // 相对路径统一用正斜杠,避免 Windows 反斜杠让同一内容产出不同指纹。
      files.push(relative(base, full).split(/[\\/]/).join("/"));
    }
    // 软链等其它类型:跳过(skill 目录内一般只有文件/子目录)。
  }
  return files;
}

// 目录内容指纹:对每个文件计 sha256(路径) + sha256(内容),两者都是定长 hex —— 拼接无边界歧义,
// 故无论路径/内容含何字节(含 NUL、二进制)都不会碰撞;逐行(定长)再取整体 sha256。
export async function hashDir(env: Env, dir: string): Promise<string> {
  const files = await listFilesSorted(env, dir, dir);
  const lines: string[] = [];
  for (const rel of files) {
    const content = await env.fs.readFile(`${dir}/${rel}`);
    lines.push(`${sha256(rel)}:${sha256(content)}`);
  }
  return sha256(lines.join("\n"));
}
