import { CLI_PROTOCOL_VERSION } from "@cellarer/core";

export interface JsonSchema {
  readonly $id?: string;
  readonly $schema?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: string | readonly string[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly minLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly allOf?: readonly JsonSchema[];
  readonly if?: JsonSchema;
  readonly then?: JsonSchema;
  readonly not?: JsonSchema;
}

export interface CommandProtocolSchemas {
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  readonly eventSchemaId?: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly eventSchema?: JsonSchema;
}

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const REQUEST_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
export const PROTECTED_DESCRIPTOR_MIN = 3;
export const PROTECTED_DESCRIPTOR_MAX = 2_147_483_647;

export const CLI_WARNING_SCHEMA: JsonSchema = {
  $id: schemaId("warning"),
  $schema: JSON_SCHEMA_DIALECT,
  title: "Cellarer CLI warning",
  type: "object",
  additionalProperties: false,
  required: ["code", "message"],
  properties: {
    code: { type: "string", minLength: 1 },
    message: { type: "string" },
    details: { type: "object", additionalProperties: true },
  },
};

export const CLI_ERROR_SCHEMA: JsonSchema = {
  $id: schemaId("error"),
  $schema: JSON_SCHEMA_DIALECT,
  title: "Cellarer CLI error",
  type: "object",
  additionalProperties: false,
  required: ["code", "message"],
  properties: {
    code: {
      enum: [
        "INVALID_USAGE",
        "INVALID_INPUT",
        "INPUT_REQUIRED",
        "INPUT_AMBIGUITY",
        "POLICY_VIOLATION",
        "DOMAIN_VALIDATION_FAILED",
        "STALE_REVISION",
        "LOCK_CONFLICT",
        "TARGET_CONFLICT",
        "EXECUTION_FAILED",
        "PARTIAL_FAILURE",
        "RECOVERY_REQUIRED",
        "INTERNAL_ERROR",
      ],
    },
    message: { type: "string" },
    details: { type: "object", additionalProperties: true },
  },
};

export const jsonSchema = {
  string: (
    options: Pick<JsonSchema, "description" | "minLength" | "pattern"> = {},
  ): JsonSchema => ({
    type: "string",
    ...options,
  }),
  boolean: (): JsonSchema => ({ type: "boolean" }),
  integer: (minimum = 0, maximum?: number): JsonSchema => ({
    type: "integer",
    minimum,
    ...(maximum === undefined ? {} : { maximum }),
  }),
  enumeration: (values: readonly string[]): JsonSchema => ({ enum: values }),
  array: (items: JsonSchema): JsonSchema => ({ type: "array", items }),
  object: (
    properties: Readonly<Record<string, JsonSchema>> = {},
    required: readonly string[] = [],
    additionalProperties: boolean | JsonSchema = false,
  ): JsonSchema => ({
    type: "object",
    additionalProperties,
    ...(required.length > 0 ? { required } : {}),
    properties,
  }),
};

export function createCommandProtocolSchemas(
  command: string,
  inputDataSchema: JsonSchema,
  outputDataSchema: JsonSchema,
  eventDataSchema?: JsonSchema,
): CommandProtocolSchemas {
  const inputSchemaId = commandSchemaId(command, "input");
  const outputSchemaId = commandSchemaId(command, "output");
  const eventSchemaId = eventDataSchema ? commandSchemaId(command, "event") : undefined;
  return {
    inputSchemaId,
    outputSchemaId,
    ...(eventSchemaId ? { eventSchemaId } : {}),
    inputSchema: commandRequestSchema(command, inputSchemaId, inputDataSchema),
    outputSchema: commandResultSchema(command, outputSchemaId, outputDataSchema),
    ...(eventDataSchema && eventSchemaId
      ? { eventSchema: commandEventSchema(command, eventSchemaId, eventDataSchema) }
      : {}),
  };
}

function commandRequestSchema(
  command: string,
  id: string,
  inputDataSchema: JsonSchema,
): JsonSchema {
  return {
    $id: id,
    $schema: JSON_SCHEMA_DIALECT,
    title: `cellarer ${command} request`,
    type: "object",
    additionalProperties: false,
    required: ["protocolVersion", "command", "input"],
    properties: {
      protocolVersion: { const: CLI_PROTOCOL_VERSION },
      command: { const: command },
      requestId: requestIdSchema(),
      input: inputDataSchema,
    },
  };
}

function commandResultSchema(
  command: string,
  id: string,
  outputDataSchema: JsonSchema,
): JsonSchema {
  return {
    $id: id,
    $schema: JSON_SCHEMA_DIALECT,
    title: `cellarer ${command} terminal result`,
    type: "object",
    additionalProperties: false,
    required: ["protocolVersion", "command", "requestId", "status", "warnings"],
    properties: {
      protocolVersion: { const: CLI_PROTOCOL_VERSION },
      command: { const: command },
      requestId: requestIdSchema(),
      status: { enum: ["success", "error"] },
      data: outputDataSchema,
      warnings: { type: "array", items: withoutSchemaIdentity(CLI_WARNING_SCHEMA) },
      error: withoutSchemaIdentity(CLI_ERROR_SCHEMA),
    },
    allOf: [
      {
        if: { properties: { status: { const: "success" } }, required: ["status"] },
        // biome-ignore lint/suspicious/noThenProperty: `then` is a JSON Schema keyword here.
        then: { required: ["data"], not: { required: ["error"] } },
      },
      {
        if: { properties: { status: { const: "error" } }, required: ["status"] },
        // biome-ignore lint/suspicious/noThenProperty: `then` is a JSON Schema keyword here.
        then: { required: ["error"] },
      },
    ],
  };
}

function commandEventSchema(command: string, id: string, eventDataSchema: JsonSchema): JsonSchema {
  return {
    $id: id,
    $schema: JSON_SCHEMA_DIALECT,
    title: `cellarer ${command} event`,
    type: "object",
    additionalProperties: false,
    required: ["protocolVersion", "command", "requestId", "sequence", "event"],
    properties: {
      protocolVersion: { const: CLI_PROTOCOL_VERSION },
      command: { const: command },
      requestId: requestIdSchema(),
      sequence: { type: "integer", minimum: 1 },
      event: jsonSchema.object(
        {
          code: { type: "string", minLength: 1 },
          data: eventDataSchema,
        },
        ["code", "data"],
      ),
    },
  };
}

function requestIdSchema(): JsonSchema {
  return { type: "string", pattern: REQUEST_ID_PATTERN };
}

function commandSchemaId(command: string, kind: "input" | "output" | "event"): string {
  return schemaId(`command:${command}:${kind}`);
}

function schemaId(name: string): string {
  return `urn:cellarer:cli:protocol:${CLI_PROTOCOL_VERSION}:${name}`;
}

function withoutSchemaIdentity(schema: JsonSchema): JsonSchema {
  const { $id: _id, $schema: _dialect, ...embedded } = schema;
  return embedded;
}
