// 跨平台 link/copy(借 ts-tooling + vercel skills,见计划 §7.7)。
// POSIX:fs.symlink(文件/目录皆可)。
// Windows:目录用 junction(免特权,绝对 target);文件软链需 Developer Mode,失败回退 copy。
// 任何软链失败一律回退 copy;实际 method 回传供台账记录(status/revert 据此正确处理)。
import { basename, dirname, join, resolve } from "node:path";
import type { Env } from "../env.js";
import type { AppliedMethod } from "../model/index.js";
import { lstatOrNull } from "./probe.js";

export interface LinkOrCopyOpts {
  method: "symlink" | "copy";
  kind: "file" | "dir";
  // 已存在的 dest 只有在上层证明 ownership 或完成加密快照后才能显式清理。
  replaceExisting?: boolean;
  // Complete fallible receipt preparation against the fully built placement before it is swapped
  // over an existing target. For a new target, failure removes the incomplete placement.
  preparePlaced?: (path: string, result: LinkOrCopyResult) => Promise<void>;
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

export async function linkOrCopy(
  env: Env,
  src: string,
  dest: string,
  opts: LinkOrCopyOpts,
): Promise<LinkOrCopyResult> {
  const absSrc = resolve(env.cwd(), src);
  const absDest = resolve(env.cwd(), dest);

  if (opts.method === "symlink" && (await alreadyLinkedTo(env, absDest, absSrc))) {
    const result: LinkOrCopyResult = {
      method: env.platform === "win32" && opts.kind === "dir" ? "junction" : "symlink",
      skipped: true,
    };
    // A caller may still need a fresh receipt for the unchanged link node (for example after the
    // linked source contents drifted). Receipt preparation is read-only here and must not remove
    // the existing target if it fails.
    await opts.preparePlaced?.(absDest, result);
    return result;
  }

  // dest 父目录就绪；普通 placement 不再无条件清掉未知目标。
  await env.fs.mkdir(dirname(absDest), { recursive: true });
  const existing = await lstatOrNull(env, absDest);
  if (existing) {
    if (!opts.replaceExisting) {
      throw new Error(`destination exists and replacement was not approved: "${absDest}"`);
    }
    return replaceStaged(env, absSrc, absDest, opts);
  }

  const result = await placeIntoEmptyDestination(env, absSrc, absDest, opts);
  try {
    await opts.preparePlaced?.(absDest, result);
  } catch (error) {
    await env.fs.rm(absDest, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return result;
}

async function replaceStaged(
  env: Env,
  src: string,
  dest: string,
  opts: LinkOrCopyOpts,
): Promise<LinkOrCopyResult> {
  const suffix = `${env.now().getTime()}-${env.randomId()}`;
  const parent = dirname(dest);
  const name = basename(dest);
  const staged = join(parent, `.${name}.cellarer-stage-${suffix}`);
  const displaced = join(parent, `.${name}.cellarer-before-${suffix}`);
  if ((await lstatOrNull(env, staged)) || (await lstatOrNull(env, displaced))) {
    throw new Error(`replacement staging path already exists for "${dest}"`);
  }

  let result: LinkOrCopyResult;
  try {
    result = await placeIntoEmptyDestination(env, src, staged, opts);
    await opts.preparePlaced?.(staged, result);
  } catch (error) {
    await env.fs.rm(staged, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  await env.fs.rename(dest, displaced);
  try {
    await env.fs.rename(staged, dest);
  } catch (error) {
    try {
      await env.fs.rename(displaced, dest);
    } catch (rollbackError) {
      throw replacementRecoveryError(dest, error, rollbackError, [staged, displaced]);
    }
    if (!(await lstatOrNull(env, dest))) {
      throw replacementRecoveryError(dest, error, new Error("canonical target is missing"), [
        staged,
      ]);
    }
    try {
      await env.fs.rm(staged, { recursive: true, force: true });
    } catch (cleanupError) {
      throw replacementRecoveryError(dest, error, cleanupError, [dest, staged]);
    }
    throw error;
  }

  try {
    await env.fs.rm(displaced, { recursive: true, force: true });
  } catch (error) {
    try {
      await env.fs.rename(dest, staged);
    } catch (rollbackError) {
      throw replacementRecoveryError(dest, error, rollbackError, [dest, displaced]);
    }
    try {
      await env.fs.rename(displaced, dest);
    } catch (rollbackError) {
      throw replacementRecoveryError(dest, error, rollbackError, [staged, displaced]);
    }
    if (!(await lstatOrNull(env, dest))) {
      throw replacementRecoveryError(dest, error, new Error("canonical target is missing"), [
        staged,
      ]);
    }
    try {
      await env.fs.rm(staged, { recursive: true, force: true });
    } catch (cleanupError) {
      throw replacementRecoveryError(dest, error, cleanupError, [dest, staged]);
    }
    throw error;
  }
  return result;
}

function replacementRecoveryError(
  dest: string,
  error: unknown,
  rollbackError: unknown,
  recoveryPaths: string[],
): Error {
  return new Error(
    `replacement cleanup and rollback failed for "${dest}": ${String(error)}; rollback: ${String(rollbackError)}; recoverable paths: ${recoveryPaths.map((path) => `"${path}"`).join(", ")}`,
    { cause: rollbackError },
  );
}

async function placeIntoEmptyDestination(
  env: Env,
  absSrc: string,
  dest: string,
  opts: LinkOrCopyOpts,
): Promise<LinkOrCopyResult> {
  if (opts.method === "copy") {
    await doCopy(env, absSrc, dest, opts.kind);
    return { method: "copy", skipped: false };
  }

  if (env.platform === "win32") {
    if (opts.kind === "dir") {
      // 目录:优先 junction(免特权),绝对 target;失败(跨卷/权限)回退 copy。
      // §11 硬约束:任何软链失败都回退 copy,不得抛错。
      try {
        await env.fs.symlink(absSrc, dest, "junction");
        return { method: "junction", skipped: false };
      } catch {
        await doCopy(env, absSrc, dest, "dir");
        return { method: "copy", skipped: false };
      }
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
