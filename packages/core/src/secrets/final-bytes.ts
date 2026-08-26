import {
  scanStructuredFileSecretFindings,
  scanStructuredSecretFindings,
  scanTextForSecrets,
} from "./detector.js";
import { containsObservableKnownValue, type SecretValue } from "./observable.js";

export class FinalSecretByteGuardError extends Error {
  readonly code = "FINAL_SECRET_BYTE_GUARD" as const;

  constructor() {
    super("final serialized bytes contain a secret value");
    this.name = "FinalSecretByteGuardError";
  }
}

export function assertFinalSerializedSecretBytes(
  data: string,
  knownValues: readonly SecretValue[],
  source?: string,
): void {
  assertFinalSerializedTextBytes(data, knownValues);
  if (source && scanStructuredFileSecretFindings(source, data).length > 0) {
    throw new FinalSecretByteGuardError();
  }
  try {
    if (scanStructuredSecretFindings(JSON.parse(data)).length > 0) {
      throw new FinalSecretByteGuardError();
    }
  } catch (error) {
    if (error instanceof FinalSecretByteGuardError) throw error;
  }
}

export function assertFinalSerializedTextBytes(
  data: string,
  knownValues: readonly SecretValue[],
): void {
  if (containsObservableKnownValue(data, knownValues) || scanTextForSecrets(data).length > 0) {
    throw new FinalSecretByteGuardError();
  }
}
