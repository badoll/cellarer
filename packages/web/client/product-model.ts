import type {
  Capability,
  ConfigurationOutcome,
  Destination,
  ResourceState,
} from "@cellarer/core/client-api";

export type { Destination, ResourceState } from "@cellarer/core/client-api";

export type Page =
  | "library"
  | "sync"
  | "history"
  | "profiles"
  | "dashboard"
  | "inventory"
  | "agents"
  | "settings";

export interface ResourceCountLike {
  state: ResourceState;
}

export type ResourceCounts = Record<ResourceState, number>;

export const RESOURCE_KINDS: Capability[] = ["skills", "mcp", "rules"];

export function destinationLabel(destination: Destination): string {
  return destination === "user" ? "User-level" : "Project-level";
}

export function resourceKindLabel(kind: Capability): string {
  if (kind === "skills") return "Skills";
  if (kind === "mcp") return "MCP";
  return "Rules";
}

export function summarizeResourceCounts(resources: readonly ResourceCountLike[]): ResourceCounts {
  const counts: ResourceCounts = {
    managed: 0,
    discovered: 0,
    synced: 0,
    drifted: 0,
    missing: 0,
    blocked: 0,
  };
  for (const resource of resources) counts[resource.state] += 1;
  return counts;
}

export function configurationLabel(outcome: ConfigurationOutcome): string {
  const labels: Record<ConfigurationOutcome, string> = {
    healthy: "Configuration healthy",
    unhealthy: "Configuration unhealthy",
    "no-op": "No resources to verify",
    incomplete: "Configuration incomplete",
  };
  return labels[outcome];
}
