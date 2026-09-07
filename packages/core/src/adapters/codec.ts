import { renderRules } from "../markers.js";
import type { RuleFragment, RulesCodec } from "./types.js";

/** @deprecated Rules use the single built-in markdown renderer during execution. */
export const markdownRulesCodec: RulesCodec = {
  render: (fragments) => renderRules(fragments),
};

/** MDC needs an explicit activation envelope; conditional source rules need a semantic compiler. */
export function renderRulesForTarget(target: string, fragments: RuleFragment[]): string {
  if (!target.endsWith(".mdc")) return renderRules(fragments);
  if (fragments.some((fragment) => /^---\s*\r?\n/.test(fragment.content.trimStart()))) {
    throw new Error("unsupported: rule frontmatter requires explicit semantic conversion");
  }
  return `---\nalwaysApply: true\n---\n${renderRules(fragments)}`;
}
