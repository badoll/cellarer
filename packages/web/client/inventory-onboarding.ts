import type {
  Capability,
  InventoryCandidate,
  InventoryCandidateState,
  InventoryRefreshResult,
  MutationPlan,
} from "@cellarer/core/client-api";
import { isClientReplanRequired } from "./api-state.js";

export type InventoryFilterValue<T extends string> = T | "all";

export interface InventoryFilters {
  readonly kind: InventoryFilterValue<Capability>;
  readonly sourceId: string | "all";
  readonly adapterId: string | "all";
  readonly state: InventoryFilterValue<InventoryCandidateState>;
}

export const EMPTY_INVENTORY_FILTERS: InventoryFilters = {
  kind: "all",
  sourceId: "all",
  adapterId: "all",
  state: "all",
};

export interface InventoryImportPlanReceipt {
  readonly inventory: InventoryRefreshResult;
  readonly candidateIds: readonly string[];
  readonly mutationPlan: MutationPlan;
}

export interface InventoryImportSuccessReceipt {
  readonly candidateIds: readonly string[];
  readonly resourceIds: readonly string[];
}

export type InventoryOnboardingPhase =
  | "loading"
  | "review"
  | "planning"
  | "confirmation"
  | "applying"
  | "declined"
  | "imported"
  | "stale"
  | "failed";

export interface InventoryOnboardingState {
  readonly phase: InventoryOnboardingPhase;
  readonly result: InventoryRefreshResult | null;
  readonly selectedCandidateIds: readonly string[];
  readonly pendingPlan: InventoryImportPlanReceipt | null;
  readonly imported: InventoryImportSuccessReceipt | null;
  readonly message: string | null;
}

export interface InventoryFilterOption {
  readonly id: string;
  readonly label: string;
}

export function createInventoryOnboardingState(): InventoryOnboardingState {
  return {
    phase: "loading",
    result: null,
    selectedCandidateIds: [],
    pendingPlan: null,
    imported: null,
    message: null,
  };
}

export function defaultInventorySelection(result: InventoryRefreshResult): readonly string[] {
  return result.candidates.filter(({ defaultSelected }) => defaultSelected).map(({ id }) => id);
}

export function inventoryLoaded(
  state: InventoryOnboardingState,
  result: InventoryRefreshResult,
): InventoryOnboardingState {
  return {
    ...state,
    phase: "review",
    result,
    selectedCandidateIds: defaultInventorySelection(result),
    pendingPlan: null,
    message: null,
  };
}

export function inventoryLoading(state: InventoryOnboardingState): InventoryOnboardingState {
  return { ...state, phase: "loading", pendingPlan: null, message: null };
}

export function inventoryLoadFailed(
  state: InventoryOnboardingState,
  message = "Inventory refresh failed. Refresh Inventory to retry.",
): InventoryOnboardingState {
  return { ...state, phase: "failed", pendingPlan: null, message };
}

export function inventorySelectionChanged(
  state: InventoryOnboardingState,
  candidateId: string,
  selected: boolean,
): InventoryOnboardingState {
  const candidate = state.result?.candidates.find(({ id }) => id === candidateId);
  if (candidate?.state !== "ready") return state;
  const next = new Set(state.selectedCandidateIds);
  if (selected) next.add(candidateId);
  else next.delete(candidateId);
  return {
    ...state,
    phase: state.phase === "declined" ? "review" : state.phase,
    selectedCandidateIds: [...next],
    pendingPlan: null,
    message: null,
  };
}

export function inventoryPlanning(state: InventoryOnboardingState): InventoryOnboardingState {
  if (!canPlanInventoryImport(state)) return state;
  return { ...state, phase: "planning", pendingPlan: null, message: null };
}

export function inventoryImportPlanned(
  state: InventoryOnboardingState,
  pendingPlan: InventoryImportPlanReceipt,
): InventoryOnboardingState {
  if (!sameIds(state.selectedCandidateIds, pendingPlan.candidateIds)) {
    throw new Error("Inventory import plan candidate IDs differ from the reviewed selection");
  }
  return { ...state, phase: "confirmation", pendingPlan, message: null };
}

export function inventoryImportApplying(state: InventoryOnboardingState): InventoryOnboardingState {
  if (state.pendingPlan === null) return state;
  return { ...state, phase: "applying", message: null };
}

export function inventoryImportDeclined(state: InventoryOnboardingState): InventoryOnboardingState {
  return {
    ...state,
    phase: "declined",
    pendingPlan: null,
    message: "Import declined. Inventory remains unchanged.",
  };
}

export function inventoryImportSucceeded(
  state: InventoryOnboardingState,
  imported: InventoryImportSuccessReceipt,
): InventoryOnboardingState {
  return {
    ...state,
    phase: "imported",
    pendingPlan: null,
    imported,
    message: `${imported.resourceIds.length} resource(s) imported into the Library.`,
  };
}

export function inventoryImportFailed(
  state: InventoryOnboardingState,
  error: unknown,
): InventoryOnboardingState {
  const stale = isClientReplanRequired(error);
  return {
    ...state,
    phase: stale ? "stale" : "failed",
    pendingPlan: null,
    message: stale
      ? "Inventory changed after planning. Refresh Inventory, review, and plan again."
      : error instanceof Error
        ? error.message
        : "Inventory import failed.",
  };
}

export function canPlanInventoryImport(state: InventoryOnboardingState): boolean {
  return (
    state.result?.completeness === "complete" &&
    state.selectedCandidateIds.length > 0 &&
    (state.phase === "review" || state.phase === "declined")
  );
}

export function filterInventoryCandidates(
  candidates: readonly InventoryCandidate[],
  filters: InventoryFilters,
): readonly InventoryCandidate[] {
  return candidates.filter(
    (candidate) =>
      (filters.kind === "all" || candidate.kind === filters.kind) &&
      (filters.state === "all" || candidate.state === filters.state) &&
      (filters.sourceId === "all" || candidate.sources.some(({ id }) => id === filters.sourceId)) &&
      (filters.adapterId === "all" ||
        candidate.relatedAdapters.some(({ id }) => id === filters.adapterId)),
  );
}

export function inventorySourceOptions(
  result: InventoryRefreshResult,
): readonly InventoryFilterOption[] {
  return uniqueOptions(
    result.candidates.flatMap((candidate) =>
      candidate.sources.map(({ id, location }) => ({ id, label: location })),
    ),
  );
}

export function inventoryAdapterOptions(
  result: InventoryRefreshResult,
): readonly InventoryFilterOption[] {
  return uniqueOptions(
    result.candidates.flatMap((candidate) =>
      candidate.relatedAdapters.map(({ id, displayName }) => ({ id, label: displayName })),
    ),
  );
}

function uniqueOptions(
  options: readonly InventoryFilterOption[],
): readonly InventoryFilterOption[] {
  return [...new Map(options.map((option) => [option.id, option])).values()].sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((id, index) => id === sortedRight[index]);
}
