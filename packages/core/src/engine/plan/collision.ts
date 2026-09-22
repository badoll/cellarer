import { normalize } from "node:path";
import { sameMaterialization } from "../../deployments/model.js";
import type { PlanAction, TargetConflict } from "../../model/index.js";
import { targetKey } from "../../store/ledger.js";

// Coalescing is valid only with matching final materialization evidence. A collision
// never silently drops a consumer or lets the first action choose different bytes.
export function dedupeCollisions(actions: PlanAction[], conflicts: TargetConflict[]): void {
  const claimed = new Map<string, PlanAction>();
  const removed = new Set<PlanAction>();
  for (const action of actions) {
    if (action.op === "skip" || action.target === "") continue;
    action.target = normalize(action.target);
    action.consumerAgents = [action.agent];
    const prior = claimed.get(action.target);
    if (!prior) {
      claimed.set(action.target, action);
      continue;
    }
    if (
      prior.capability !== action.capability ||
      prior.scope !== action.scope ||
      !prior.desiredEvidence ||
      !action.desiredEvidence ||
      !sameMaterialization(prior.desiredEvidence, action.desiredEvidence)
    ) {
      conflicts.push({
        code: "SHARED_TARGET_CONFLICT",
        target: action.target,
        message:
          "consumers require incompatible content, method, or capability at one physical target",
        ownership: {
          key: targetKey(action),
          classification: "invalid-owner",
          target: action.target,
          currentFingerprint: null,
          expectedReceipt: null,
        },
      });
      continue;
    }
    prior.consumerAgents = [...new Set([...(prior.consumerAgents ?? [prior.agent]), action.agent])];
    removed.add(action);
  }
  const retained = actions.filter((action) => !removed.has(action));
  actions.splice(0, actions.length, ...retained);
}
