import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { z } from "zod";
import type { Env } from "../env.js";
import { lstatOrNull } from "../fs/probe.js";
import { isWithinRoot } from "../fs/safety.js";
import type {
  Deployment,
  DeploymentConsumer,
  DeploymentState,
  Scope,
  TargetOwner,
} from "../model/index.js";
import { sha256 } from "../store/checksum.js";

const absolutePath = z
  .string()
  .refine(
    (value) => isAbsolute(value) && normalize(value) === value,
    "path must be canonical absolute",
  );
const capability = z.enum(["rules", "mcp", "skills"]);
const artifactId = z.string().regex(/^(rules|mcp|skills)\/[^/*,\s]+$/);
const profile = z.strictObject({
  profileId: z.string().regex(/^[A-Za-z0-9._-]+$/),
  profileRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  resolvedResources: z.array(
    z.strictObject({
      resourceId: artifactId,
      revision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      capability,
    }),
  ),
});
const consumerSchema = z
  .strictObject({
    agent: z.string().min(1),
    scope: z.enum(["global", "project"]),
    root: absolutePath,
    capability,
    kind: z.enum(["ad-hoc", "profile"]),
    profile: profile.optional(),
  })
  .refine(
    (value) => (value.kind === "profile") === (value.profile !== undefined),
    "profile evidence must match consumer kind",
  );
const deploymentSchema = z.strictObject({
  id: z.string(),
  key: z.string(),
  target: absolutePath,
  root: absolutePath,
  capability,
  receipt: z.strictObject({
    method: z.enum(["write", "symlink", "junction", "copy"]),
    fingerprint: z.string(),
    contentFingerprint: z.string().optional(),
    sourceFingerprint: z.string().optional(),
    backup: z.string().nullable(),
    generated: z.boolean(),
    appliedAt: z.string(),
  }),
  artifactIds: z.array(artifactId).min(1),
  secretRefs: z
    .array(
      z
        .string()
        .min(1)
        .refine((name) => name.trim() === name && !/[{}\r\n]/.test(name)),
    )
    .optional(),
  itemAttribution: z.literal("unknown"),
  consumers: z.array(consumerSchema).min(1),
});

export function physicalTargetKey(target: string): string {
  return JSON.stringify([normalize(target)]);
}

export function consumerKey(consumer: DeploymentConsumer): string {
  return JSON.stringify([
    consumer.agent,
    consumer.scope,
    consumer.root,
    consumer.capability,
    consumer.kind,
    consumer.profile?.profileId ?? null,
  ]);
}

// The final entry may itself be a managed Skill link. Only ancestors are resolved.
// Root aliases are rejected instead of silently expanding another root's authority.
export async function canonicalDeploymentTarget(
  env: Env,
  rawTarget: string,
  rawRoot: string,
): Promise<Pick<Deployment, "key" | "target" | "root">> {
  if (!isAbsolute(rawTarget) || !isAbsolute(rawRoot))
    throw new TypeError("deployment paths must be absolute");
  const target = normalize(rawTarget);
  const root = normalize(rawRoot);
  if (target === root || !isWithinRoot(root, target))
    throw new TypeError("deployment target is outside or equals its managed root");
  if ((await env.fs.realpath(root)) !== root)
    throw new TypeError("deployment root must be canonical; aliases cannot grant authority");
  let parent = root;
  for (const segment of relative(root, dirname(target)).split(sep).filter(Boolean)) {
    parent = join(parent, segment);
    const stat = await lstatOrNull(env, parent);
    if (!stat) break;
    if (stat.isSymbolicLink())
      throw new TypeError("deployment target has an unsafe ancestor symlink");
    if (!stat.isDirectory()) throw new TypeError("deployment target ancestor is not a directory");
    if ((await env.fs.realpath(parent)) !== parent)
      throw new TypeError("deployment target ancestor is not canonical");
  }
  return { target, root, key: physicalTargetKey(target) };
}

export function makeDeployment(input: Omit<Deployment, "id"> & { id?: string }): Deployment {
  const key = physicalTargetKey(input.target);
  const id = sha256(key);
  const record = deploymentSchema.parse({ ...input, id: input.id ?? id });
  if (record.key !== key || record.id !== id)
    throw new TypeError("deployment identity does not match physical target");
  if (record.target === record.root || !isWithinRoot(record.root, record.target))
    throw new TypeError("deployment target outside root");
  const keys = new Set<string>();
  for (const consumer of record.consumers) {
    if (consumer.root !== record.root)
      throw new TypeError("consumer root differs from deployment root");
    if (consumer.capability !== record.capability)
      throw new TypeError("consumer capability differs from deployment capability");
    const key = consumerKey(consumer);
    if (keys.has(key)) throw new TypeError("duplicate deployment consumer");
    keys.add(key);
  }
  if (new Set(record.artifactIds).size !== record.artifactIds.length)
    throw new TypeError("duplicate deployment artifact");
  return record;
}

export function validateDeploymentState(value: unknown): DeploymentState {
  const state = z
    .strictObject({ version: z.literal(3), deployments: z.array(deploymentSchema) })
    .parse(value);
  const deployments = state.deployments.map(makeDeployment);
  if (new Set(deployments.map((record) => record.key)).size !== deployments.length)
    throw new TypeError("duplicate physical deployment");
  return { version: 3, deployments };
}

export function projectDeployment(
  record: Deployment,
  filter: { agents?: string[]; scope?: Scope; dir?: string; profileId?: string } = {},
): TargetOwner[] {
  return record.consumers
    .filter(
      (consumer) =>
        (!filter.agents?.length || filter.agents.includes(consumer.agent)) &&
        (!filter.scope || filter.scope === consumer.scope) &&
        (!filter.dir || normalize(filter.dir) === consumer.root) &&
        (!filter.profileId || consumer.profile?.profileId === filter.profileId),
    )
    .map((consumer) => ({
      deploymentId: record.id,
      deploymentRoot: record.root,
      agent: consumer.agent,
      scope: consumer.scope,
      capability: consumer.capability,
      target: record.target,
      ...(consumer.scope === "project" ? { projectRoot: consumer.root } : {}),
      artifactIds: [...record.artifactIds],
      receipt: { ...record.receipt },
      ...(consumer.profile ? { syncProfile: consumer.profile } : {}),
      ...(record.secretRefs ? { secretRefs: [...record.secretRefs] } : {}),
    }));
}

export function sameMaterialization(
  left: import("../model/index.js").DesiredTargetEvidence,
  right: import("../model/index.js").DesiredTargetEvidence,
): boolean {
  if (left.method !== right.method) return false;
  if (left.method === "write") {
    return (
      left.contentFingerprint !== undefined && left.contentFingerprint === right.contentFingerprint
    );
  }
  return (
    left.sourceFingerprint !== undefined &&
    left.sourceFingerprint === right.sourceFingerprint &&
    (left.method !== "symlink" ||
      (left.sourceIdentity !== undefined && left.sourceIdentity === right.sourceIdentity))
  );
}
