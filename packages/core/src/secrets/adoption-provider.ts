import type {
  InventorySecretAdoptionProvider,
  InventorySecretProviderPrecondition,
} from "../protocol/client-types.js";
import type { DurableOperationExternalEffect } from "../protocol/models.js";
import { sha256 } from "../store/checksum.js";

export interface InventorySecretReferenceBinding {
  readonly provider: InventorySecretAdoptionProvider;
  readonly providerPrecondition: InventorySecretProviderPrecondition;
  readonly targetName: string;
}

export type InventorySecretReferenceCreateResult =
  | { readonly created: true }
  | { readonly created: false; readonly reason: "already-exists" | "unavailable" };

interface BoundInventorySecretValue {
  use<T>(consumer: (plaintext: string) => T): T;
  toJSON(): never;
  toString(): never;
  [Symbol.toPrimitive](): never;
}

export type ReadBoundInventorySecretValue = () => Promise<BoundInventorySecretValue>;

/**
 * Adoption receives one atomic, plan-shaped capability instead of a general provider handle.
 * Implementations check absence before invoking the reader and never emulate this with public
 * get/set operations whose race could overwrite an existing reference.
 */
export interface InventorySecretAdoptionProviderPort {
  createExactAbsentReference(
    binding: InventorySecretReferenceBinding,
    readBoundSourceValue: ReadBoundInventorySecretValue,
  ): Promise<InventorySecretReferenceCreateResult>;
}

export function inventorySecretAdoptionCleanupCommand(
  provider: InventorySecretAdoptionProvider,
  targetName: string,
): string {
  return `cellarer secret rm ${targetName} --provider ${provider.kind}`;
}

export function inventorySecretAdoptionExternalEffect(
  provider: InventorySecretAdoptionProvider,
  targetName: string,
): DurableOperationExternalEffect {
  const cleanupCommand = inventorySecretAdoptionCleanupCommand(provider, targetName);
  const identity = {
    kind: "secret-reference-create" as const,
    provider,
    targetName,
    cleanupCommand,
  };
  return Object.freeze({
    effectId: sha256(JSON.stringify(identity)),
    ...identity,
  });
}

export function isInventorySecretAdoptionExternalEffect(
  value: unknown,
): value is DurableOperationExternalEffect {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const effect = value as Partial<DurableOperationExternalEffect>;
  const provider = effect.provider;
  if (
    Object.keys(value).sort().join("\0") !==
      ["cleanupCommand", "effectId", "kind", "provider", "targetName"].sort().join("\0") ||
    effect.kind !== "secret-reference-create" ||
    typeof effect.effectId !== "string" ||
    typeof effect.targetName !== "string" ||
    !/^[a-z0-9][a-z0-9-]*$/.test(effect.targetName) ||
    !isAdoptionProvider(provider)
  ) {
    return false;
  }
  const expected = inventorySecretAdoptionExternalEffect(provider, effect.targetName);
  return effect.effectId === expected.effectId && effect.cleanupCommand === expected.cleanupCommand;
}

function isAdoptionProvider(value: unknown): value is InventorySecretAdoptionProvider {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const provider = value as Partial<InventorySecretAdoptionProvider>;
  if (provider.kind === "vault") return Object.keys(value).join("\0") === "kind";
  return (
    provider.kind === "keychain" &&
    provider.service === "cellarer" &&
    Object.keys(value).sort().join("\0") === "kind\0service"
  );
}
