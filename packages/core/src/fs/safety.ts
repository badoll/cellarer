// 安全护栏(照抄 ruler assertNotSymbolicLink + assertManagedPathInsideRoot,见计划 §7.2/§7.3)。
// 所有写 / 删 / 还原前调用,防软链穿越与越界写入。
// 注意:本文件只用 node:path(纯路径计算,无副作用),不违反不变量 2 的 fs 注入约束。
import { relative, resolve } from "node:path";
import type { Env } from "../env.js";
import { lstatOrNull } from "./probe.js";

// child 相对 root 的路径,当且仅当 child 严格位于 root 之内(不含 root 自身);否则 null。
// 单一实现:isPathInside 与 gitignore 的相对化都走这里,Windows 跨盘语义一致。
export function relativeInside(root: string, child: string): string | null {
  const rel = relative(resolve(root), resolve(child));
  // 空 rel = 同一路径;以 .. 开头 = 在 root 之外;绝对(带盘符)= Windows 跨盘。
  if (rel.length === 0 || rel.startsWith("..") || isAbsoluteLike(rel)) return null;
  return rel;
}

// child 是否严格位于 root 之内(不含 root 自身)。
export function isPathInside(child: string, root: string): boolean {
  return relativeInside(root, child) !== null;
}

function isAbsoluteLike(p: string): boolean {
  // Windows 跨盘 relative 会返回带盘符的绝对路径。
  return /^([a-zA-Z]:)?[\\/]/.test(p);
}

// 断言 path 在 root 之内,否则抛错(label 标明用途,便于排查)。
export function assertPathInside(path: string, root: string, label: string): void {
  if (!isPathInside(path, root)) {
    throw new Error(
      `safety: refusing to operate on ${label} "${path}" — outside managed root "${root}"`,
    );
  }
}

// 断言 path 不是软链(lstat 不跟随软链);防止 cellarer 跟随恶意软链写到 root 外。
// path 不存在视为安全(尚未创建)。
export async function assertNotSymbolicLink(env: Env, path: string): Promise<void> {
  const stat = await lstatOrNull(env, path);
  if (stat?.isSymbolicLink()) {
    throw new Error(`safety: refusing to write through symlink at "${path}"`);
  }
}
