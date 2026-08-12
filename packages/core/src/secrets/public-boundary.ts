import type { Env } from "../env.js";
import { createProviderScope, withProviderScope } from "./active-values.js";
import { isSensitiveSecretFieldName } from "./detector.js";
import {
  attachObservableKnownValues,
  createSecretValue,
  type ObservableBoundary,
  observableKnownValues,
  redactObservableText,
  registerObservableOpenApiDocument,
  type SecretValue,
  serializeObservable,
} from "./observable.js";
import { inventoryActiveSecretValues } from "./provider-runtime.js";

const OPEN_API_ROOT_KEYS = new Set([
  "openapi",
  "info",
  "jsonSchemaDialect",
  "paths",
  "components",
  "x-cellarer-authentication-modes",
  "x-cellarer-active-authentication-mode",
  "x-cellarer-browser-session-policy",
]);

const JSON_SCHEMA_KEYS = new Set([
  "$id",
  "$ref",
  "$schema",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "properties",
  "propertyNames",
  "required",
  "items",
  "additionalProperties",
  "minLength",
  "minProperties",
  "minimum",
  "maximum",
  "pattern",
  "oneOf",
  "anyOf",
  "allOf",
  "if",
  "then",
  "not",
]);

/**
 * Creates the only public JSON-document exception accepted by observable serialization.
 * The caller never gets its input object marked: a plain-data snapshot is validated and frozen,
 * and only that new identity is registered. Sensitive names remain legal solely as JSON Schema
 * property names; they cannot carry const/enum data at that property node.
 */
export function createSafeObservableOpenApiDocument(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const snapshot = snapshotJsonValue(value);
  if (!isPlainRecord(snapshot)) throw new TypeError("OpenAPI document must be a plain object");
  validateOpenApiDocument(snapshot);
  return registerObservableOpenApiDocument(deepFreeze(snapshot));
}

/** Creates an opaque source that only contributes known plaintexts to observable redaction. */
export function createSafeObservableKnownValueSource(values: readonly string[]): object {
  const source = attachObservableKnownValues(
    {},
    values.filter((value) => value.length > 0).map((value) => createSecretValue(value)),
  );
  return Object.freeze(source);
}

export interface SafeObservableOptions {
  readonly pretty?: boolean | number;
  readonly knownValueSources?: readonly unknown[];
}

export function serializeSafeObservable(
  boundary: ObservableBoundary,
  value: unknown,
  options: SafeObservableOptions = {},
): string {
  return serializeObservable(boundary, value, {
    pretty: options.pretty,
    knownValues: knownValuesFrom([value, ...(options.knownValueSources ?? [])]),
  });
}

export function redactSafeObservableText(
  value: unknown,
  text: string,
  knownValueSources: readonly unknown[] = [],
): string {
  return redactObservableText(text, {
    knownValues: knownValuesFrom([value, ...knownValueSources]),
  });
}

export async function serializeSafeWebObservable(
  env: Env,
  storeRoot: string,
  value: unknown,
  options: SafeObservableOptions = {},
): Promise<string> {
  const scope = createProviderScope({ secretMode: "env" });
  const operationEnv = withProviderScope(env, scope);
  await inventoryActiveSecretValues(operationEnv, storeRoot, {
    secretMode: "env",
    requireAvailable: true,
  });
  return serializeObservable("web", value, {
    pretty: options.pretty,
    knownValues: [
      ...knownValuesFrom([value, ...(options.knownValueSources ?? [])]),
      ...scope.knownValues,
    ],
  });
}

function knownValuesFrom(sources: readonly unknown[]): SecretValue[] {
  const values: SecretValue[] = [];
  const seen = new Set<SecretValue>();
  for (const source of sources) {
    for (const value of observableKnownValues(source)) {
      if (seen.has(value)) continue;
      seen.add(value);
      values.push(value);
    }
  }
  return values;
}

function snapshotJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== "object") throw new TypeError("OpenAPI document must contain JSON data");
  if (seen.has(value)) throw new TypeError("OpenAPI document cannot contain circular values");
  seen.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw new TypeError("OpenAPI arrays must be plain arrays");
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index) || !(descriptors[key]?.enumerable ?? false))
      ) {
        throw new TypeError("OpenAPI arrays must be dense enumerable JSON arrays");
      }
      return keys.map((key) => {
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError("OpenAPI arrays cannot contain accessors");
        }
        return snapshotJsonValue(descriptor.value, seen);
      });
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("OpenAPI objects must use a plain prototype");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("OpenAPI objects cannot contain symbol keys");
    }
    const snapshot: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("OpenAPI objects must contain enumerable data properties only");
      }
      snapshot[key] = snapshotJsonValue(descriptor.value, seen);
    }
    return snapshot;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("OpenAPI document could not be inspected safely", { cause: error });
  } finally {
    seen.delete(value);
  }
}

function validateOpenApiDocument(document: Record<string, unknown>): void {
  for (const key of Object.keys(document)) {
    if (!OPEN_API_ROOT_KEYS.has(key)) throw new TypeError(`Unsupported OpenAPI root field: ${key}`);
  }
  if (document.openapi !== "3.1.0") throw new TypeError("OpenAPI version must be 3.1.0");
  if (!isPlainRecord(document.info) || !isPlainRecord(document.paths)) {
    throw new TypeError("OpenAPI info and paths must be objects");
  }
  if (!isPlainRecord(document.components))
    throw new TypeError("OpenAPI components must be an object");
  validateOrdinaryOpenApiValue(document.info, ["info"]);
  validateOrdinaryOpenApiValue(document.paths, ["paths"]);
  validateOrdinaryOpenApiValue(document.components, ["components"]);
  for (const [key, value] of Object.entries(document)) {
    if (key === "info" || key === "paths" || key === "components") continue;
    validateOrdinaryOpenApiValue(value, [key]);
  }
}

function validateOrdinaryOpenApiValue(value: unknown, path: readonly string[]): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      validateOrdinaryOpenApiValue(child, [...path, String(index)]);
    });
    return;
  }
  if (!isPlainRecord(value)) throw new TypeError("OpenAPI values must be plain JSON objects");
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveSecretFieldName(key)) {
      throw new TypeError(`Sensitive data field is not allowed in OpenAPI metadata: ${key}`);
    }
    if (
      key === "schema" ||
      key === "x-cellarer-input-schema" ||
      key === "x-cellarer-output-schema"
    ) {
      validateJsonSchema(child, false);
      continue;
    }
    if (key === "schemas" && path.length === 1 && path[0] === "components") {
      if (!isPlainRecord(child)) throw new TypeError("OpenAPI component schemas must be an object");
      for (const schema of Object.values(child)) validateJsonSchema(schema, false);
      continue;
    }
    validateOrdinaryOpenApiValue(child, [...path, key]);
  }
}

function validateJsonSchema(value: unknown, sensitiveProperty: boolean): void {
  if (!isPlainRecord(value)) throw new TypeError("JSON Schema nodes must be plain objects");
  for (const key of Object.keys(value)) {
    if (!JSON_SCHEMA_KEYS.has(key)) throw new TypeError(`Unsupported JSON Schema field: ${key}`);
  }
  if (sensitiveProperty && ("const" in value || "enum" in value)) {
    throw new TypeError("Sensitive JSON Schema properties cannot carry const or enum data");
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "properties") {
      if (!isPlainRecord(child)) throw new TypeError("JSON Schema properties must be an object");
      for (const [propertyName, propertySchema] of Object.entries(child)) {
        validateJsonSchema(propertySchema, isSensitiveSecretFieldName(propertyName));
      }
    } else if (
      key === "items" ||
      key === "propertyNames" ||
      key === "if" ||
      key === "then" ||
      key === "not"
    ) {
      validateJsonSchema(child, sensitiveProperty);
    } else if (key === "additionalProperties" && typeof child !== "boolean") {
      validateJsonSchema(child, sensitiveProperty);
    } else if (key === "oneOf" || key === "anyOf" || key === "allOf") {
      if (!Array.isArray(child)) throw new TypeError(`${key} must be an array`);
      child.forEach((schema) => {
        validateJsonSchema(schema, sensitiveProperty);
      });
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
