import { basename, dirname, join } from "node:path";
import type { RuleFragment } from "../adapters/types.js";
import { renderRules } from "../markers.js";
import { parseFrontmatter } from "../resources/frontmatter.js";
import { ResourceSemanticsError, type SemanticResult } from "../resources/semantics.js";

interface RuleSemantics {
  readonly fragment: RuleFragment;
  readonly trigger: "always" | "on-demand" | "path-scoped" | "agent-selected";
  readonly metadata: { alwaysApply: boolean; globs?: string; description?: string };
}
export interface CompiledRuleTarget {
  readonly target: string;
  readonly content: string;
  readonly sources: readonly string[];
}

function interpret(fragment: RuleFragment): RuleSemantics {
  if (!/^---(?:[ \t]*\r?\n)/.test(fragment.content.trimStart())) {
    return { fragment, trigger: "always", metadata: { alwaysApply: true } };
  }
  const { data, body } = parseFrontmatter(fragment.content);
  if (
    Object.keys(data).some((key) => !["alwaysApply", "globs", "description"].includes(key)) ||
    typeof data.alwaysApply !== "boolean" ||
    (data.globs !== undefined && typeof data.globs !== "string") ||
    (data.description !== undefined && typeof data.description !== "string")
  )
    throw new ResourceSemanticsError("unsupported", "RULE_METADATA_UNSUPPORTED");
  const globs = typeof data.globs === "string" ? data.globs : undefined;
  const description = typeof data.description === "string" ? data.description : undefined;
  return {
    fragment: { ...fragment, content: body },
    trigger: data.alwaysApply
      ? "always"
      : globs
        ? "path-scoped"
        : description
          ? "agent-selected"
          : "on-demand",
    metadata: {
      alwaysApply: data.alwaysApply,
      ...(globs ? { globs } : {}),
      ...(description ? { description } : {}),
    },
  };
}

/** Every conditional resource keeps its own native name and contribution identity. */
export function compileRules(
  target: string,
  fragments: readonly RuleFragment[],
): SemanticResult<readonly CompiledRuleTarget[]> {
  try {
    if (fragments.length > 128)
      throw new ResourceSemanticsError("unsupported", "RULE_TARGET_BUDGET");
    const rules = fragments.map(interpret);
    if (!target.endsWith(".mdc") && rules.some((rule) => rule.trigger !== "always")) {
      return { status: "requires-choice", reason: "RULE_TRIGGER_NOT_REPRESENTABLE" };
    }
    const outputs: CompiledRuleTarget[] = [];
    const always = rules.filter((rule) => rule.trigger === "always");
    if (always.length)
      outputs.push({
        target,
        content:
          (target.endsWith(".mdc") ? "---\nalwaysApply: true\n---\n" : "") +
          renderRules(always.map((rule) => rule.fragment)),
        sources: always.map((rule) => rule.fragment.relPath),
      });
    for (const rule of rules.filter((rule) => rule.trigger !== "always")) {
      const name = basename(rule.fragment.relPath, ".md");
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..")
        throw new ResourceSemanticsError("unsupported", "RULE_TARGET_NAME");
      const nativeTarget = join(dirname(target), `${basename(target, ".mdc")}.${name}.mdc`);
      const metadata = Object.entries(rule.metadata)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join("\n");
      outputs.push({
        target: nativeTarget,
        content: `---\n${metadata}\n---\n${renderRules([rule.fragment])}`,
        sources: [rule.fragment.relPath],
      });
    }
    if (new Set(outputs.map((output) => output.target)).size !== outputs.length)
      throw new ResourceSemanticsError("unsupported", "RULE_TARGET_COLLISION");
    return { status: "exact", value: outputs };
  } catch (error) {
    return {
      status: error instanceof ResourceSemanticsError ? error.status : "unsupported",
      reason: error instanceof ResourceSemanticsError ? error.code : "INVALID_RULE",
    };
  }
}
