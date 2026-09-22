import { loadRegistry } from "../adapters/registry.js";
import type { DistributeOptions } from "../engine/types.js";
import type { Env } from "../env.js";
import type { DistributePlan, SyncProfileTargetEvidence, TargetOwner } from "../model/index.js";
import { canonicalJson } from "../protocol/canonical.js";
import { scanStructuredSecretFindings, scanTextForSecrets } from "../secrets/detector.js";
import { sha256 } from "../store/checksum.js";
import { loadLedgerForPlanning, targetKey } from "../store/ledger.js";
import { readMcpArtifact } from "../store/store.js";
import { fingerprintTarget } from "../target-ownership.js";
import { canonicalDeploymentTarget } from "./model.js";

export interface ReconciliationRemoval {
  target: string;
  ownerKeys: string[];
  kind: "detach-consumer" | "remove-target" | "prune-mcp";
  fingerprint: string;
  after?: string;
}
export interface ReconciliationTransition {
  priorOwners: TargetOwner[];
  removals: ReconciliationRemoval[];
  changes: {
    target: string;
    selector: string;
    outcome: "keep" | "add" | "update" | "remove" | "detach";
    attribution: "selected" | "retained-managed" | "unmanaged";
  }[];
  blocked: { target: string; code: string }[];
}

export async function reconcileDistribution(
  env: Env,
  opts: DistributeOptions,
  plan: DistributePlan,
  profile: SyncProfileTargetEvidence,
): Promise<ReconciliationTransition> {
  const ledger = await loadLedgerForPlanning(env, opts.storeRoot);
  const root = opts.scope === "global" ? env.homedir() : opts.dir;
  const priorOwners = ledger.owners.filter(
    (owner) => owner.syncProfile?.profileId === profile.profileId && owner.deploymentRoot === root,
  );
  const transition: ReconciliationTransition = {
    priorOwners,
    removals: [],
    changes: [],
    blocked: [],
  };
  const registry = await loadRegistry(env, opts.storeRoot);
  const block = (target: string, code: string) => {
    transition.blocked.push({ target, code });
  };
  for (const action of plan.actions) {
    if (action.op === "skip") {
      block(action.target, "desired-target-blocked");
      continue;
    }
    const prior = priorOwners.find((owner) => owner.target === action.target);
    if (action.capability !== "mcp") {
      transition.changes.push({
        target: action.target,
        selector: action.target,
        outcome: !prior
          ? "add"
          : prior.receipt.contentFingerprint === action.desiredEvidence?.contentFingerprint &&
              prior.receipt.sourceFingerprint === action.desiredEvidence?.sourceFingerprint
            ? "keep"
            : "update",
        attribution: "selected",
      });
      continue;
    }
    const adapter = registry.get(action.agent);
    if (!adapter?.mcp) {
      block(action.target, "adapter-missing");
      continue;
    }
    const before = adapter.mcp.codec.decode(action.preview?.before ?? null, adapter.mcp.serversKey);
    const after = adapter.mcp.codec.decode(action.preview?.after ?? null, adapter.mcp.serversKey);
    const selected = new Set(
      await Promise.all(
        (action.artifactIds ?? []).map(
          async (id) => (await readMcpArtifact(env, opts.storeRoot, id)).name,
        ),
      ),
    );
    if (
      prior &&
      prior.itemAttribution !== "known" &&
      prior.artifactIds.some((id) => !action.artifactIds?.includes(id))
    )
      block(action.target, "attribution-required");
    for (const [selector, server] of Object.entries(before.servers)) {
      const attributed = prior?.contributions?.find((item) => item.selector === selector);
      if (attributed && attributed.fingerprint !== sha256(canonicalJson(server))) {
        block(action.target, "contribution-drift");
        continue;
      }
      if (selected.has(selector)) {
        const changed = canonicalJson(server) !== canonicalJson(after.servers[selector]);
        if (!attributed && changed) block(action.target, "attribution-required");
        transition.changes.push({
          target: action.target,
          selector,
          outcome: changed ? "update" : "keep",
          attribution: "selected",
        });
      } else if (attributed) {
        delete after.servers[selector];
        transition.changes.push({
          target: action.target,
          selector,
          outcome: "remove",
          attribution: "retained-managed",
        });
      } else
        transition.changes.push({
          target: action.target,
          selector,
          outcome: "keep",
          attribution: "unmanaged",
        });
    }
    for (const selector of selected)
      if (!Object.hasOwn(before.servers, selector))
        transition.changes.push({
          target: action.target,
          selector,
          outcome: "add",
          attribution: "selected",
        });
    const content = adapter.mcp.codec.encode(after, after.servers);
    const others = ledger.owners.filter(
      (owner) =>
        owner.target === action.target && owner.syncProfile?.profileId !== profile.profileId,
    );
    if (others.length && sha256(content) !== others[0]?.receipt.fingerprint)
      block(action.target, "shared-target-conflict");
    action.preview = { ...action.preview, after: content };
  }
  for (const target of new Set(priorOwners.map((owner) => owner.target))) {
    const old = priorOwners.filter((owner) => owner.target === target);
    const desired = plan.actions.find((action) => action.target === target && action.op !== "skip");
    const removed = old.filter(
      (owner) => !desired || !(desired.consumerAgents ?? [desired.agent]).includes(owner.agent),
    );
    if (!removed.length) continue;
    if (desired) {
      transition.changes.push({
        target,
        selector: target,
        outcome: "detach",
        attribution: "retained-managed",
      });
      continue;
    }
    const remaining = ledger.owners.filter(
      (owner) =>
        owner.target === target && !removed.some((item) => targetKey(item) === targetKey(owner)),
    );
    const first = removed[0];
    if (!first?.deploymentRoot) {
      block(target, "invalid-owner");
      continue;
    }
    await canonicalDeploymentTarget(env, target, first.deploymentRoot);
    const fingerprint = await fingerprintTarget(env, target);
    if (fingerprint !== first.receipt.fingerprint) {
      block(target, "target-drift");
      continue;
    }
    const removal: ReconciliationRemoval = {
      target,
      ownerKeys: removed.map(targetKey).sort(),
      kind: remaining.length || desired ? "detach-consumer" : "remove-target",
      fingerprint,
    };
    if (removal.kind === "remove-target" && first.capability === "mcp") {
      if (first.itemAttribution !== "known") {
        block(target, "attribution-required");
        continue;
      }
      const adapter = registry.get(first.agent);
      if (!adapter?.mcp) {
        block(target, "adapter-missing");
        continue;
      }
      const decoded = adapter.mcp.codec.decode(
        await env.fs.readFile(target),
        adapter.mcp.serversKey,
      );
      for (const item of first.contributions ?? []) {
        if (
          !Object.hasOwn(decoded.servers, item.selector) ||
          sha256(canonicalJson(decoded.servers[item.selector])) !== item.fingerprint
        )
          block(target, "contribution-drift");
        delete decoded.servers[item.selector];
      }
      removal.kind = "prune-mcp";
      const after = adapter.mcp.codec.encode(decoded, decoded.servers);
      if (scanTextForSecrets(after).length || scanStructuredSecretFindings(decoded).length) {
        block(target, "secret-output-blocked");
        continue;
      }
      removal.after = after;
    } else if (removal.kind === "remove-target" && first.receipt.backup) {
      block(target, "snapshot-revert-required");
      continue;
    }
    transition.removals.push(removal);
    transition.changes.push({
      target,
      selector: target,
      outcome: removal.kind === "detach-consumer" ? "detach" : "remove",
      attribution: "retained-managed",
    });
  }
  return transition;
}
