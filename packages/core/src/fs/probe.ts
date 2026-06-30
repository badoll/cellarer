// fs 探测助手:把「读文件/探状态,不存在则回退」这一在 store/engine/fs 多处重复的
// try/catch 模式收敛为一处。返回 null 仅表示「路径不存在」(ENOENT/ENOTDIR);
// 其余错误(EACCES/EISDIR/EIO 等)必须上抛 —— 否则会把「存在但读不了」误判为「不存在」,
// 进而 backup 漏备份后被覆盖、台账被当空重写,造成静默数据丢失。
import type { Env, FileStat } from "../env.js";

// 仅「不存在」类错误视为缺失;其余重新抛出。
function isNotFound(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function readFileOrNull(env: Env, path: string): Promise<string | null> {
  try {
    return await env.fs.readFile(path);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function lstatOrNull(env: Env, path: string): Promise<FileStat | null> {
  try {
    return await env.fs.lstat(path);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

// readdir 版本(store/rules 与 adapters 目录探测共用);不存在 → 空数组。
export async function readdirOrEmpty(env: Env, path: string): Promise<string[]> {
  try {
    return await env.fs.readdir(path);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}
