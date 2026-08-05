import { isReservedMutationAuthorityAccount } from "./authority-namespace.js";

const ENVIRONMENT_REFERENCE_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const CELLARER_REFERENCE_RE = /^\$\{CELLARER_SECRET:([^}\r\n]+)\}$/;

export interface EnvironmentSecretReference {
  readonly kind: "environment";
  readonly name: string;
}

export interface CellarerSecretReference {
  readonly kind: "cellarer";
  readonly name: string;
}

export type SecretReference = EnvironmentSecretReference | CellarerSecretReference;

export function environmentSecretReference(name: string): EnvironmentSecretReference {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError(`invalid environment secret reference name ${JSON.stringify(name)}`);
  }
  return Object.freeze({ kind: "environment", name });
}

export function cellarerSecretReference(name: string): CellarerSecretReference {
  if (
    name.length === 0 ||
    name.trim() !== name ||
    /[{}\r\n]/.test(name) ||
    isReservedMutationAuthorityAccount(name)
  ) {
    throw new TypeError(`invalid cellarer secret reference name ${JSON.stringify(name)}`);
  }
  return Object.freeze({ kind: "cellarer", name });
}

export function parseSecretReference(value: string): SecretReference | null {
  const candidate = value.trim();
  const cellarer = CELLARER_REFERENCE_RE.exec(candidate);
  if (cellarer) return cellarerSecretReference(cellarer[1] as string);
  const environment = ENVIRONMENT_REFERENCE_RE.exec(candidate);
  if (environment) return environmentSecretReference(environment[1] as string);
  return null;
}

export function secretReferenceToken(reference: SecretReference): string {
  return reference.kind === "environment"
    ? `\${${reference.name}}`
    : `\${CELLARER_SECRET:${reference.name}}`;
}
