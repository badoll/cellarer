import { plan } from "./engine/plan.js";
import type { Env } from "./env.js";
import { lstatOrNull, readFileOrNull } from "./fs/probe.js";
import type { Capability, Scope } from "./model/index.js";
import { scanTextForSecrets } from "./secrets/detector.js";

export interface DiffIdentity {
  artifact: string;
  agent: string;
  scope: Scope;
  capability: Capability;
  target: string;
}

export interface DiffTargetOptions {
  storeRoot: string;
  identity: DiffIdentity;
  dir?: string;
  collections?: string[];
}

export interface DiffTargetResult {
  identity: DiffIdentity;
  available: boolean;
  status: "available" | "unavailable";
  before?: string;
  after?: string;
  redactionNotices: string[];
  currentFingerprint?: string | null;
  warning?: string;
}

export async function diffTarget(env: Env, opts: DiffTargetOptions): Promise<DiffTargetResult> {
  const identity = opts.identity;
  const p = await plan(env, {
    storeRoot: opts.storeRoot,
    scope: identity.scope,
    dir: identity.scope === "project" ? opts.dir : undefined,
    agents: [identity.agent],
    collections: opts.collections,
    capabilities: [identity.capability],
    secretMode: "env",
    dryRun: true,
  });
  const action = p.actions.find(
    (candidate) =>
      candidate.agent === identity.agent &&
      candidate.scope === identity.scope &&
      candidate.capability === identity.capability &&
      candidate.target === identity.target,
  );
  if (!action) return unavailable(identity, "expected output could not be reconstructed");
  // Ownership conflicts intentionally suppress preview.before in the raw plan, but diffTarget can
  // still read the exact target through Env and apply its existing secret redaction boundary.
  const ownershipBlocked =
    action.ownership?.classification === "unowned-existing" ||
    action.ownership?.classification === "owned-drifted";
  if (ownershipBlocked) {
    return unavailable(
      identity,
      "target content is hidden while ownership is blocked",
      action.ownership?.currentFingerprint,
    );
  }
  if (action.op === "skip" && !ownershipBlocked) {
    return unavailable(identity, action.reason ?? "desired unit is skipped");
  }
  if (action.capability === "skills") {
    return unavailable(identity, "skills directory diffs are not supported yet");
  }
  if (!action.preview?.after) return unavailable(identity, "expected file content is unavailable");

  const stat = await lstatOrNull(env, identity.target);
  if (stat === null) return unavailable(identity, "target is missing");
  if (stat.isDirectory()) return unavailable(identity, "directory diffs are not supported yet");
  if (stat.isSymbolicLink()) return unavailable(identity, "symlink diffs are not supported yet");

  const current = await readFileOrNull(env, identity.target);
  if (current === null) return unavailable(identity, "target is missing");
  const before = redactIfSecret(current);
  const after = redactIfSecret(action.preview.after);
  return {
    identity,
    available: true,
    status: "available",
    before: before.text,
    after: after.text,
    redactionNotices: [...before.notices, ...after.notices],
  };
}

function unavailable(
  identity: DiffIdentity,
  warning: string,
  currentFingerprint?: string | null,
): DiffTargetResult {
  return {
    identity,
    available: false,
    status: "unavailable",
    redactionNotices: [],
    ...(currentFingerprint !== undefined ? { currentFingerprint } : {}),
    warning,
  };
}

function redactIfSecret(text: string): { text: string; notices: string[] } {
  const findings = scanTextForSecrets(text);
  if (findings.length === 0) return { text, notices: [] };
  return {
    text: "[redacted secret content]",
    notices: [`redacted ${findings.length} secret-like value(s)`],
  };
}
