import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Env } from "../env.js";
import type { Capability, Scope } from "../model/index.js";

const cellSchema = z
  .object({
    agent: z.string().min(1),
    capability: z.enum(["rules", "mcp", "skills"]),
    scope: z.enum(["global", "project"]),
    location: z.string().min(1).nullable(),
    evidence: z.enum(["documented", "unsupported", "unknown"]),
    sources: z.array(z.url()).min(1),
    prerequisites: z.array(z.string().min(1)).min(1),
    fixture: z.string().min(1),
    native: z.literal("unknown"),
  })
  .strict();
const matrixSchema = z
  .object({
    schemaVersion: z.literal(1),
    contractVersion: z.string().min(1),
    checkedAt: z.string().min(1),
    agentVersionPolicy: z.string().min(1),
    cells: z.array(cellSchema).length(42),
  })
  .strict()
  .superRefine((matrix, ctx) => {
    const expected = new Set(
      ["agents-md", "claude-code", "codex", "cursor", "gemini-cli", "opencode", "windsurf"].flatMap(
        (agent) =>
          ["rules", "mcp", "skills"].flatMap((cap) =>
            ["global", "project"].map((scope) => `${agent}/${cap}/${scope}`),
          ),
      ),
    );
    for (const cell of matrix.cells) {
      if (!expected.delete(`${cell.agent}/${cell.capability}/${cell.scope}`))
        ctx.addIssue({ code: "custom", message: "duplicate or unknown compatibility cell" });
      if (cell.evidence === "documented" && cell.location === null)
        ctx.addIssue({ code: "custom", message: "documented placement requires a location" });
    }
  });
export type CompatibilityCell = z.infer<typeof cellSchema>;
export type CompatibilityMatrix = z.infer<typeof matrixSchema>;
export const COMPATIBILITY_PATH = fileURLToPath(
  new URL("../../compatibility/matrix.json", import.meta.url),
);

export async function loadCompatibility(env: Pick<Env, "fs">): Promise<CompatibilityMatrix> {
  return matrixSchema.parse(JSON.parse(await env.fs.readFile(COMPATIBILITY_PATH)));
}

type CellIdentity = { agent: string; capability: Capability; scope: Scope };
export interface NativeObservation extends CellIdentity {
  version: string;
  loaded: boolean;
}

/** Observations apply only to the exact independently observed binary and cell. */
export function nativeEvidence(
  cell: CellIdentity,
  version?: string,
  observation?: NativeObservation,
): { status: "unknown"; reason: string } | { status: "native-verified"; version: string } {
  if (!observation) return { status: "unknown", reason: "not-run" };
  if (!version || observation.version !== version)
    return { status: "unknown", reason: "version-mismatch" };
  if (
    cell.agent !== observation.agent ||
    cell.capability !== observation.capability ||
    cell.scope !== observation.scope
  )
    return { status: "unknown", reason: "cell-mismatch" };
  return observation.loaded
    ? { status: "native-verified", version }
    : { status: "unknown", reason: "not-loaded" };
}

export function describeCompatibility(
  matrix: CompatibilityMatrix,
  agent: string,
  scope: Scope,
  override?: {
    rules?: unknown;
    mcp?: unknown;
    skills?: unknown;
    capabilities?: Partial<Record<Capability, unknown>>;
  },
) {
  return (["rules", "mcp", "skills"] as const).map((capability) => {
    const cell = matrix.cells.find(
      (entry) => entry.agent === agent && entry.capability === capability && entry.scope === scope,
    );
    // A capability override conservatively withdraws its documentation claim in both scopes.
    const userDefined =
      !cell ||
      override?.[capability] !== undefined ||
      override?.capabilities?.[capability] !== undefined;
    return {
      capability,
      scope,
      evidence: userDefined ? ("user-defined" as const) : cell.evidence,
      native: "unknown" as const,
      contractVersion: matrix.contractVersion,
      location: userDefined ? null : cell.location,
      sources: userDefined ? [] : [...cell.sources],
      prerequisites: userDefined
        ? ["User-defined contract; native loading has not been verified."]
        : [...cell.prerequisites],
    };
  });
}
