import type { SnapshotLimits } from "../env.js";
import type {
  InventoryFindingCode,
  InventorySecretAdoptionOffer,
} from "../protocol/client-types.js";
import type { SafeRecursiveSnapshot } from "../secrets/safe-tree.js";
import type { InventorySource } from "./enumerator.js";

export type CapturedInventoryPublication =
  | {
      readonly kind: "file";
      readonly data: string;
      readonly mode: number;
      readonly fingerprint: string;
    }
  | {
      readonly kind: "directory";
      readonly nodes: readonly (
        | { readonly path: string; readonly kind: "directory"; readonly mode: number }
        | {
            readonly path: string;
            readonly kind: "file";
            readonly mode: number;
            readonly data: string;
            readonly encoding?: "base64";
            readonly digest: string;
          }
      )[];
      readonly fingerprint: string;
    };

export interface InventoryCandidateObservation {
  readonly kind: InventorySource["kind"];
  readonly name: string;
  readonly normalizedName: string;
  readonly contentFingerprint: string;
  readonly physicalIdentity: string;
  readonly source: InventorySource;
  readonly relativePath?: string;
  readonly findings: readonly InventoryFindingCode[];
  readonly secretAdoptions: readonly InventorySecretAdoptionOffer[];
}

export interface CapturedInventoryCandidateObservation extends InventoryCandidateObservation {
  readonly snapshot: SafeRecursiveSnapshot;
  readonly publication: CapturedInventoryPublication;
  readonly sourceLink?: {
    readonly text: string;
    readonly boundaryRoot: string;
    readonly limits: SnapshotLimits;
  };
}

export interface InventorySourceFinding {
  readonly code: InventoryFindingCode;
  readonly source: InventorySource;
}

export interface InventorySourceInspection {
  readonly candidates: readonly InventoryCandidateObservation[];
  readonly findings: readonly InventorySourceFinding[];
}

export interface CapturedInventorySourceInspection {
  readonly candidates: readonly CapturedInventoryCandidateObservation[];
  readonly findings: readonly InventorySourceFinding[];
}

export interface ManagedInventoryRevision {
  readonly resourceId: string;
  readonly kind: InventorySource["kind"];
  readonly normalizedName: string;
  readonly contentFingerprint: string;
  readonly revisionId: string;
}
