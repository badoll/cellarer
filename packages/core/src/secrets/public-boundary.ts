import type { Env } from "../env.js";
import {
  createProviderScope,
  inventoryActiveSecretValues,
  withProviderScope,
} from "./active-values.js";
import {
  type ObservableBoundary,
  observableKnownValues,
  redactObservableText,
  type SecretValue,
  serializeObservable,
} from "./observable.js";

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
