/** Bump whenever interpreting the same raw revision can change generated semantics. */
export const RESOURCE_SEMANTICS_VERSION = "1";

export type SemanticResult<T> =
  | { readonly status: "exact"; readonly value: T }
  | { readonly status: "requires-choice" | "unsupported"; readonly reason: string };

export class ResourceSemanticsError extends TypeError {
  constructor(
    readonly status: "requires-choice" | "unsupported",
    readonly code: string,
  ) {
    // Diagnostics contain contract codes only, never untrusted resource values.
    super(`${status}: ${code}`);
    this.name = "ResourceSemanticsError";
  }
}
