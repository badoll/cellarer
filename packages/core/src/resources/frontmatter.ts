import { isAlias, isCollection, isScalar, parseDocument, visit } from "yaml";
import { ResourceSemanticsError } from "./semantics.js";

export interface ParsedFrontmatter {
  readonly data: Record<string, unknown>;
  readonly body: string;
}

/** Parse only bounded, non-executable YAML; callers retain the original source bytes. */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(normalized);
  if (match?.index !== 0) fail();
  const yaml = match[1] ?? "";
  if (new TextEncoder().encode(yaml).byteLength > 65536) fail();
  try {
    const document = parseDocument(yaml, {
      schema: "core",
      uniqueKeys: true,
      strict: true,
      prettyErrors: false,
    });
    if (document.errors.length || document.warnings.length) fail();
    let nodes = 0;
    visit(document, (_key, node, path) => {
      if (++nodes > 4096 || path.length > 32 || isAlias(node)) fail();
      if ((isScalar(node) || isCollection(node)) && (node.tag || node.anchor)) fail();
    });
    const data: unknown = document.toJS({ maxAliasCount: 0 });
    if (!data || typeof data !== "object" || Array.isArray(data)) fail();
    return { data: data as Record<string, unknown>, body: normalized.slice(match[0].length) };
  } catch {
    return fail();
  }
}

function fail(): never {
  throw new ResourceSemanticsError("unsupported", "INVALID_MANIFEST");
}
