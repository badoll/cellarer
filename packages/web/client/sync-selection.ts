import type { Capability } from "@cellarer/core/client-api";
import { type Destination, resourceKindLabel } from "./product-model.js";

export interface SyncRequest {
  agents: string[];
  destination: Destination;
  dir?: string;
  resources?: {
    ids?: string[];
    kinds?: Capability[];
    collections?: string[];
  };
}

interface SyncRequestInput {
  agents: string;
  destination: Destination;
  dir: string;
  kinds?: Capability[];
  collections?: string[];
  resourceIds?: string[];
}

function nonEmptyArray<T extends string>(items: T[] | undefined): T[] | undefined {
  return items && items.length > 0
    ? [...new Set(items.map((item) => item.trim() as T))].sort()
    : undefined;
}

export function isProjectDirMissing(destination: Destination, dir: string): boolean {
  return destination === "project" && dir.trim() === "";
}

export function syncKindsForIntent(
  resourceIds?: readonly string[],
  explicitKinds?: Capability[],
): Capability[] | undefined {
  if (explicitKinds) return explicitKinds;
  if (!resourceIds) return undefined;
  return [
    ...new Set(
      resourceIds
        .map((id) => id.split("/", 1)[0])
        .filter(
          (kind): kind is Capability => kind === "rules" || kind === "mcp" || kind === "skills",
        ),
    ),
  ];
}

export function buildSyncRequest(input: SyncRequestInput): SyncRequest {
  const kinds = nonEmptyArray(input.kinds);
  const collections = nonEmptyArray(input.collections);
  const ids = input.resourceIds
    ? [...new Set(input.resourceIds.map((id) => id.trim()))].sort()
    : undefined;
  const resources = ids
    ? { ids, kinds }
    : kinds || collections
      ? { kinds, collections }
      : undefined;
  return {
    agents: [
      ...new Set(
        input.agents
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ].sort(),
    destination: input.destination,
    dir: input.destination === "project" ? input.dir.trim() : undefined,
    resources,
  };
}

export function syncRequestKey(request: SyncRequest): string {
  return JSON.stringify({
    agents: request.agents,
    destination: request.destination,
    dir: request.dir ?? "",
    ids: request.resources?.ids ?? null,
    kinds: request.resources?.kinds ?? [],
    collections: request.resources?.collections ?? [],
  });
}

export function buildSyncSelection(input: SyncRequestInput) {
  const request = buildSyncRequest(input);
  return {
    request,
    key: syncRequestKey(request),
    resourceSummary:
      request.resources?.kinds?.map(resourceKindLabel).join(", ") ?? "All resource kinds",
    collectionSummary: request.resources?.ids
      ? `Exact resources: ${request.resources.ids.join(", ")}`
      : (request.resources?.collections?.join(", ") ?? "Store defaults"),
  };
}
