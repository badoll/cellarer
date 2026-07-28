// .gitignore 与台账同步:project 工程的 managed block 始终从「当前台账中该目录下的
// 全部 project-scope 落地目标」整体重建,而非某次 apply/revert 的局部 targets。
// 这样多 agent 分批 apply、或 partial revert 后,block 仍与实际生成物一致。
import { normalize } from "node:path";
import type { Env } from "../env.js";
import {
  gitignorePath,
  removeManagedBlock,
  renderGitignore,
  updateGitignore,
} from "../fs/gitignore.js";
import { readFileOrNull } from "../fs/probe.js";
import type { Ledger } from "../model/index.js";
import { targetState } from "../protocol/execute.js";
import type {
  ActionPrecondition,
  CanonicalJsonObject,
  MutationPlanAction,
} from "../protocol/models.js";
import { verifyAbsentPublication, verifyFilePublication } from "../protocol/publication.js";
import { sha256 } from "../store/checksum.js";

// 台账中位于 dir 之内的 project-scope 目标(去重保序)。
export function projectTargetsUnder(ledger: Ledger, dir: string): string[] {
  const projectRoot = normalize(dir);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of ledger.owners) {
    if (e.scope !== "project") continue;
    if (!e.projectRoot) {
      throw new Error(`project owner for ${e.target} is missing its canonical projectRoot`);
    }
    if (normalize(e.projectRoot) !== projectRoot) continue;
    if (seen.has(e.target)) continue;
    seen.add(e.target);
    out.push(e.target);
  }
  return out;
}

export interface PlannedGitignoreMutation {
  readonly action: MutationPlanAction;
  readonly precondition: ActionPrecondition;
}

export async function planGitignoreMutation(
  env: Env,
  projectDir: string,
  targets: readonly string[],
): Promise<PlannedGitignoreMutation> {
  const target = gitignorePath(projectDir);
  const normalizedTargets = [...new Set(targets)];
  const desired = renderGitignore(await readFileOrNull(env, target), projectDir, normalizedTargets);
  const effect = desired === null ? "remove" : "publish";
  const digest = sha256(desired ?? "absent");
  const mode = 0o644;
  const actionId = sha256(
    JSON.stringify({
      kind: "sync-gitignore",
      target,
      projectDir,
      normalizedTargets,
      effect,
      digest,
      mode,
    }),
  );
  return {
    action: {
      actionId,
      kind: "sync-gitignore",
      target,
      payload: {
        path: target,
        projectDir,
        targets: normalizedTargets,
        effect,
        digest,
        mode,
      },
    },
    precondition: { actionId, target, expected: await targetState(env, target) },
  };
}

export async function executeGitignoreMutation(
  env: Env,
  action: MutationPlanAction,
): Promise<void> {
  const payload = gitignorePayload(action);
  const existing = await readFileOrNull(env, action.target);
  const desired = renderGitignore(existing, payload.projectDir, payload.targets);
  const effect = desired === null ? "remove" : "publish";
  if (effect !== payload.effect || sha256(desired ?? "absent") !== payload.digest) {
    throw new Error(`gitignore action ${action.actionId} no longer renders its signed digest`);
  }
  if (desired === null) {
    await env.fs.rm(action.target, { force: true });
    await verifyAbsentPublication(env, action.target);
    return;
  }
  await env.fs.publishFileAtomically(action.target, desired, { mode: payload.mode });
  await verifyFilePublication(env, action.target, payload.digest, payload.mode);
}

export function assertGitignoreMutationMatchesLedger(
  action: MutationPlanAction,
  ledger: Ledger,
): void {
  const payload = gitignorePayload(action);
  const expected = projectTargetsUnder(ledger, payload.projectDir);
  if (JSON.stringify(expected) !== JSON.stringify(payload.targets)) {
    throw new TypeError(`gitignore action ${action.actionId} does not match the resulting ledger`);
  }
}

function gitignorePayload(action: MutationPlanAction): {
  projectDir: string;
  targets: string[];
  effect: "publish" | "remove";
  digest: string;
  mode: number;
} {
  const payload = action.payload as CanonicalJsonObject;
  if (
    action.kind !== "sync-gitignore" ||
    payload.path !== action.target ||
    typeof payload.projectDir !== "string" ||
    !Array.isArray(payload.targets) ||
    !payload.targets.every((target) => typeof target === "string") ||
    (payload.effect !== "publish" && payload.effect !== "remove") ||
    typeof payload.digest !== "string" ||
    typeof payload.mode !== "number"
  ) {
    throw new TypeError(`gitignore action ${action.actionId} has invalid signed payload`);
  }
  return {
    projectDir: payload.projectDir,
    targets: payload.targets as string[],
    effect: payload.effect,
    digest: payload.digest,
    mode: payload.mode,
  };
}

// 重建(或清除)dir 的 .gitignore managed block 以匹配台账现状。
export async function syncGitignore(env: Env, dir: string, ledger: Ledger): Promise<void> {
  const targets = projectTargetsUnder(ledger, dir);
  if (targets.length === 0) {
    await removeManagedBlock(env, dir);
    return;
  }
  await updateGitignore(env, dir, targets);
}
