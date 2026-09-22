import { parseFrontmatter } from "../resources/frontmatter.js";
import { ResourceSemanticsError } from "../resources/semantics.js";

export interface SkillManifest {
  readonly name: string;
  readonly description: string;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function parseSkillManifest(content: string, expectedName?: string): SkillManifest {
  const { data } = parseFrontmatter(content);
  if (
    typeof data.name !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(data.name) ||
    data.name === "." ||
    data.name === ".." ||
    (expectedName !== undefined && data.name !== expectedName) ||
    typeof data.description !== "string" ||
    !data.description.trim() ||
    (data.metadata !== undefined &&
      (!data.metadata || typeof data.metadata !== "object" || Array.isArray(data.metadata)))
  )
    throw new ResourceSemanticsError("unsupported", "INVALID_MANIFEST");
  const { name, description, metadata, ...extensions } = data;
  return {
    name,
    description,
    extensions,
    ...(metadata ? { metadata: metadata as Record<string, unknown> } : {}),
  };
}
