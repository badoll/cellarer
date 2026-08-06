// 安全护栏(照抄 ruler assertNotSymbolicLink + assertManagedPathInsideRoot,见计划 §7.2/§7.3)。
// 所有写 / 删 / 还原前调用,防软链穿越与越界写入。
// 注意:本文件用 node:path 做纯路径计算;resolve 对相对路径会读 process.cwd,
// 故调用方须传绝对路径(CLI 在边界已 absolutize --dir,adapter target 亦为绝对)。
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { Env } from "../env.js";
import { lstatOrNull } from "./probe.js";

// child 相对 root 的路径,当且仅当 child 严格位于 root 之内(不含 root 自身);否则 null。
// 单一实现:isPathInside 与 gitignore 的相对化都走这里,Windows 跨盘语义一致。
export function relativeInside(root: string, child: string): string | null {
  const rel = relative(resolve(root), resolve(child));
  // 空 rel = 同一路径;rel 为 ".." 或以 "../" 开头 = 在 root 之外;绝对(带盘符)= Windows 跨盘。
  // 注意:只判 ".." 段本身,不能用 startsWith("..") —— 否则名为 "..config" 的合法子项被误判越界。
  if (rel.length === 0 || rel === ".." || rel.startsWith(`..${sep}`) || isAbsoluteLike(rel)) {
    return null;
  }
  return rel;
}

// child 是否严格位于 root 之内(不含 root 自身)。
export function isPathInside(child: string, root: string): boolean {
  return relativeInside(root, child) !== null;
}

// child 位于 root 之内或就是 root 自身(inclusive)。
// 用途:适配器路径模板的越界校验 —— 模板可能合法地解析为根本身(如 detect 到工程根),
// 故需比 isPathInside(严格)更宽一档,与参照实现 A 的 isWithin 语义一致。
export function isWithinRoot(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel.length === 0 || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsoluteLike(rel));
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

// Atomic rename does not follow a symlink at the final path, but it does follow symlinked parent
// directories. Validate every existing ancestor inside the store before publishing durable state.
export async function assertSafeAtomicPublicationPath(
  env: Env,
  path: string,
  root: string,
  label: string,
): Promise<void> {
  if (!isAbsolute(path) || !isAbsolute(root)) {
    throw new Error(`safety: ${label} path and root must be absolute`);
  }
  assertPathInside(path, root, label);

  const normalizedRoot = normalize(root);
  const rootStat = await lstatOrNull(env, normalizedRoot);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`safety: ${label} root is missing, not a directory, or a symlink: "${root}"`);
  }
  const realRoot = await env.fs.realpath(normalizedRoot);
  const relativeParent = relative(normalizedRoot, dirname(normalize(path)));
  const segments = relativeParent.length === 0 ? [] : relativeParent.split(sep);
  let nearestExisting = normalizedRoot;
  let current = normalizedRoot;
  for (const segment of segments) {
    current = join(current, segment);
    const stat = await lstatOrNull(env, current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(`safety: ${label} has an unsafe ancestor symlink at "${current}"`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`safety: ${label} ancestor is not a directory: "${current}"`);
    }
    nearestExisting = current;
  }

  const realAncestor = await env.fs.realpath(nearestExisting);
  if (!isWithinRoot(realRoot, realAncestor)) {
    throw new Error(`safety: ${label} ancestor resolves outside store root: "${nearestExisting}"`);
  }
  const finalStat = await lstatOrNull(env, path);
  if (finalStat?.isSymbolicLink()) {
    throw new Error(`safety: ${label} final path is a symlink: "${path}"`);
  }
}

// Read-side equivalent of the atomic publication guard. Provenance must never be computed by
// following a Store alias, a reparse-point ancestor, or a final symlink into an external tree.
// The returned path is the canonical lexical path used by the signed descriptor; callers still
// capture the node through FsLike's no-follow snapshot primitives to close final-node races.
export async function assertSafeStoreObservationPath(
  env: Env,
  path: string,
  root: string,
  label: string,
): Promise<string> {
  const normalizedRoot = resolve(env.cwd(), root);
  const normalizedPath = resolve(env.cwd(), path);
  if (normalizedPath === normalizedRoot || !isWithinRoot(normalizedRoot, normalizedPath)) {
    throw new Error(`safety: ${label} must remain inside the Store root`);
  }

  const rootStat = await lstatOrNull(env, normalizedRoot);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(
      `safety: ${label} root is missing, not a directory, or a symlink: "${normalizedRoot}"`,
    );
  }
  const realRoot = await env.fs.realpath(normalizedRoot);
  const relativePath = relative(normalizedRoot, normalizedPath);
  const segments = relativePath.split(sep);
  let current = normalizedRoot;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stat = await lstatOrNull(env, current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(`safety: ${label} has an unsafe symlink or reparse point at "${current}"`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`safety: ${label} ancestor is not a directory: "${current}"`);
    }
    const realNode = await env.fs.realpath(current);
    if (!isWithinRoot(realRoot, realNode)) {
      throw new Error(`safety: ${label} resolves outside Store root at "${current}"`);
    }
  }
  return normalizedPath;
}
