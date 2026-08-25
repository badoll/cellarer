import type { InventoryFindingCode } from "../protocol/client-types.js";
import type { InventorySource } from "./enumerator.js";

export interface InventoryCandidateObservation {
  readonly kind: InventorySource["kind"];
  readonly name: string;
  readonly normalizedName: string;
  readonly contentFingerprint: string;
  readonly physicalIdentity: string;
  readonly source: InventorySource;
  readonly relativePath?: string;
  readonly findings: readonly InventoryFindingCode[];
}

export interface InventorySourceFinding {
  readonly code: InventoryFindingCode;
  readonly source: InventorySource;
}

export interface InventorySourceInspection {
  readonly candidates: readonly InventoryCandidateObservation[];
  readonly findings: readonly InventorySourceFinding[];
}

export interface ManagedInventoryRevision {
  readonly resourceId: string;
  readonly kind: InventorySource["kind"];
  readonly normalizedName: string;
  readonly contentFingerprint: string;
  readonly revisionId: string;
}
