import type { Capability, ControlPlaneResourceDto } from "@cellarer/core/client-api";

export interface LibraryFilters {
  kind: Capability | "all";
  query: string;
  group: string;
}

export function storedResources(resources: readonly ControlPlaneResourceDto[]) {
  return resources.filter((resource) => !resource.discovered);
}

export function filterLibrary(
  resources: readonly ControlPlaneResourceDto[],
  filters: LibraryFilters,
): ControlPlaneResourceDto[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return storedResources(resources).filter(
    (resource) =>
      (filters.kind === "all" || resource.kind === filters.kind) &&
      (!filters.group || resource.membership.collections.includes(filters.group)) &&
      (!query ||
        [resource.name, resource.id, resource.source].some((value) =>
          value.toLocaleLowerCase().includes(query),
        )),
  );
}

export function librarySelection(
  resources: readonly ControlPlaneResourceDto[],
  visible: readonly ControlPlaneResourceDto[],
  selectedIds: readonly string[],
) {
  const stored = new Set(storedResources(resources).map((resource) => resource.id));
  const visibleIds = new Set(visible.map((resource) => resource.id));
  const exactIds = [...new Set(selectedIds)].filter((id) => stored.has(id)).sort();
  return {
    exactIds,
    hiddenIds: exactIds.filter((id) => !visibleIds.has(id)),
  };
}
