import { CLI_PROTOCOL_VERSION } from "@cellarer/core";
import type { JsonSchema } from "./schemas.js";
import {
  CLI_ERROR_SCHEMA,
  CLI_WARNING_SCHEMA,
  createCommandProtocolSchemas,
  jsonSchema,
  PROTECTED_DESCRIPTOR_MAX,
  PROTECTED_DESCRIPTOR_MIN,
} from "./schemas.js";

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

const stringArray = jsonSchema.array(jsonSchema.string({ minLength: 1 }));
const capabilityArray = jsonSchema.array(jsonSchema.enumeration(["rules", "mcp", "skills"]));
const secretMode = jsonSchema.enumeration(["env", "vault", "keychain"]);
const provider = jsonSchema.enumeration(["vault", "keychain"]);
const openObject = (
  required: readonly string[] = [],
  properties: Record<string, JsonSchema> = {},
) => jsonSchema.object(properties, required, true);
const dataObject = (
  required: readonly string[] = [],
  properties: Record<string, JsonSchema> = {},
) => jsonSchema.object(properties, required);
const openArray = jsonSchema.array(openObject());
const artifactArray = jsonSchema.array(
  dataObject(["id", "kind", "collections"], {
    id: jsonSchema.string({ minLength: 1 }),
    kind: jsonSchema.enumeration(["rules", "mcp", "skills"]),
    collections: stringArray,
  }),
);
const progressEvent = openObject([], {
  phase: jsonSchema.string({ minLength: 1 }),
  current: jsonSchema.integer(),
  total: jsonSchema.integer(),
});
const commandCapability = jsonSchema.object(
  {
    command: jsonSchema.string({ minLength: 1 }),
    mutability: jsonSchema.enumeration(["read", "write", "service"]),
    streaming: jsonSchema.boolean(),
    inputSchemaId: jsonSchema.string({ minLength: 1 }),
    outputSchemaId: jsonSchema.string({ minLength: 1 }),
    eventSchemaId: jsonSchema.string({ minLength: 1 }),
    requiredFeatures: stringArray,
  },
  ["command", "mutability", "streaming", "inputSchemaId", "outputSchemaId", "requiredFeatures"],
);
const protocolSchemaEntry = jsonSchema.object(
  {
    schemaId: jsonSchema.string({ minLength: 1 }),
    schema: openObject(),
  },
  ["schemaId", "schema"],
);

export const commandRegistry = [
  defineCommand({
    command: "init",
    mutability: "write",
    input: jsonSchema.object({ global: jsonSchema.boolean() }),
    bindings: [option("global")],
    output: dataObject(["storeRoot", "createdConfig", "operation"], {
      storeRoot: jsonSchema.string(),
      createdConfig: jsonSchema.boolean(),
      operation: openObject(),
    }),
  }),
  defineCommand({
    command: "add",
    mutability: "write",
    requiredFeatures: ["mutation-authority"],
    input: jsonSchema.object(
      {
        source: jsonSchema.string({ minLength: 1 }),
        force: jsonSchema.boolean(),
        list: jsonSchema.boolean(),
        skills: stringArray,
        all: jsonSchema.boolean(),
        collection: jsonSchema.string({ minLength: 1 }),
        yes: jsonSchema.boolean(),
        secretMode,
        vaultPassphraseFd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
        keychainService: jsonSchema.string({ minLength: 1 }),
      },
      ["source"],
    ),
    bindings: [
      positional("source", 0),
      option("force"),
      option("list"),
      option("skills", "skill"),
      option("all"),
      option("collection"),
      option("yes"),
      option("secretMode"),
      option("vaultPassphraseFd", undefined, stringify),
      option("keychainService"),
    ],
    output: dataObject(["imported", "skipped", "rejected", "candidates"], {
      imported: openArray,
      skipped: openArray,
      rejected: openArray,
      candidates: openArray,
      operation: openObject(),
    }),
  }),
  defineCommand({
    command: "agents",
    mutability: "read",
    input: scopeInput(),
    bindings: scopeBindings(),
    output: dataObject(["storeRoot", "scope", "agents"], {
      storeRoot: jsonSchema.string(),
      scope: jsonSchema.enumeration(["global", "project"]),
      dir: jsonSchema.string({ minLength: 1 }),
      agents: openArray,
    }),
  }),
  defineCommand({
    command: "ls",
    mutability: "read",
    input: jsonSchema.object({ collection: jsonSchema.string({ minLength: 1 }) }),
    bindings: [option("collection")],
    output: dataObject(["artifacts", "storeEmpty"], {
      artifacts: artifactArray,
      storeEmpty: jsonSchema.boolean(),
    }),
  }),
  defineCommand({
    command: "apply",
    mutability: "write",
    streaming: true,
    requiredFeatures: ["mutation-authority", "plan-apply", "protected-secret-channel"],
    input: jsonSchema.object(
      {
        agents: stringArray,
        dir: jsonSchema.string({ minLength: 1 }),
        collection: jsonSchema.string({ minLength: 1 }),
        capabilities: capabilityArray,
        copy: jsonSchema.boolean(),
        mcpOverwrite: jsonSchema.boolean(),
        secretMode,
        vaultPassphraseFd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
        keychainService: jsonSchema.string({ minLength: 1 }),
        replaceUnowned: stringArray,
        overrideDrift: stringArray,
        snapshotPassphraseFd: jsonSchema.integer(
          PROTECTED_DESCRIPTOR_MIN,
          PROTECTED_DESCRIPTOR_MAX,
        ),
        dryRun: jsonSchema.boolean(),
      },
      ["agents"],
    ),
    bindings: [
      option("agents", "agent", joinList),
      option("dir"),
      option("collection"),
      ...capabilityBindings(),
      option("copy"),
      option("mcpOverwrite"),
      option("secretMode"),
      option("vaultPassphraseFd", undefined, stringify),
      option("keychainService"),
      option("replaceUnowned", undefined, joinList),
      option("overrideDrift", undefined, joinList),
      option("snapshotPassphraseFd", undefined, stringify),
      option("dryRun"),
    ],
    output: dataObject(["plan", "entries", "failures", "mutation"], {
      plan: openObject(),
      entries: openArray,
      failures: openArray,
      mutation: openObject(),
    }),
    event: progressEvent,
  }),
  defineCommand({
    command: "authority.rotate",
    mutability: "write",
    requiredFeatures: ["mutation-authority"],
    input: jsonSchema.object(),
    bindings: [],
    output: dataObject(["operation"], { operation: openObject() }),
  }),
  defineCommand({
    command: "scan",
    mutability: "write",
    streaming: true,
    requiredFeatures: ["mutation-authority", "protected-secret-channel"],
    input: jsonSchema.object(
      {
        agent: jsonSchema.string({ minLength: 1 }),
        dir: jsonSchema.string({ minLength: 1 }),
        capabilities: capabilityArray,
        intoCollection: jsonSchema.string({ minLength: 1 }),
        conflict: jsonSchema.enumeration(["keep-theirs", "keep-mine", "copy"]),
        select: stringArray,
        dryRun: jsonSchema.boolean(),
        secretMode,
        vaultPassphraseFd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
        keychainService: jsonSchema.string({ minLength: 1 }),
      },
      ["agent"],
    ),
    bindings: [
      option("agent"),
      option("dir"),
      ...capabilityBindings(),
      option("intoCollection"),
      option("conflict"),
      option("select", undefined, joinList),
      option("dryRun"),
      option("secretMode"),
      option("vaultPassphraseFd", undefined, stringify),
      option("keychainService"),
    ],
    output: dataObject(["plan", "imported"], {
      plan: openObject(),
      imported: openArray,
      operation: openObject(),
    }),
    event: progressEvent,
  }),
  defineCommand({
    command: "revert",
    mutability: "write",
    streaming: true,
    requiredFeatures: ["mutation-authority", "plan-apply"],
    input: jsonSchema.object({
      agents: stringArray,
      dir: jsonSchema.string({ minLength: 1 }),
      all: jsonSchema.boolean(),
      keepBackups: jsonSchema.boolean(),
      acknowledgements: stringArray,
      snapshotPassphraseFd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
      dryRun: jsonSchema.boolean(),
    }),
    bindings: [
      option("agents", "agent", joinList),
      option("dir"),
      option("all"),
      option("keepBackups"),
      option("acknowledgements", "acknowledge", joinList),
      option("snapshotPassphraseFd", undefined, stringify),
      option("dryRun"),
    ],
    output: dataObject(["plan", "reverted", "failures", "mutation", "warnings"], {
      plan: openObject(),
      reverted: openArray,
      failures: openArray,
      mutation: openObject(),
      warnings: stringArray,
    }),
    event: progressEvent,
  }),
  defineCommand({
    command: "status",
    mutability: "read",
    input: scopeInput(),
    bindings: scopeBindings(),
    output: dataObject(["items"], {
      items: openArray,
      verification: openObject(),
    }),
  }),
  defineCommand({
    command: "secret.add",
    mutability: "write",
    requiredFeatures: ["protected-secret-channel"],
    input: jsonSchema.object(
      {
        name: jsonSchema.string({ minLength: 1 }),
        provider,
        stdin: jsonSchema.boolean(),
        fd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
        passphraseFd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
      },
      ["name"],
    ),
    bindings: [
      positional("name", 0),
      option("provider"),
      option("stdin"),
      option("fd", undefined, stringify),
      option("passphraseFd", undefined, stringify),
    ],
    output: secretMutationOutput(),
  }),
  defineCommand({
    command: "secret.ls",
    mutability: "read",
    requiredFeatures: ["protected-secret-channel"],
    input: jsonSchema.object({
      passphraseFd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
    }),
    bindings: [option("passphraseFd", undefined, stringify)],
    output: dataObject(["names"], { names: stringArray }),
  }),
  defineCommand({
    command: "secret.rm",
    mutability: "write",
    requiredFeatures: ["protected-secret-channel"],
    input: jsonSchema.object(
      {
        name: jsonSchema.string({ minLength: 1 }),
        provider,
        passphraseFd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
      },
      ["name"],
    ),
    bindings: [
      positional("name", 0),
      option("provider"),
      option("passphraseFd", undefined, stringify),
    ],
    output: secretMutationOutput(),
  }),
  defineCommand({
    command: "doctor",
    mutability: "read",
    input: scopeInput(),
    bindings: scopeBindings(),
    output: dataObject(["storeRoot", "scope", "checks", "agents", "mutationRecovery"], {
      storeRoot: jsonSchema.string(),
      scope: jsonSchema.enumeration(["global", "project"]),
      dir: jsonSchema.string({ minLength: 1 }),
      defaultMethod: jsonSchema.enumeration(["symlink", "copy"]),
      checks: openArray,
      agents: openArray,
      mutationRecovery: openObject(),
    }),
  }),
  defineCommand({
    command: "ui",
    mutability: "service",
    requiredFeatures: ["long-running-process", "protected-secret-channel"],
    input: jsonSchema.object({
      port: jsonSchema.integer(1, 65_535),
      tokenFd: jsonSchema.integer(PROTECTED_DESCRIPTOR_MIN, PROTECTED_DESCRIPTOR_MAX),
    }),
    bindings: [option("port", undefined, stringify), option("tokenFd", undefined, stringify)],
    output: dataObject(["url", "port"], {
      url: jsonSchema.string(),
      port: jsonSchema.integer(1, 65_535),
    }),
  }),
  defineCommand({
    command: "capabilities",
    mutability: "read",
    input: jsonSchema.object(),
    bindings: [],
    output: jsonSchema.object(
      {
        protocolVersions: stringArray,
        commands: jsonSchema.array(commandCapability),
      },
      ["protocolVersions", "commands"],
    ),
  }),
  defineCommand({
    command: "schema",
    mutability: "read",
    input: jsonSchema.object({ schemaId: jsonSchema.string({ minLength: 1 }) }),
    bindings: [positional("schemaId", 0)],
    output: jsonSchema.object(
      {
        bundleVersion: { const: 1 },
        protocolVersion: { const: CLI_PROTOCOL_VERSION },
        schemas: jsonSchema.array(protocolSchemaEntry),
      },
      ["bundleVersion", "protocolVersion", "schemas"],
    ),
  }),
] as const satisfies readonly CommandDefinition[];

export type RegisteredCommand = (typeof commandRegistry)[number]["command"];

export const commandSchemas: Readonly<Record<string, JsonSchema>> = Object.fromEntries(
  commandRegistry.flatMap((definition) => [
    [definition.inputSchemaId, definition.inputSchema],
    [definition.outputSchemaId, definition.outputSchema],
    ...(definition.eventSchema && definition.eventSchemaId
      ? [[definition.eventSchemaId, definition.eventSchema] as const]
      : []),
  ]),
);

export const protocolSchemas: Readonly<Record<string, JsonSchema>> = Object.freeze({
  [requiredSchemaId(CLI_WARNING_SCHEMA)]: CLI_WARNING_SCHEMA,
  [requiredSchemaId(CLI_ERROR_SCHEMA)]: CLI_ERROR_SCHEMA,
  ...commandSchemas,
});
const canonicalProtocolSchemas: Readonly<Record<string, JsonSchema>> = Object.freeze(
  Object.fromEntries(
    Object.entries(protocolSchemas).map(([schemaId, schema]) => [
      schemaId,
      immutableJsonSnapshot(schema),
    ]),
  ),
);
const publicSchemaBundles = new WeakSet<object>();

export function getCliCapabilities(): CliCapabilities {
  return {
    protocolVersions: [CLI_PROTOCOL_VERSION],
    commands: commandRegistry.map((definition) => ({
      command: definition.command,
      mutability: definition.mutability,
      streaming: definition.streaming,
      inputSchemaId: definition.inputSchemaId,
      outputSchemaId: definition.outputSchemaId,
      ...(definition.eventSchemaId === undefined
        ? {}
        : { eventSchemaId: definition.eventSchemaId }),
      requiredFeatures: [...definition.requiredFeatures],
    })),
  };
}

export function getProtocolSchemaBundle(schemaId?: string): ProtocolSchemaBundle | undefined {
  if (schemaId !== undefined && canonicalProtocolSchemas[schemaId] === undefined) return undefined;
  const schemaIds =
    schemaId === undefined ? Object.keys(canonicalProtocolSchemas).sort() : [schemaId];
  const schemas = Object.freeze(
    schemaIds.map((id) =>
      Object.freeze({ schemaId: id, schema: canonicalProtocolSchemas[id] as JsonSchema }),
    ),
  );
  const bundle: ProtocolSchemaBundle = Object.freeze({
    bundleVersion: 1,
    protocolVersion: CLI_PROTOCOL_VERSION,
    schemas,
  });
  publicSchemaBundles.add(bundle);
  return bundle;
}

export function isPublicProtocolSchemaBundle(value: unknown): value is ProtocolSchemaBundle {
  return typeof value === "object" && value !== null && publicSchemaBundles.has(value);
}

export function getCommandDefinition(command: string): CommandDefinition | undefined {
  return commandRegistry.find((definition) => definition.command === command);
}

interface DefinitionInput<TCommand extends string> {
  readonly command: TCommand;
  readonly mutability: CommandMutability;
  readonly streaming?: boolean;
  readonly requiredFeatures?: readonly string[];
  readonly input: JsonSchema;
  readonly bindings: readonly CommandInputBinding[];
  readonly output: JsonSchema;
  readonly event?: JsonSchema;
}

function defineCommand<TCommand extends string>(
  input: DefinitionInput<TCommand>,
): CommandDefinition<TCommand> {
  const {
    input: inputSchema,
    bindings: inputBindings,
    output,
    event,
    streaming = false,
    requiredFeatures = [],
  } = input;
  if (streaming !== (event !== undefined)) {
    throw new Error(`command ${input.command} must define an event schema exactly when streaming`);
  }
  assertInputBindings(input.command, inputSchema, inputBindings);
  return {
    command: input.command,
    mutability: input.mutability,
    streaming,
    requiredFeatures,
    inputBindings,
    ...createCommandProtocolSchemas(input.command, inputSchema, output, event),
  };
}

function scopeInput(): JsonSchema {
  return jsonSchema.object({
    agents: stringArray,
    dir: jsonSchema.string({ minLength: 1 }),
  });
}

function secretMutationOutput(): JsonSchema {
  return dataObject(["provider", "name", "operation"], {
    provider,
    name: jsonSchema.string(),
    operation: openObject(),
  });
}

function joinList(value: unknown): unknown {
  return (value as readonly string[]).join(",");
}

function stringify(value: unknown): unknown {
  return String(value);
}

function option(
  field: string,
  optionName: string | undefined = field,
  encode?: (value: unknown) => unknown,
): CommandInputBinding {
  return { field, option: optionName ?? field, ...(encode ? { encode } : {}) };
}

function positional(field: string, positionalIndex: number): CommandInputBinding {
  return { field, positional: positionalIndex };
}

function scopeBindings(): readonly CommandInputBinding[] {
  return [option("agents", "agent", joinList), option("dir")];
}

function capabilityBindings(): readonly CommandInputBinding[] {
  return [
    option("capabilities", "rules"),
    option("capabilities", "mcp"),
    option("capabilities", "skills"),
  ];
}

function assertInputBindings(
  command: string,
  inputSchema: JsonSchema,
  bindings: readonly CommandInputBinding[],
): void {
  const schemaFields = Object.keys(inputSchema.properties ?? {}).sort();
  const bindingFields = [...new Set(bindings.map(({ field }) => field))].sort();
  if (schemaFields.join("\0") !== bindingFields.join("\0")) {
    throw new Error(`command ${command} input schema and bindings must expose the same fields`);
  }
}

function requiredSchemaId(schema: JsonSchema): string {
  if (schema.$id === undefined) throw new Error("public protocol schema must define $id");
  return schema.$id;
}

function immutableJsonSnapshot<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(immutableJsonSnapshot(item, seen));
    return Object.freeze(clone) as T;
  }

  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value)) {
    clone[key] = immutableJsonSnapshot(item, seen);
  }
  return Object.freeze(clone) as T;
}
