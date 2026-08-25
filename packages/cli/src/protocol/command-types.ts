import type { CLI_PROTOCOL_VERSION } from "@cellarer/core";
import type { JsonSchema } from "./schemas.js";

export type CommandMutability = "read" | "write" | "service";

export interface CommandInputBinding {
  readonly field: string;
  readonly option?: string;
  readonly positional?: number;
  readonly encode?: (value: unknown) => unknown;
}

export interface CommandDefinition<TCommand extends string = string> {
  readonly command: TCommand;
  readonly mutability: CommandMutability;
  readonly streaming: boolean;
  readonly requiredFeatures: readonly string[];
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  readonly eventSchemaId?: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly eventSchema?: JsonSchema;
  readonly inputBindings: readonly CommandInputBinding[];
}

export interface CommandCapability {
  readonly command: string;
  readonly mutability: CommandMutability;
  readonly streaming: boolean;
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  readonly eventSchemaId?: string;
  readonly requiredFeatures: readonly string[];
}

export interface CliCapabilities {
  readonly protocolVersions: readonly string[];
  readonly commands: readonly CommandCapability[];
}

export interface ProtocolSchemaEntry {
  readonly schemaId: string;
  readonly schema: JsonSchema;
}

export interface ProtocolSchemaBundle {
  readonly bundleVersion: 1;
  readonly protocolVersion: typeof CLI_PROTOCOL_VERSION;
  readonly schemas: readonly ProtocolSchemaEntry[];
}
