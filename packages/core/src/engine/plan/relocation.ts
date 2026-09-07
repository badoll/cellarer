import { basename, dirname, join, normalize, resolve } from "node:path";
import type { AgentAdapter } from "../../adapters/types.js";
import type { Env } from "../../env.js";
import type { Capability, Scope, TargetOwner } from "../../model/index.js";

/** Compare placements before opening native files, including removed support declarations. */
export async function requiresRelocation(
  env: Env,
  adapter: AgentAdapter,
  capability: Capability,
  scope: Scope,
  dir: string | undefined,
  owners: readonly TargetOwner[],
): Promise<boolean> {
  if (
    !owners.some(
      (owner) =>
        owner.agent === adapter.id && owner.capability === capability && owner.scope === scope,
    )
  )
    return false;
  const root = scope === "global" ? env.homedir() : resolve(env.cwd(), dir ?? env.cwd());
  const canonicalRoot = await canonicalPath(env, root);
  const matching = owners.filter(
    (owner) =>
      owner.agent === adapter.id &&
      owner.capability === capability &&
      owner.scope === scope &&
      (scope === "global" || normalize(owner.projectRoot ?? "") === canonicalRoot),
  );
  if (matching.length === 0) return false;
  if (!adapter.capabilities[capability].includes(scope)) return true;
  const paths = adapter.paths(env, scope, dir);
  const location = paths[capability === "skills" ? "skillsDir" : capability];
  if (!location) return true;
  for (const owner of matching) {
    const expected = capability === "skills" ? join(location, basename(owner.target)) : location;
    // Resolve parents only: a Skill target can itself be a managed symlink to the Store.
    const canonicalTarget = join(await canonicalPath(env, dirname(expected)), basename(expected));
    if (normalize(owner.target) !== canonicalTarget) return true;
  }
  return false;
}

async function canonicalPath(env: Env, path: string): Promise<string> {
  try {
    return normalize(await env.fs.realpath(path));
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    const parent = dirname(path);
    return parent === path
      ? normalize(path)
      : join(await canonicalPath(env, parent), basename(path));
  }
}
