// fs 探测助手:把「读文件/探状态,不存在则回退」这一在 store/engine/fs 多处重复 6+ 次的
// try/catch 模式收敛为一处。返回 null 表示路径不存在。
import type { Env, FileStat } from "../env.js";

export async function readFileOrNull(env: Env, path: string): Promise<string | null> {
  try {
    return await env.fs.readFile(path);
  } catch {
    return null;
  }
}

export async function lstatOrNull(env: Env, path: string): Promise<FileStat | null> {
  try {
    return await env.fs.lstat(path);
  } catch {
    return null;
  }
}
