import type { Env } from "../env.js";
import type { TargetAcknowledgement } from "../model/index.js";
import { isSensitiveSecretFieldName, scanTextForSecrets } from "./detector.js";
import { parseSecretReference } from "./reference.js";

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
}

export function createSecretValue(plaintext: string): SecretValue {
  return SecretValue.create(plaintext);
}

export function useSecretValue<T>(value: SecretValue, consumer: (plaintext: string) => T): T {
  return value.use(consumer);
}

const OBSERVABLE_KNOWN_VALUES = Symbol("cellarer.observable-known-values");
const OBSERVABLE_PROVIDER_SCOPE = Symbol("cellarer.observable-provider-scope");

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
  const found = (value as { [OBSERVABLE_KNOWN_VALUES]?: unknown })[OBSERVABLE_KNOWN_VALUES];
  if (Array.isArray(found) && found.every((item) => item instanceof SecretValue)) return found;
  return observableProviderScope(value)?.knownValues ?? [];
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
  const found = (value as { [OBSERVABLE_PROVIDER_SCOPE]?: unknown })[OBSERVABLE_PROVIDER_SCOPE];
  if (
    typeof found !== "object" ||
    found === null ||
    !Array.isArray((found as ObservableProviderScope).knownValues)
  ) {
    return undefined;
  }
  return found as ObservableProviderScope;
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

export function redactObservable(
  boundary: ObservableBoundary,
  value: unknown,
  options: ObservableRedactionOptions = {},
): unknown {
  if (boundary === "plan" || boundary === "state") assertNoSecretValues(value, boundary);
  return redactValue(value, options, false, new WeakSet<object>());
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
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    assertNoSecretValue(child, boundary, seen);
  }
}

function redactValue(
  value: unknown,
  options: ObservableRedactionOptions,
  sensitiveContext: boolean,
  seen: WeakSet<object>,
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
    if (code !== undefined) error.code = redactValue(code, options, sensitiveContext, seen);
    const cause = value.cause;
    if (cause !== undefined) error.cause = redactValue(cause, options, sensitiveContext, seen);
    return error;
  }
  if (seen.has(value)) throw new TypeError("observable output cannot contain circular values");
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((child) => redactValue(child, options, sensitiveContext, seen));
    seen.delete(value);
    return result;
  }
  const acknowledgement =
    !sensitiveContext && isExactTargetAcknowledgement(value) ? value : undefined;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (acknowledgement && key === "token") {
      // This exact typed acknowledgement is the only token-shaped observable allowed through: its
      // digest is required verbatim by the next apply/revert request. Near-miss objects still take
      // the ordinary sensitive-field path below.
      result[key] = child;
      continue;
    }
    result[key] = redactValue(
      child,
      options,
      sensitiveContext || isSensitiveSecretFieldName(key),
      seen,
    );
  }
  seen.delete(value);
  return result;
}

function isExactTargetAcknowledgement(value: object): value is TargetAcknowledgement {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("token")) return false;
  const candidate = value as Partial<TargetAcknowledgement>;
  return (
    (candidate.kind === "replace-unowned" ||
      candidate.kind === "override-drift" ||
      candidate.kind === "revert-drift") &&
    typeof candidate.token === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(candidate.token)
  );
}

function isSupportedSecretReference(value: string): boolean {
  try {
    return value === value.trim() && parseSecretReference(value) !== null;
  } catch {
    return false;
  }
}
