// 跨平台 link/copy(借 ts-tooling + vercel skills,见计划 §7.7)。
// POSIX:fs.symlink(文件/目录皆可)。
// Windows:目录用 junction(免特权,绝对 target);文件软链需 Developer Mode,失败回退 copy。
// 任何软链失败一律回退 copy;实际 method 回传供台账记录(status/revert 据此正确处理)。
import { dirname, resolve } from "node:path";
import type { Env } from "../env.js";
import type { AppliedMethod } from "../model/index.js";
import { lstatOrNull } from "./probe.js";

export interface LinkOrCopyOpts {
  method: "symlink" | "copy";
  kind: "file" | "dir";
}

export interface LinkOrCopyResult {
  // 实际落地方式:symlink / junction / copy。
  method: Extract<AppliedMethod, "symlink" | "junction" | "copy">;
  // 幂等短路命中(已是同指向软链)→ 未做任何写入。
  skipped: boolean;
}

// dest 已是指向 src 的软链?(幂等短路,借 skills short-circuit)
async function alreadyLinkedTo(env: Env, dest: string, src: string): Promise<boolean> {
  const stat = await lstatOrNull(env, dest);
  if (!stat?.isSymbolicLink()) return false;
  try {
    return (await env.fs.realpath(dest)) === (await env.fs.realpath(src));
  } catch {
    return false;
  }
}

// 清掉 dest 处的既有条目(文件 / 目录 / 断链),为重新落地腾位。
async function clearDest(env: Env, dest: string): Promise<void> {
  if (await lstatOrNull(env, dest)) {
    await env.fs.rm(dest, { recursive: true, force: true });
  }
}

export async function linkOrCopy(
  env: Env,
  src: string,
  dest: string,
  opts: LinkOrCopyOpts,
): Promise<LinkOrCopyResult> {
  const absSrc = resolve(src);

  if (opts.method === "symlink" && (await alreadyLinkedTo(env, dest, absSrc))) {
    return {
      method: env.platform === "win32" && opts.kind === "dir" ? "junction" : "symlink",
      skipped: true,
    };
  }

  // dest 父目录就绪 + 清掉既有落地物(两种 method 都需要)。
  await env.fs.mkdir(dirname(dest), { recursive: true });
  await clearDest(env, dest);

  if (opts.method === "copy") {
    await doCopy(env, absSrc, dest, opts.kind);
    return { method: "copy", skipped: false };
  }

  if (env.platform === "win32") {
    if (opts.kind === "dir") {
      // 目录:junction(免特权),绝对 target。
      await env.fs.symlink(absSrc, dest, "junction");
      return { method: "junction", skipped: false };
    }
    // 文件:尝试软链,失败回退 copy。
    try {
      await env.fs.symlink(absSrc, dest, "file");
      return { method: "symlink", skipped: false };
    } catch {
      await doCopy(env, absSrc, dest, "file");
      return { method: "copy", skipped: false };
    }
  }

  // POSIX:文件/目录都用 symlink。
  await env.fs.symlink(absSrc, dest, opts.kind);
  return { method: "symlink", skipped: false };
}

async function doCopy(env: Env, src: string, dest: string, kind: "file" | "dir"): Promise<void> {
  if (kind === "dir") {
    await env.fs.cp(src, dest, { recursive: true });
  } else {
    await env.fs.copyFile(src, dest);
  }
}
