// 原子写:先写同目录临时文件再 rename,避免半截写入污染目标。
// rename 同目录内是原子操作(同一文件系统);临时名带计数器避免并发碰撞。
import { dirname, join } from "node:path";
import type { Env } from "../env.js";

let counter = 0;

export async function atomicWrite(env: Env, path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await env.fs.mkdir(dir, { recursive: true });
  // 临时名:不依赖 Math.random(Env 不提供随机源),用进程内自增计数器即可。
  counter += 1;
  const tmp = join(dir, `.cellarer-tmp-${counter}`);
  await env.fs.writeFile(tmp, content);
  await env.fs.rename(tmp, path);
}
