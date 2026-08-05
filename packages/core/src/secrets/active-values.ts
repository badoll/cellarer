import type { Env } from "../env.js";
import { isSensitiveSecretFieldName } from "./detector.js";
import { listManagedKeychainSecretNames } from "./keychain-metadata.js";
import { getKeychainSecret } from "./keychain-provider.js";
import {
  attachObservableKnownValues,
  attachObservableProviderScope,
  createSecretValue,
  type SecretValue,
} from "./observable.js";
import {
  cellarerSecretReference,
  environmentSecretReference,
  parseSecretReference,
  type SecretReference,
  secretReferenceToken,
} from "./reference.js";
import { loadVault } from "./vault.js";

export interface ActiveSecretValueOptions {
  readonly secretMode: "env" | "vault" | "keychain";
  readonly vaultPassphrase?: string;
  readonly keychainService?: string;
  /** Mutation boundaries set this so missing or unavailable references fail before effects. */
  readonly requireAvailable?: boolean;
}

export interface ActiveSecretValue {
  readonly reference: SecretReference;
  readonly value: SecretValue;
}

export type ProviderAvailability = "available" | "missing" | "unavailable";

export interface ProviderScope {
  readonly mode: ActiveSecretValueOptions["secretMode"];
  readonly service: string;
  readonly activeValues: readonly ActiveSecretValue[];
  readonly knownValues: readonly SecretValue[];
  readonly availability: ReadonlyMap<string, ProviderAvailability>;
}

interface MutableProviderScope extends ProviderScope {
  mode: ActiveSecretValueOptions["secretMode"];
  service: string;
  activeValues: ActiveSecretValue[];
  knownValues: SecretValue[];
  availability: Map<string, ProviderAvailability>;
  seenValues: Set<string>;
  referenceLoads: Map<string, Promise<ProviderResolution>>;
  vaultLoad?: Promise<Record<string, string>>;
}

interface ProviderResolution {
  readonly availability: ProviderAvailability;
  readonly plaintext?: string;
}

const PROVIDER_SCOPE = Symbol("cellarer.provider-scope");

export function createProviderScope(options: ActiveSecretValueOptions): ProviderScope {
  return {
    mode: options.secretMode,
    service: options.keychainService ?? "cellarer",
    activeValues: [],
    knownValues: [],
    availability: new Map(),
    seenValues: new Set(),
    referenceLoads: new Map(),
  } as MutableProviderScope;
}

export function withProviderScope(env: Env, scope: ProviderScope): Env {
  const scoped = { ...env };
  Object.defineProperty(scoped, PROVIDER_SCOPE, {
    value: scope,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return attachObservableProviderScope(scoped, scope);
}

export function providerScopeForEnv(env: Env): ProviderScope | undefined {
  return (env as Env & { [PROVIDER_SCOPE]?: ProviderScope })[PROVIDER_SCOPE];
}

export function configureProviderScope(
  scope: ProviderScope,
  options: ActiveSecretValueOptions,
): void {
  const mutable = scope as MutableProviderScope;
  const service = options.keychainService ?? "cellarer";
  const changed = mutable.mode !== options.secretMode || mutable.service !== service;
  if (changed && (mutable.activeValues.length > 0 || mutable.availability.size > 0)) {
    throw new TypeError("cannot reconfigure an active secret provider scope");
  }
  if (!changed) return;
  mutable.mode = options.secretMode;
  mutable.service = service;
  mutable.referenceLoads.clear();
  mutable.vaultLoad = undefined;
}

export function attachProviderScope<T extends object>(value: T, scope: ProviderScope): T {
  return attachObservableProviderScope(value, scope);
}

export class SecretProviderScopeError extends Error {
  readonly code = "SECRET_PROVIDER_SCOPE_UNAVAILABLE" as const;
  readonly references: readonly string[];

  constructor(references: readonly SecretReference[]) {
    const tokens = references.map(secretReferenceToken);
    super(`active secret references are missing or unavailable: ${tokens.join(", ")}`);
    this.name = "SecretProviderScopeError";
    this.references = Object.freeze(tokens);
  }
}

export function discoverSecretReferences(texts: readonly string[]): SecretReference[] {
  const references = new Map<string, SecretReference>();
  for (const text of texts) {
    for (const token of text.match(/\$\{(?:CELLARER_SECRET:[^}\r\n]+|[A-Za-z_][A-Za-z0-9_]*)\}/g) ??
      []) {
      const reference = parseSecretReference(token);
      if (reference) references.set(secretReferenceToken(reference), reference);
    }
  }
  return [...references.values()];
}

export async function resolveActiveSecretValues(
  env: Env,
  storeRoot: string,
  references: readonly SecretReference[],
  options: ActiveSecretValueOptions,
): Promise<ActiveSecretValue[]> {
  const existingScope = providerScopeForEnv(env) as MutableProviderScope | undefined;
  const scope =
    existingScope?.mode === options.secretMode &&
    existingScope.service === (options.keychainService ?? "cellarer")
      ? existingScope
      : (createProviderScope(options) as MutableProviderScope);
  const unavailable: SecretReference[] = [];

  for (const reference of references) {
    const token = secretReferenceToken(reference);
    const cached = scope.availability.get(token);
    if (cached) {
      if (cached !== "available") unavailable.push(reference);
      continue;
    }
    if (reference.kind !== "environment") continue;
    const plaintext = env.env[reference.name];
    addScopeValue(scope, reference, plaintext);
    if (!plaintext) unavailable.push(reference);
  }
  const cellarer = references.filter((reference) => reference.kind === "cellarer");
  for (const reference of cellarer) {
    const token = secretReferenceToken(reference);
    const cached = scope.availability.get(token);
    if (cached) {
      if (cached !== "available") unavailable.push(reference);
      continue;
    }
    let load = scope.referenceLoads.get(token);
    if (!load) {
      load = loadCellarerReference(env, storeRoot, reference.name, options, scope);
      scope.referenceLoads.set(token, load);
    }
    const resolution = await load;
    if (resolution.availability === "available") {
      addScopeValue(scope, reference, resolution.plaintext);
    } else {
      scope.availability.set(token, resolution.availability);
      unavailable.push(reference);
    }
  }
  if (options.requireAvailable && unavailable.length > 0) {
    const error = attachObservableKnownValues(
      new SecretProviderScopeError(dedupeReferences(unavailable)),
      scope.knownValues,
    );
    throw attachProviderScope(error, scope);
  }
  return scope.activeValues;
}

export async function inventoryActiveSecretValues(
  env: Env,
  storeRoot: string,
  options: ActiveSecretValueOptions,
): Promise<ActiveSecretValue[]> {
  const existing = providerScopeForEnv(env) as MutableProviderScope | undefined;
  const scope =
    existing?.mode === options.secretMode &&
    existing.service === (options.keychainService ?? "cellarer")
      ? existing
      : (createProviderScope(options) as MutableProviderScope);
  const environmentReferences = Object.entries(env.env).flatMap(([name, value]) =>
    value && isSensitiveSecretFieldName(name) ? [environmentSecretReference(name)] : [],
  );
  await resolveActiveSecretValues(
    withProviderScope(env, scope),
    storeRoot,
    environmentReferences,
    options,
  );
  if (options.secretMode === "vault" && options.vaultPassphrase) {
    try {
      scope.vaultLoad ??= loadVault(env, storeRoot, options.vaultPassphrase);
      const vault = await scope.vaultLoad;
      for (const [name, plaintext] of Object.entries(vault)) {
        addScopeValue(scope, cellarerSecretReference(name), plaintext);
      }
    } catch {
      if (options.requireAvailable) {
        throw attachProviderScope(
          new SecretProviderScopeError([cellarerSecretReference("vault")]),
          scope,
        );
      }
    }
  } else if (options.secretMode === "keychain") {
    const names = await listManagedKeychainSecretNames(
      env,
      storeRoot,
      options.keychainService ?? "cellarer",
    );
    await resolveActiveSecretValues(env, storeRoot, names.map(cellarerSecretReference), options);
  }
  return scope.activeValues;
}

function addScopeValue(
  scope: MutableProviderScope,
  reference: SecretReference,
  plaintext: string | undefined,
): void {
  const token = secretReferenceToken(reference);
  if (!plaintext) {
    scope.availability.set(token, "missing");
    return;
  }
  scope.availability.set(token, "available");
  if (scope.seenValues.has(plaintext)) return;
  scope.seenValues.add(plaintext);
  const value = createSecretValue(plaintext);
  scope.activeValues.push({ reference, value });
  scope.knownValues.push(value);
}

async function loadCellarerReference(
  env: Env,
  storeRoot: string,
  name: string,
  options: ActiveSecretValueOptions,
  scope: MutableProviderScope,
): Promise<ProviderResolution> {
  if (options.secretMode === "keychain") {
    if (!env.secretStore) return { availability: "unavailable" };
    try {
      const result = await getKeychainSecret(
        env.secretStore,
        options.keychainService ?? "cellarer",
        name,
      );
      return result.found
        ? result.value.use((plaintext) => ({ availability: "available", plaintext }))
        : { availability: "missing" };
    } catch {
      return { availability: "unavailable" };
    }
  }
  if (!options.vaultPassphrase) return { availability: "unavailable" };
  try {
    scope.vaultLoad ??= loadVault(env, storeRoot, options.vaultPassphrase);
    const vault = await scope.vaultLoad;
    const plaintext = vault[name];
    return plaintext === undefined
      ? { availability: "missing" }
      : { availability: "available", plaintext };
  } catch {
    return { availability: "unavailable" };
  }
}

export async function discoverActiveSecretValues(
  env: Env,
  storeRoot: string,
  texts: readonly string[],
  options: ActiveSecretValueOptions,
): Promise<ActiveSecretValue[]> {
  return resolveActiveSecretValues(env, storeRoot, discoverSecretReferences(texts), options);
}

export function knownSecretValueOffsets(
  content: string,
  activeValues: readonly ActiveSecretValue[],
): number[] {
  const offsets: number[] = [];
  for (const active of activeValues) {
    active.value.use((plaintext) => {
      if (plaintext.length === 0) return;
      let index = content.indexOf(plaintext);
      while (index >= 0) {
        offsets.push(index);
        index = content.indexOf(plaintext, index + plaintext.length);
      }
    });
  }
  return offsets.sort((left, right) => left - right);
}

export function containsKnownSecretValue(
  content: string,
  activeValues: readonly ActiveSecretValue[],
): boolean {
  return activeValues.some((active) =>
    active.value.use((plaintext) => plaintext.length > 0 && content.includes(plaintext)),
  );
}

function dedupeReferences(references: readonly SecretReference[]): SecretReference[] {
  const unique = new Map<string, SecretReference>();
  for (const reference of references) unique.set(secretReferenceToken(reference), reference);
  return [...unique.values()];
}
