import type { ProtocolSchemaBundle } from "./command-types.js";

const publicSchemaBundles = new WeakSet<object>();

export function registerPublicProtocolSchemaBundle<TBundle extends ProtocolSchemaBundle>(
  bundle: TBundle,
): TBundle {
  publicSchemaBundles.add(bundle);
  return bundle;
}

export function isPublicProtocolSchemaBundle(value: unknown): value is ProtocolSchemaBundle {
  return typeof value === "object" && value !== null && publicSchemaBundles.has(value);
}
