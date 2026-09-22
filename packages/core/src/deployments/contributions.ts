import { loadRegistry } from "../adapters/registry.js";
import type { Env } from "../env.js";
import type { ManagedContribution, PlanAction, TargetOwner } from "../model/index.js";
import { canonicalJson } from "../protocol/canonical.js";
import { sha256 } from "../store/checksum.js";
import { readMcpArtifact } from "../store/store.js";

// Persist only selectors, fingerprints and resource identities, never native server values.
export async function appliedContributions(
  env: Env,
  storeRoot: string,
  action: PlanAction,
  prior: TargetOwner | undefined,
): Promise<Pick<TargetOwner, "itemAttribution" | "contributions">> {
  if (action.capability !== "mcp")
    return {
      itemAttribution: "known",
      contributions: [
        {
          selector: action.target,
          fingerprint:
            action.desiredEvidence?.contentFingerprint ??
            action.desiredEvidence?.sourceFingerprint ??
            "",
          resourceIds: action.artifactIds ?? [],
          provenance: "resource",
        },
      ],
    };
  const adapter = (await loadRegistry(env, storeRoot)).get(action.agent);
  if (!adapter?.mcp) throw new TypeError("missing MCP adapter");
  const decoded = adapter.mcp.codec.decode(action.preview?.after ?? null, adapter.mcp.serversKey);
  const selected: ManagedContribution[] = await Promise.all(
    (action.artifactIds ?? []).map(async (id) => {
      const { name } = await readMcpArtifact(env, storeRoot, id);
      if (!Object.hasOwn(decoded.servers, name)) throw new TypeError("missing selected server");
      return {
        selector: name,
        fingerprint: sha256(canonicalJson(decoded.servers[name])),
        resourceIds: [id],
        provenance: "resource" as const,
      };
    }),
  );
  const retained =
    action.op === "merge"
      ? (prior?.contributions ?? []).filter(
          (item) => !selected.some((next) => next.selector === item.selector),
        )
      : [];
  return {
    itemAttribution: prior && prior.itemAttribution !== "known" ? "unknown" : "known",
    contributions: [...retained, ...selected].sort((a, b) => a.selector.localeCompare(b.selector)),
  };
}
