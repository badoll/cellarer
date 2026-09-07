import type { Capability } from "@cellarer/core/client-api";
import { type Destination, resourceKindLabel } from "./product-model.js";

export interface SyncRequest {
  agents: string[];
  destination: Destination;
  dir?: string;
  resources?: {
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
}

function nonEmptyArray<T>(items: T[] | undefined): T[] | undefined {
  return items && items.length > 0 ? [...items] : undefined;
}

export function isProjectDirMissing(destination: Destination, dir: string): boolean {
  return destination === "project" && dir.trim() === "";
}

export function buildSyncRequest(input: SyncRequestInput): SyncRequest {
  const kinds = nonEmptyArray(input.kinds);
  const collections = nonEmptyArray(input.collections);
  const resources = kinds || collections ? { kinds, collections } : undefined;
  return {
    agents: input.agents
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
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
    kinds: request.resources?.kinds ?? [],
    collections: request.resources?.collections ?? [],
  });
}

export function collectionFilterSelection(collection: string): string[] | undefined {
  const name = collection.trim();
  return name ? [name] : undefined;
}

export function buildSyncSelection(input: SyncRequestInput) {
  const request = buildSyncRequest(input);
  return {
    request,
    key: syncRequestKey(request),
    resourceSummary:
      request.resources?.kinds?.map(resourceKindLabel).join(", ") ?? "All resource kinds",
    collectionSummary: request.resources?.collections?.join(", ") ?? "Store defaults",
  };
}
