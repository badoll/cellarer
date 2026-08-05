// skills planner(下发期):库房 store/skills/<name>/ → agent skills 目录下的同名子目录,目录级 link/copy。
// op 由 method 推导(symlink→symlink,copy→copy),故 per-OS method 真正影响落地(M2 厘清的 op/method 关系)。
// 共享池感知(~/.agents/skills):落地用幂等 link(已是同指向软链则 apply 短路),不破坏既有 symlink。
import { join } from "node:path";
import type { AgentAdapter } from "../adapters/types.js";
import type { Env } from "../env.js";
import type { Artifact, LinkMethod, PlanAction } from "../model/index.js";
import { captureSafeRecursiveSource, UnsafeRecursiveSourceError } from "../secrets/safe-tree.js";

export interface SkillsPlanContext {
  env: Env;
  scope: "global" | "project";
  dir?: string;
  selectedSkills: Artifact[];
  method: LinkMethod;
}

// 为单个 agent 产出 skills PlanAction(每个 skill 一条;无 skills 能力/无制品 → 无产出)。
export async function planSkills(
  ctx: SkillsPlanContext,
  adapter: AgentAdapter,
): Promise<PlanAction[]> {
  const skillsDir = adapter.paths(ctx.env, ctx.scope, ctx.dir).skillsDir;
  if (!skillsDir || !adapter.skills || ctx.selectedSkills.length === 0) return [];

  const op = ctx.method === "copy" ? "copy" : "symlink";
  return Promise.all(
    ctx.selectedSkills.map(async (skill) => {
      const snapshot = await captureSafeRecursiveSource(ctx.env, skill.sourcePath);
      if (snapshot.kind !== "directory") {
        throw new UnsafeRecursiveSourceError(skill.sourcePath, "non-regular");
      }
      return {
        artifact: skill.id,
        artifactIds: [skill.id],
        agent: adapter.id,
        scope: ctx.scope,
        capability: "skills" as const,
        target: join(skillsDir, skill.name),
        source: skill.sourcePath, // 库房真源目录(软链/拷贝来源)
        method: ctx.method,
        op,
        reason: skill.id,
        desiredEvidence: {
          method: ctx.method,
          sourceFingerprint: snapshot.fingerprint,
          sourceIdentity: snapshot.identity,
        },
      };
    }),
  );
}
