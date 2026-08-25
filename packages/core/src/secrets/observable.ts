import type { Env } from "../env.js";
import type { TargetAcknowledgement } from "../model/index.js";
import {
  DURABLE_MUTATION_PLAN_DOMAIN,
  EXECUTABLE_MUTATION_PLAN_DOMAIN,
  MUTATION_AUTHORIZATION_ALGORITHM,
  MUTATION_AUTHORIZATION_SCHEMA_VERSION,
  type MutationAuthorizationEnvelope,
  OPERATION_JOURNAL_DOMAIN,
} from "../protocol/models.js";
import { isSensitiveSecretFieldName, scanTextForSecrets } from "./detector.js";
import { cellarerSecretReference, parseSecretReference } from "./reference.js";

export const REDACTED_SECRET = "[REDACTED]";

export type ObservableBoundary =
  | "plan"
  | "state"
  | "journal"
  | "receipt"
  | "activity"
  | "log"
  | "error"
  | "cli"
  | "web";

export class SecretValue {
  readonly #plaintext: string;

  private constructor(plaintext: string) {
    this.#plaintext = plaintext;
    Object.freeze(this);
  }

  static create(plaintext: string): SecretValue {
    return new SecretValue(plaintext);
  }

  use<T>(consumer: (plaintext: string) => T): T {
    return consumer(this.#plaintext);
  }

  toJSON(): never {
    throw new TypeError("secret value cannot be serialized");
  }

  toString(): never {
    throw new TypeError("secret value cannot be converted to text");
  }

  [Symbol.toPrimitive](): never {
    throw new TypeError("secret value cannot be converted to a primitive");
  }
}

export interface ObservableRedactionOptions {
  knownValues?: readonly SecretValue[];
  pretty?: boolean | number;
  /** Preserve only keys at exact paths in a validated durable protocol object. */
  protocolShape?: "operation-journal" | "operation-receipt";
}

export function createSecretValue(plaintext: string): SecretValue {
  return SecretValue.create(plaintext);
}

export function useSecretValue<T>(value: SecretValue, consumer: (plaintext: string) => T): T {
  return value.use(consumer);
}

const OBSERVABLE_KNOWN_VALUES = Symbol("cellarer.observable-known-values");
const OBSERVABLE_PROVIDER_SCOPE = Symbol("cellarer.observable-provider-scope");
const observableMutationAuthorizations = new WeakMap<object, MutationAuthorizationEnvelope>();
const observablePublicControlPlaneConfigs = new WeakSet<object>();
const observableOpenApiDocuments = new WeakSet<object>();

export interface ObservableProviderScope {
  readonly knownValues: readonly SecretValue[];
}

export function withObservableKnownValues(env: Env, knownValues: readonly SecretValue[]): Env {
  if (knownValues.length === 0) return env;
  return attachObservableKnownValues({ ...env }, knownValues);
}

export function observableOptionsForEnv(env: Env): ObservableRedactionOptions {
  const knownValues = observableKnownValues(env);
  return knownValues.length > 0 ? { knownValues } : {};
}

export function attachObservableKnownValues<T extends object>(
  value: T,
  knownValues: readonly SecretValue[],
): T {
  if (knownValues.length === 0) return value;
  Object.defineProperty(value, OBSERVABLE_KNOWN_VALUES, {
    value: Object.freeze([...knownValues]),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return value;
}

export function observableKnownValues(value: unknown): readonly SecretValue[] {
  if (typeof value !== "object" || value === null) return [];
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, OBSERVABLE_KNOWN_VALUES);
    if (descriptor) {
      if (!("value" in descriptor)) return [];
      const found = descriptor.value;
      if (Array.isArray(found) && found.every((item) => item instanceof SecretValue)) return found;
      return [];
    }
    return observableProviderScope(value)?.knownValues ?? [];
  } catch {
    return [];
  }
}

export function attachObservableProviderScope<T extends object>(
  value: T,
  scope: ObservableProviderScope,
): T {
  const existing = (value as { [OBSERVABLE_PROVIDER_SCOPE]?: unknown })[OBSERVABLE_PROVIDER_SCOPE];
  if (existing === scope) return value;
  if (existing !== undefined) {
    throw new TypeError("observable value already belongs to a different provider scope");
  }
  Object.defineProperty(value, OBSERVABLE_PROVIDER_SCOPE, {
    value: scope,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return value;
}

export function observableProviderScope(value: unknown): ObservableProviderScope | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, OBSERVABLE_PROVIDER_SCOPE);
    if (!descriptor || !("value" in descriptor)) return undefined;
    const found = descriptor.value;
    if (typeof found !== "object" || found === null) return undefined;
    const knownValues = Object.getOwnPropertyDescriptor(found, "knownValues");
    if (
      !knownValues ||
      !("value" in knownValues) ||
      !Array.isArray(knownValues.value) ||
      !knownValues.value.every((item) => item instanceof SecretValue)
    ) {
      return undefined;
    }
    return found as ObservableProviderScope;
  } catch {
    return undefined;
  }
}

export function redactObservableText(
  text: string,
  options: ObservableRedactionOptions = {},
): string {
  let redacted = text;
  for (const knownValue of options.knownValues ?? []) {
    redacted = knownValue.use((plaintext) =>
      plaintext.length === 0 ? redacted : redacted.split(plaintext).join(REDACTED_SECRET),
    );
  }
  return scanTextForSecrets(redacted).length > 0 ? REDACTED_SECRET : redacted;
}

export function containsObservableKnownValue(
  text: string,
  knownValues: readonly SecretValue[],
): boolean {
  return knownValues.some((knownValue) =>
    knownValue.use((plaintext) => plaintext.length > 0 && text.includes(plaintext)),
  );
}

/**
 * Captures protocol authorization metadata only after its producer or parser has verified it.
 * Observable serialization recognizes the registered object identity and never reflects over an
 * arbitrary Authorization-shaped value, because JavaScript cannot distinguish a Proxy from a
 * plain object without executing a trap.
 */
export function registerObservableMutationAuthorization<
  Domain extends MutationAuthorizationEnvelope["domain"],
>(
  value: MutationAuthorizationEnvelope<Domain>,
  domain: Domain,
): MutationAuthorizationEnvelope<Domain> {
  const snapshot = snapshotMutationAuthorization(value, domain);
  const registered = Object.freeze(snapshot) as MutationAuthorizationEnvelope<Domain>;
  observableMutationAuthorizations.set(value, registered);
  observableMutationAuthorizations.set(registered, registered);
  return registered;
}

/** Marks a freshly validated Core-owned config projection for path-specific public metadata. */
export function registerObservablePublicControlPlaneConfig<T extends object>(value: T): T {
  observablePublicControlPlaneConfigs.add(value);
  return value;
}

/**
 * Internal identity registry for an OpenAPI snapshot that public-boundary has already cloned,
 * validated, and frozen. Do not expose this generic marker from the package barrel.
 */
export function registerObservableOpenApiDocument<T extends object>(value: T): T {
  observableOpenApiDocuments.add(value);
  return value;
}

export function redactObservable(
  boundary: ObservableBoundary,
  value: unknown,
  options: ObservableRedactionOptions = {},
): unknown {
  if (boundary === "plan" || boundary === "state") assertNoSecretValues(value, boundary);
  return redactValue(boundary, value, options, false, new WeakSet<object>(), [], undefined);
}

export function serializeObservable(
  boundary: ObservableBoundary,
  value: unknown,
  options: ObservableRedactionOptions = {},
): string {
  const redacted = redactObservable(boundary, value, options);
  const spacing =
    options.pretty === true ? 2 : options.pretty === false ? undefined : options.pretty;
  const encoded = JSON.stringify(redacted, null, spacing);
  if (encoded === undefined) throw new TypeError(`cannot serialize ${boundary} output`);
  return encoded;
}

export function assertNoSecretValues(value: unknown, boundary = "observable"): void {
  assertNoSecretValue(value, boundary, new WeakSet<object>());
}

function assertNoSecretValue(value: unknown, boundary: string, seen: WeakSet<object>): void {
  if (value instanceof SecretValue) {
    throw new TypeError(`secret value is not allowed at the ${boundary} boundary`);
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (value instanceof Error) {
    if ("cause" in value) assertNoSecretValue(value.cause, boundary, seen);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) assertNoSecretValue(child, boundary, seen);
    return;
  }
  const entries = enumerableDataEntries(value);
  if (entries === null) return;
  for (const [key, child] of entries) {
    // Authorization-shaped input is handled by the identity registry in redactValue. Traversing
    // an untrusted candidate here would execute accessors or Proxy traps before it can fail closed.
    if (key === "authorization") continue;
    assertNoSecretValue(child, boundary, seen);
  }
}

function redactValue(
  boundary: ObservableBoundary,
  value: unknown,
  options: ObservableRedactionOptions,
  sensitiveContext: boolean,
  seen: WeakSet<object>,
  path: readonly string[],
  publicConfigPath: readonly string[] | undefined,
): unknown {
  if (value instanceof SecretValue) return REDACTED_SECRET;
  if (typeof value === "string") {
    if (isSupportedSecretReference(value) || (sensitiveContext && value.trim().length === 0)) {
      return value;
    }
    if (sensitiveContext) return REDACTED_SECRET;
    return redactObservableText(value, options);
  }
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    return sensitiveContext ? REDACTED_SECRET : value;
  }
  if (value instanceof Date) return sensitiveContext ? REDACTED_SECRET : value.toISOString();
  if (value instanceof Error) {
    const error: Record<string, unknown> = {
      name: sensitiveContext ? REDACTED_SECRET : value.name,
      message: sensitiveContext ? REDACTED_SECRET : redactObservableText(value.message, options),
    };
    const code = (value as Error & { code?: unknown }).code;
    if (code !== undefined) {
      error.code = redactValue(
        boundary,
        code,
        options,
        sensitiveContext,
        seen,
        [...path, "code"],
        undefined,
      );
    }
    const cause = value.cause;
    if (cause !== undefined) {
      error.cause = redactValue(
        boundary,
        cause,
        options,
        sensitiveContext,
        seen,
        [...path, "cause"],
        undefined,
      );
    }
    return error;
  }
  if (observableOpenApiDocuments.has(value)) {
    return redactPublicJsonDocument(value, options, new WeakSet<object>());
  }
  if (seen.has(value)) throw new TypeError("observable output cannot contain circular values");
  seen.add(value);
  const currentPublicConfigPath = observablePublicControlPlaneConfigs.has(value)
    ? []
    : publicConfigPath;
  if (Array.isArray(value)) {
    const entries = strictArrayDataValues(value);
    if (!entries) return REDACTED_SECRET;
    const result = entries.map((child) =>
      redactValue(
        boundary,
        child,
        options,
        sensitiveContext,
        seen,
        [...path, "*"],
        currentPublicConfigPath === undefined ? undefined : [...currentPublicConfigPath, "*"],
      ),
    );
    seen.delete(value);
    return result;
  }
  const acknowledgement =
    !sensitiveContext && isExactTargetAcknowledgement(value) ? value : undefined;
  const entries = enumerableDataEntries(value);
  if (entries === null) return REDACTED_SECRET;
  const result: Record<string, unknown> = {};
  const reservedKeys = new Set(
    entries.flatMap(([key]) => (observableKeyRequiresRedaction(key, options, path) ? [] : [key])),
  );
  const emittedKeys = new Set<string>();
  for (const [key, child] of entries) {
    const outputKey = observableOutputKey(key, options, path, reservedKeys, emittedKeys);
    if (!sensitiveContext && key === "authorization") {
      const registered =
        typeof child === "object" && child !== null
          ? observableMutationAuthorizations.get(child)
          : undefined;
      // Only verified factory/parser identities may expose the public seal metadata. Unknown,
      // getter-backed, custom-prototype, toJSON-bearing, and Proxy-wrapped values fail closed
      // without a single property read or reflective operation on the candidate.
      result[outputKey] = registered ?? REDACTED_SECRET;
      continue;
    }
    if (acknowledgement && key === "token") {
      // This exact typed acknowledgement is the only token-shaped observable allowed through: its
      // digest is required verbatim by the next apply/revert request. Near-miss objects still take
      // the ordinary sensitive-field path below.
      result[outputKey] = child;
      continue;
    }
    if (
      !sensitiveContext &&
      (boundary === "cli" || boundary === "web") &&
      (key === "secretReferenceNames" || key === "secretRefs")
    ) {
      result[outputKey] = child === undefined ? undefined : redactReferenceNames(child, options);
      continue;
    }
    result[outputKey] = redactValue(
      boundary,
      child,
      options,
      sensitiveContext ||
        (!isPublicControlPlaneMetadataField(currentPublicConfigPath, key) &&
          isSensitiveSecretFieldName(key)),
      seen,
      [...path, key],
      currentPublicConfigPath === undefined ? undefined : [...currentPublicConfigPath, key],
    );
  }
  seen.delete(value);
  return result;
}

function redactPublicJsonDocument(
  value: unknown,
  options: ObservableRedactionOptions,
  seen: WeakSet<object>,
): unknown {
  if (value instanceof SecretValue) return REDACTED_SECRET;
  if (typeof value === "string") return redactObservableText(value, options);
  if (value === undefined || value === null || typeof value !== "object") return value;
  if (value instanceof Date) return redactObservableText(value.toISOString(), options);
  if (value instanceof Error || seen.has(value)) return REDACTED_SECRET;
  seen.add(value);
  if (Array.isArray(value)) {
    const entries = strictArrayDataValues(value);
    if (!entries) return REDACTED_SECRET;
    const result = entries.map((child) => redactPublicJsonDocument(child, options, seen));
    seen.delete(value);
    return result;
  }
  const entries = enumerableDataEntries(value);
  if (entries === null) return REDACTED_SECRET;
  const result: Record<string, unknown> = {};
  const emittedKeys = new Set<string>();
  for (const [key, child] of entries) {
    const redactedKey = redactObservableText(key, options);
    const outputKey = uniquePublicJsonKey(
      redactedKey === key ? key : REDACTED_OBSERVABLE_KEY,
      emittedKeys,
    );
    result[outputKey] = redactPublicJsonDocument(child, options, seen);
  }
  seen.delete(value);
  return result;
}

function uniquePublicJsonKey(key: string, emittedKeys: Set<string>): string {
  if (!emittedKeys.has(key)) {
    emittedKeys.add(key);
    return key;
  }
  let suffix = 2;
  let candidate = `${key}_${suffix}`;
  while (emittedKeys.has(candidate)) {
    suffix += 1;
    candidate = `${key}_${suffix}`;
  }
  emittedKeys.add(candidate);
  return candidate;
}

function isPublicControlPlaneMetadataField(
  path: readonly string[] | undefined,
  key: string,
): boolean {
  if (path === undefined) return false;
  return (
    (key === "secretPatternSuppressions" && path.length === 2 && path[0] === "artifacts") ||
    (key === "supportedSecretReferences" &&
      path.length === 3 &&
      (path[0] === "adapterOverrides" || path[0] === "customAdapters") &&
      path[2] === "mcp")
  );
}

const REDACTED_OBSERVABLE_KEY = "[REDACTED_KEY]";

function observableKeyRequiresRedaction(
  key: string,
  options: ObservableRedactionOptions,
  path: readonly string[],
): boolean {
  return (
    !isFixedProtocolKey(options.protocolShape, path, key) &&
    redactObservableText(key, options) !== key
  );
}

function observableOutputKey(
  key: string,
  options: ObservableRedactionOptions,
  path: readonly string[],
  reservedKeys: ReadonlySet<string>,
  emittedKeys: Set<string>,
): string {
  if (!observableKeyRequiresRedaction(key, options, path)) {
    emittedKeys.add(key);
    return key;
  }
  let suffix = 1;
  let candidate = REDACTED_OBSERVABLE_KEY;
  while (reservedKeys.has(candidate) || emittedKeys.has(candidate)) {
    suffix += 1;
    candidate = `[REDACTED_KEY_${suffix}]`;
  }
  emittedKeys.add(candidate);
  return candidate;
}

const AUTHORIZATION_KEYS = [
  "schemaVersion",
  "domain",
  "algorithm",
  "authorityId",
  "authorityEpoch",
  "seal",
] as const;
const TARGET_STATE_KEYS = [
  "state",
  "fingerprint",
  "recoverySnapshot",
  "recoverySnapshotDigest",
  "recoverySnapshotMode",
] as const;
const ACTION_RECEIPT_KEYS = [
  "actionId",
  "target",
  "outcome",
  "before",
  "after",
  "recordedAt",
  "error",
] as const;
const OPERATION_RECEIPT_KEYS = [
  "schemaVersion",
  "operationId",
  "planId",
  "planDigest",
  "operation",
  "baseRevision",
  "resultingRevision",
  "outcome",
  "actionReceipts",
  "startedAt",
  "completedAt",
] as const;

function fixedKeys(keys: readonly string[]): ReadonlySet<string> {
  return new Set(keys);
}

const RECEIPT_STRUCTURE_KEYS = new Map<string, ReadonlySet<string>>([
  ["", fixedKeys(OPERATION_RECEIPT_KEYS)],
  ["actionReceipts/*", fixedKeys(ACTION_RECEIPT_KEYS)],
  ["actionReceipts/*/before", fixedKeys(TARGET_STATE_KEYS)],
  ["actionReceipts/*/after", fixedKeys(TARGET_STATE_KEYS)],
  ["actionReceipts/*/error", fixedKeys(["code", "message"])],
]);

const JOURNAL_STRUCTURE_KEYS = new Map<string, ReadonlySet<string>>([
  [
    "",
    fixedKeys([
      "schemaVersion",
      "operationId",
      "sequence",
      "previousJournalSeal",
      "plan",
      "nextRevision",
      "status",
      "startedAt",
      "updatedAt",
      "actions",
      "externalEffects",
      "statePublications",
      "completedReceipt",
      "authorization",
    ]),
  ],
  ["authorization", fixedKeys(AUTHORIZATION_KEYS)],
  [
    "plan",
    fixedKeys([
      "schemaVersion",
      "planId",
      "operation",
      "baseRevision",
      "normalizedInputsDigest",
      "targetPreconditions",
      "actions",
      "externalEffects",
      "expires",
      "digest",
      "durableDigest",
      "authorization",
    ]),
  ],
  ["plan/authorization", fixedKeys(AUTHORIZATION_KEYS)],
  ["plan/expires", fixedKeys(["policy", "expiresAt"])],
  ["plan/targetPreconditions/*", fixedKeys(["actionId", "target", "expected"])],
  ["plan/targetPreconditions/*/expected", fixedKeys(TARGET_STATE_KEYS)],
  [
    "plan/actions/*",
    fixedKeys(["actionId", "kind", "target", "payloadDigest", "payload", "postcondition"]),
  ],
  // Durable provider recovery permits only this exact identity payload. Any other nested key is
  // user-controlled Canonical JSON and must take the ordinary collision-safe redaction path.
  ["plan/actions/*/payload", fixedKeys(["provider", "service", "name"])],
  ["plan/actions/*/postcondition", fixedKeys(TARGET_STATE_KEYS)],
  [
    "plan/externalEffects/*",
    fixedKeys(["effectId", "kind", "provider", "targetName", "cleanupCommand"]),
  ],
  ["plan/externalEffects/*/provider", fixedKeys(["kind", "service"])],
  ["actions/*", fixedKeys(["actionId", "target", "status", "receipt"])],
  ["actions/*/receipt", fixedKeys(ACTION_RECEIPT_KEYS)],
  ["actions/*/receipt/before", fixedKeys(TARGET_STATE_KEYS)],
  ["actions/*/receipt/after", fixedKeys(TARGET_STATE_KEYS)],
  ["actions/*/receipt/error", fixedKeys(["code", "message"])],
  ["externalEffects/*", fixedKeys(["effectId", "status", "evidence"])],
  ["externalEffects/*/evidence", fixedKeys(["status", "provider", "targetName", "cleanupCommand"])],
  ["externalEffects/*/evidence/provider", fixedKeys(["kind", "service"])],
  ["statePublications/*", fixedKeys(["path", "digest", "mode"])],
  ["completedReceipt", fixedKeys(OPERATION_RECEIPT_KEYS)],
  ["completedReceipt/actionReceipts/*", fixedKeys(ACTION_RECEIPT_KEYS)],
  ["completedReceipt/actionReceipts/*/before", fixedKeys(TARGET_STATE_KEYS)],
  ["completedReceipt/actionReceipts/*/after", fixedKeys(TARGET_STATE_KEYS)],
  ["completedReceipt/actionReceipts/*/error", fixedKeys(["code", "message"])],
]);

function isFixedProtocolKey(
  shape: ObservableRedactionOptions["protocolShape"],
  path: readonly string[],
  key: string,
): boolean {
  if (shape === undefined) return false;
  const allowedKeys =
    shape === "operation-journal"
      ? JOURNAL_STRUCTURE_KEYS.get(path.join("/"))
      : RECEIPT_STRUCTURE_KEYS.get(path.join("/"));
  return allowedKeys?.has(key) === true;
}

function redactReferenceNames(
  value: unknown,
  options: ObservableRedactionOptions,
): readonly string[] | typeof REDACTED_SECRET {
  const values = strictArrayDataValues(value);
  if (!values?.every((item): item is string => typeof item === "string")) {
    return REDACTED_SECRET;
  }
  return values.map((name) => {
    try {
      cellarerSecretReference(name);
    } catch {
      return REDACTED_SECRET;
    }
    return redactObservableText(name, options);
  });
}

function strictArrayDataValues(value: unknown): unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    if (Object.getPrototypeOf(value) !== Array.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== "string")) return null;
    const length = Reflect.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value)) return null;
    const elementKeys = Array.from({ length: length.value as number }, (_, index) => String(index));
    const expectedKeys = [...elementKeys, "length"].sort();
    const actualKeys = (ownKeys as string[]).sort();
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])
    ) {
      return null;
    }
    return elementKeys.map((key) => {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("observable array must use enumerable own data elements");
      }
      return descriptor.value;
    });
  } catch {
    return null;
  }
}

function snapshotMutationAuthorization<Domain extends MutationAuthorizationEnvelope["domain"]>(
  value: MutationAuthorizationEnvelope<Domain>,
  domain: Domain,
): MutationAuthorizationEnvelope<Domain> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("mutation authorization must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expectedKeys = [
    "schemaVersion",
    "domain",
    "algorithm",
    "authorityId",
    "authorityEpoch",
    "seal",
  ];
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== "string") ||
    (keys as string[]).sort().join("\0") !== [...expectedKeys].sort().join("\0")
  ) {
    throw new TypeError("mutation authorization must use exact own data properties");
  }
  const data = Object.fromEntries(
    expectedKeys.map((key) => {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("mutation authorization must use enumerable own data properties");
      }
      return [key, descriptor.value];
    }),
  ) as unknown as MutationAuthorizationEnvelope<Domain>;
  if (
    data.schemaVersion !== MUTATION_AUTHORIZATION_SCHEMA_VERSION ||
    data.domain !== domain ||
    ![
      EXECUTABLE_MUTATION_PLAN_DOMAIN,
      DURABLE_MUTATION_PLAN_DOMAIN,
      OPERATION_JOURNAL_DOMAIN,
    ].includes(data.domain) ||
    data.algorithm !== MUTATION_AUTHORIZATION_ALGORITHM ||
    typeof data.authorityId !== "string" ||
    data.authorityId.length === 0 ||
    !Number.isSafeInteger(data.authorityEpoch) ||
    data.authorityEpoch <= 0 ||
    typeof data.seal !== "string" ||
    !/^hmac-sha256:[0-9a-f]{64}$/.test(data.seal)
  ) {
    throw new TypeError("mutation authorization is invalid");
  }
  return data;
}

function enumerableDataEntries(value: object): [string, unknown][] | null {
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null && prototype !== Map.prototype) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const privateSymbols = new Set([OBSERVABLE_KNOWN_VALUES, OBSERVABLE_PROVIDER_SCOPE]);
    if (
      keys.some((key) => typeof key === "symbol" && !privateSymbols.has(key)) ||
      keys.includes("toJSON")
    ) {
      return null;
    }
    for (const symbol of privateSymbols) {
      const descriptor = Object.getOwnPropertyDescriptor(value, symbol);
      if (descriptor && (!("value" in descriptor) || descriptor.enumerable)) return null;
    }
    const entries: [string, unknown][] = [];
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable) continue;
      if (!("value" in descriptor)) return null;
      entries.push([key, descriptor.value]);
    }
    return entries;
  } catch {
    return null;
  }
}

function isExactTargetAcknowledgement(value: object): value is TargetAcknowledgement {
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("token")) return false;
    const kind = descriptors.kind;
    const token = descriptors.token;
    if (
      !kind ||
      !("value" in kind) ||
      !kind.enumerable ||
      !token ||
      !("value" in token) ||
      !token.enumerable
    ) {
      return false;
    }
    return (
      (kind.value === "replace-unowned" ||
        kind.value === "override-drift" ||
        kind.value === "revert-drift" ||
        kind.value === "uninstall-drift") &&
      typeof token.value === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(token.value)
    );
  } catch {
    return false;
  }
}

function isSupportedSecretReference(value: string): boolean {
  try {
    return value === value.trim() && parseSecretReference(value) !== null;
  } catch {
    return false;
  }
}
