import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { Env } from "./env.js";
import { hashDir } from "./fs/hashDir.js";
import { lstatOrNull, statOrNull } from "./fs/probe.js";
import { isWithinRoot } from "./fs/safety.js";
import type { Capability, Scope, TargetClassification, TargetOwner } from "./model/index.js";
import { sha256 } from "./store/checksum.js";

export interface InspectTargetOwnershipOptions {
  agent: string;
  scope: Scope;
  capability: Capability;
  // adapter.paths() 已解析的绝对目标。project scope 的受管根由 dir（缺省 env.cwd）确定。
  target: string;
  dir?: string;
  owners: readonly TargetOwner[];
}

export interface TargetOwnershipInspection {
  classification: TargetClassification;
  target: string;
  fingerprint: string | null;
  owner: TargetOwner | null;
  reason?: string;
}

// 对文件取内容 checksum，对目录取稳定目录 fingerprint。顶层软链额外纳入
// lstat kind/mode 与原始 readlink target，因此指向内容相同的另一目录仍会被识别为 drift。
// 所有探测和读取都经 Env，调用方可安全地在 plan 阶段使用。
export async function fingerprintTarget(env: Env, target: string): Promise<string | null> {
  const directStat = await lstatOrNull(env, target);
  if (directStat === null) return null;

  if (directStat.isSymbolicLink()) {
    const contentStat = await statOrNull(env, target);
    let contentFingerprint: string | null = null;
    if (contentStat?.isFile()) contentFingerprint = sha256(await env.fs.readFile(target));
    else if (contentStat?.isDirectory()) contentFingerprint = await hashDir(env, target);
    return sha256(
      JSON.stringify({
        version: 1,
        root: {
          kind: "symlink",
          mode: directStat.mode & 0o7777,
          target: await env.fs.readlink(target),
        },
        contentFingerprint,
      }),
    );
  }

  const contentStat = directStat;
  if (contentStat === null) return null;
  if (contentStat.isFile()) return sha256(await env.fs.readFile(target));
  if (contentStat.isDirectory()) return hashDir(env, target);
  return null;
}

export async function inspectTargetOwnership(
  env: Env,
  options: InspectTargetOwnershipOptions,
): Promise<TargetOwnershipInspection> {
  const targetResult = normalizeAbsolute(options.target, "adapter target");
  if (!targetResult.ok) return invalid(options.target, targetResult.reason);
  const target = targetResult.path;

  const rootResult = managedRoot(env, options.scope, options.dir);
  if (!rootResult.ok) return invalid(target, rootResult.reason);
  const pathError = await validateTargetPath(env, target, rootResult.path);
  if (pathError) return invalid(target, pathError);

  const identityOwners = options.owners.filter(
    (owner) =>
      owner.deploymentId !== undefined ||
      (owner.agent === options.agent &&
        owner.scope === options.scope &&
        owner.capability === options.capability),
  );
  const matchingOwners: TargetOwner[] = [];
  for (const owner of identityOwners) {
    const ownerTarget = normalizeAbsolute(owner.target, "owner target");
    if (!ownerTarget.ok) {
      // 相对 owner 若按当前 cwd 恰好指向本 target，不能被静默当成可信或无关状态。
      if (isAbsolute(env.cwd()) && normalize(join(env.cwd(), owner.target)) === target) {
        return invalid(target, ownerTarget.reason);
      }
      continue;
    }
    if (ownerTarget.path === target) matchingOwners.push(owner);
  }

  const shared =
    matchingOwners.length > 0 &&
    matchingOwners.every(
      (owner) =>
        owner.deploymentId !== undefined &&
        owner.deploymentId === matchingOwners[0]?.deploymentId &&
        owner.deploymentRoot === rootResult.path &&
        owner.capability === options.capability &&
        JSON.stringify(owner.receipt) === JSON.stringify(matchingOwners[0]?.receipt),
    );
  if (
    matchingOwners.some(
      (owner) =>
        owner.deploymentId &&
        (owner.deploymentRoot !== rootResult.path || owner.capability !== options.capability),
    )
  ) {
    return invalid(target, "deployment root or capability does not match consumer authority");
  }
  if (matchingOwners.length > 1 && !shared) {
    return invalid(target, `duplicate current owners for adapter target "${target}"`);
  }
  const owner = matchingOwners[0] ?? null;
  if (
    owner?.scope === "project" &&
    normalize(owner.projectRoot ?? "") !== normalize(rootResult.path)
  ) {
    return invalid(
      target,
      `project owner root "${owner.projectRoot ?? "missing"}" does not match managed root "${rootResult.path}"`,
    );
  }
  const directStat = await lstatOrNull(env, target);
  if (directStat === null) {
    return { classification: "absent", target, fingerprint: null, owner };
  }

  const fingerprint = await fingerprintTarget(env, target);
  if (!owner) {
    return { classification: "unowned-existing", target, fingerprint, owner: null };
  }
  if (fingerprint !== null && fingerprint === owner.receipt.fingerprint) {
    return { classification: "owned-current", target, fingerprint, owner };
  }
  return {
    classification: "owned-drifted",
    target,
    fingerprint,
    owner,
    ...(fingerprint === null ? { reason: "existing target could not be fingerprinted" } : {}),
  };
}

type NormalizedPath = { ok: true; path: string } | { ok: false; reason: string };

function normalizeAbsolute(path: string, label: string): NormalizedPath {
  if (!isAbsolute(path)) {
    return { ok: false, reason: `${label} must be absolute: "${path}"` };
  }
  return { ok: true, path: normalize(path) };
}

function managedRoot(env: Env, scope: Scope, dir: string | undefined): NormalizedPath {
  const rawRoot = scope === "project" ? (dir ?? env.cwd()) : env.homedir();
  if (isAbsolute(rawRoot)) return { ok: true, path: normalize(rawRoot) };
  if (!isAbsolute(env.cwd())) {
    return { ok: false, reason: `environment cwd must be absolute: "${env.cwd()}"` };
  }
  return { ok: true, path: normalize(join(env.cwd(), rawRoot)) };
}

async function validateTargetPath(env: Env, target: string, root: string): Promise<string | null> {
  if (!isWithinRoot(root, target)) {
    return `adapter target "${target}" is outside its managed root "${root}"`;
  }

  let realRoot: string;
  try {
    realRoot = await env.fs.realpath(root);
  } catch {
    return `managed root cannot be resolved: "${root}"`;
  }

  // 最终 target 可以是预期的 Skill symlink；只检查 root 与 target 父目录之间的祖先。
  let nearestExisting = root;
  if (target !== root) {
    const relParent = relative(root, dirname(target));
    const segments = relParent.length === 0 ? [] : relParent.split(sep);
    let current = root;
    for (const segment of segments) {
      current = join(current, segment);
      const stat = await lstatOrNull(env, current);
      if (stat === null) break;
      if (stat.isSymbolicLink()) {
        return `adapter target has an unsafe ancestor symlink at "${current}"`;
      }
      nearestExisting = current;
    }
  }

  let realAncestor: string;
  try {
    realAncestor = await env.fs.realpath(nearestExisting);
  } catch {
    return `nearest existing target ancestor cannot be resolved: "${nearestExisting}"`;
  }
  if (!isWithinRoot(realRoot, realAncestor)) {
    return `adapter target ancestor resolves outside its managed root: "${nearestExisting}"`;
  }
  return null;
}

function invalid(target: string, reason: string): TargetOwnershipInspection {
  return {
    classification: "invalid-owner",
    target,
    fingerprint: null,
    owner: null,
    reason,
  };
}
