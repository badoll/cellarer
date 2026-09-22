import { renderRules } from "../markers.js";
import { ResourceSemanticsError } from "../resources/semantics.js";
import { compileRules } from "../rules/compiler.js";
import type { RuleFragment, RulesCodec } from "./types.js";

/** @deprecated Rules use the single built-in markdown renderer during execution. */
export const markdownRulesCodec: RulesCodec = {
  render: (fragments) => renderRules(fragments),
};

/** Compatibility helper for callers that explicitly require one native output. */
export function renderRulesForTarget(target: string, fragments: RuleFragment[]): string {
  const result = compileRules(target, fragments);
  if (result.status !== "exact") throw new ResourceSemanticsError(result.status, result.reason);
  if (result.value.length !== 1 || !result.value[0])
    throw new ResourceSemanticsError("unsupported", "RULE_TARGET_SET_REQUIRED");
  return result.value[0].content;
}
