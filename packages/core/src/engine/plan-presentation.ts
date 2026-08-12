import type { PlanAction, Scope } from "../model/index.js";

export type PlanActionPresentationClass = "desired" | "unsupported";

export function planActionPresentationClass(
  action: PlanAction,
  supportedScopes: readonly Scope[],
): PlanActionPresentationClass {
  return supportedScopes.includes(action.scope) ? "desired" : "unsupported";
}
