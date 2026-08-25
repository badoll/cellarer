import { getDefaultCliCommandCatalog } from "../commands/command-catalog.js";
import type { CommandDefinition } from "./command-types.js";
import type { JsonSchema } from "./schemas.js";

export type {
  CliCapabilities,
  CommandCapability,
  CommandDefinition,
  CommandInputBinding,
  CommandMutability,
  ProtocolSchemaBundle,
  ProtocolSchemaEntry,
} from "./command-types.js";

const aggregateCatalog = getDefaultCliCommandCatalog();

export type RegisteredCommand = string;

export const commandRegistry =
  aggregateCatalog.definitions as readonly CommandDefinition<RegisteredCommand>[];

const completeSchemaBundle = aggregateCatalog.getSchemaBundle();
if (!completeSchemaBundle) throw new TypeError("aggregate protocol schema bundle is unavailable");

export const protocolSchemas: Readonly<Record<string, JsonSchema>> = Object.freeze(
  Object.fromEntries(
    completeSchemaBundle.schemas.map(({ schemaId, schema }) => [schemaId, schema]),
  ),
);

const commandSchemaIds = new Set(
  commandRegistry.flatMap((definition) => [
    definition.inputSchemaId,
    definition.outputSchemaId,
    ...(definition.eventSchemaId ? [definition.eventSchemaId] : []),
  ]),
);

export const commandSchemas: Readonly<Record<string, JsonSchema>> = Object.freeze(
  Object.fromEntries(
    Object.entries(protocolSchemas).filter(([schemaId]) => commandSchemaIds.has(schemaId)),
  ),
);

export function getCliCapabilities() {
  return aggregateCatalog.getCapabilities();
}

export function getProtocolSchemaBundle(schemaId?: string) {
  return aggregateCatalog.getSchemaBundle(schemaId);
}

export function getCommandDefinition(command: string): CommandDefinition {
  return aggregateCatalog.requireDefinition(command);
}
