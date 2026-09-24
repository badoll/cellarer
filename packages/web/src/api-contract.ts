import {
  AGENT_ID_PATTERN,
  type CanonicalJsonValue,
  CLIENT_API_CONTRACT_ID,
  CLIENT_API_VERSION,
  type ClientErrorCode,
  createSafeObservableOpenApiDocument,
  NORMALIZED_STORE_RELATIVE_SOURCE_PATTERN,
} from "@cellarer/core";
import type {
  ActivityEvent,
  ControlPlaneAgentDto,
  ControlPlaneAgentListDto,
  ControlPlaneResourceDto,
  ControlPlaneResourceListDto,
  DashboardAgentReadiness,
  DashboardCoverageGroup,
  DashboardSummaryResult,
  DistributePlan,
  InventoryRefreshResult,
  InventoryStreamEvent,
  MutationPlan,
  SettingsSummary,
  StatusItem,
} from "@cellarer/core/client-api";

export type ClientApiMethod = "get" | "post" | "put" | "delete";
export type ClientApiAuthentication = "public" | "browser-bootstrap" | "authenticated" | "mutation";
export type ClientOpenApiAuthenticationMode = "bearer" | "browser-session";

export interface ClientJsonSchema {
  readonly $id?: string;
  readonly $ref?: string;
  readonly $schema?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: string | readonly string[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, ClientJsonSchema>>;
  readonly propertyNames?: ClientJsonSchema;
  readonly required?: readonly string[];
  readonly items?: ClientJsonSchema;
  readonly additionalProperties?: boolean | ClientJsonSchema;
  readonly minLength?: number;
  readonly minProperties?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly oneOf?: readonly ClientJsonSchema[];
  readonly anyOf?: readonly ClientJsonSchema[];
  readonly allOf?: readonly ClientJsonSchema[];
  readonly if?: ClientJsonSchema;
  readonly then?: ClientJsonSchema;
  readonly not?: ClientJsonSchema;
}

type ExactType<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;

type MutableSchemaContract<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? MutableSchemaContract<Item>[]
    : Value extends object
      ? { -readonly [Key in keyof Value]: MutableSchemaContract<Value[Key]> }
      : Value;

interface ClientComponentContract {
  readonly JsonValue: CanonicalJsonValue;
  readonly MutationPlan: MutationPlan;
  readonly Resource: ControlPlaneResourceDto;
  readonly Agent: ControlPlaneAgentDto;
  readonly DashboardAgent: DashboardAgentReadiness;
  readonly DashboardCoverage: DashboardCoverageGroup;
  readonly ActivityEvent: ActivityEvent;
}

type ComponentContract<Reference> = Reference extends `#/components/schemas/${infer Name}`
  ? Name extends keyof ClientComponentContract
    ? ClientComponentContract[Name]
    : unknown
  : unknown;

type SchemaProperties<Schema> = Schema extends {
  readonly properties: infer Properties extends Readonly<Record<string, ClientJsonSchema>>;
}
  ? Properties
  : Record<never, never>;

type SchemaRequiredKeys<Schema> = Schema extends {
  readonly required: readonly (infer Required)[];
}
  ? Required & keyof SchemaProperties<Schema>
  : never;

type SchemaDeclaredObject<Schema> = {
  [Key in SchemaRequiredKeys<Schema>]-?: InferClientJsonSchema<SchemaProperties<Schema>[Key]>;
} & {
  [Key in Exclude<
    keyof SchemaProperties<Schema>,
    SchemaRequiredKeys<Schema>
  >]?: InferClientJsonSchema<SchemaProperties<Schema>[Key]>;
};

type SchemaAdditionalObject<Schema> = Schema extends {
  readonly additionalProperties: infer Additional;
}
  ? Additional extends false
    ? unknown
    : Additional extends ClientJsonSchema
      ? Record<string, InferClientJsonSchema<Additional>>
      : Additional extends true
        ? Record<string, unknown>
        : unknown
  : unknown;

type InferClientJsonSchema<Schema> = Schema extends { readonly $ref: infer Reference }
  ? ComponentContract<Reference>
  : Schema extends { readonly oneOf: readonly (infer Variant)[] }
    ? InferClientJsonSchema<Variant>
    : Schema extends { readonly anyOf: readonly (infer Variant)[] }
      ? InferClientJsonSchema<Variant>
      : Schema extends { readonly const: infer Constant }
        ? Constant
        : Schema extends { readonly enum: readonly (infer EnumValue)[] }
          ? EnumValue
          : Schema extends { readonly type: "string" }
            ? Schema extends { readonly pattern: "^masked$" }
              ? "masked"
              : string
            : Schema extends { readonly type: "integer" | "number" }
              ? number
              : Schema extends { readonly type: "boolean" }
                ? boolean
                : Schema extends { readonly type: "null" }
                  ? null
                  : Schema extends {
                        readonly type: readonly (infer Primitive)[];
                      }
                    ? Primitive extends "string"
                      ? string
                      : Primitive extends "number" | "integer"
                        ? number
                        : Primitive extends "boolean"
                          ? boolean
                          : Primitive extends "null"
                            ? null
                            : never
                    : Schema extends {
                          readonly type: "array";
                          readonly items: infer Items;
                        }
                      ? InferClientJsonSchema<Items>[]
                      : Schema extends { readonly type: "object" }
                        ? SchemaDeclaredObject<Schema> & SchemaAdditionalObject<Schema>
                        : unknown;

type ExactSchemaContract<Schema, Contract> = ExactType<
  MutableSchemaContract<InferClientJsonSchema<Schema>>,
  MutableSchemaContract<Contract>
>;

type AssertSchemaContract<Exact extends true> = Exact;

interface ClientApiRouteBaseDefinition {
  readonly operationId: string;
  readonly method: ClientApiMethod;
  readonly path: `/api/v1${string}`;
  readonly authentication: ClientApiAuthentication;
  readonly summary: string;
  readonly requestBody?: "none";
}

export interface ClientApiHttpStatusMapping {
  readonly status: number;
  readonly outcome: "success" | "error";
  readonly errorCodes?: readonly ClientErrorCode[];
}

export interface ClientApiRouteDefinition extends ClientApiRouteBaseDefinition {
  readonly inputSchema: ClientJsonSchema;
  readonly outputSchema: ClientJsonSchema;
  readonly httpStatusMappings: readonly ClientApiHttpStatusMapping[];
}

const CLIENT_API_ROUTE_BASES = [
  {
    operationId: "getHealth",
    method: "get",
    path: "/api/v1/health",
    authentication: "public",
    summary: "Check transport liveness",
  },
  {
    operationId: "bootstrapBrowserSession",
    method: "post",
    path: "/api/v1/auth/session",
    authentication: "browser-bootstrap",
    summary: "Bootstrap a same-origin browser session",
    requestBody: "none",
  },
  {
    operationId: "getVersion",
    method: "get",
    path: "/api/v1/version",
    authentication: "authenticated",
    summary: "Discover the local client API version",
  },
  {
    operationId: "getCapabilities",
    method: "get",
    path: "/api/v1/capabilities",
    authentication: "authenticated",
    summary: "Discover implemented local client operations",
  },
  {
    operationId: "getReadiness",
    method: "get",
    path: "/api/v1/readiness",
    authentication: "authenticated",
    summary: "Inspect operational readiness",
  },
  {
    operationId: "listResources",
    method: "get",
    path: "/api/v1/resources",
    authentication: "authenticated",
    summary: "List control-plane resources",
  },
  {
    operationId: "getOpenApi",
    method: "get",
    path: "/api/v1/openapi.json",
    authentication: "authenticated",
    summary: "Discover the implemented OpenAPI contract",
  },
  {
    operationId: "listResourcesByKind",
    method: "get",
    path: "/api/v1/resources/{kind}",
    authentication: "authenticated",
    summary: "List resources for one supported kind",
  },
  {
    operationId: "listAgents",
    method: "get",
    path: "/api/v1/agents",
    authentication: "authenticated",
    summary: "List control-plane agents",
  },
  {
    operationId: "showAgent",
    method: "get",
    path: "/api/v1/agents/{id}",
    authentication: "authenticated",
    summary: "Show one control-plane agent",
  },
  {
    operationId: "planAgentMutation",
    method: "post",
    path: "/api/v1/agents/plan",
    authentication: "mutation",
    summary: "Plan an agent or adapter mutation",
  },
  {
    operationId: "listCollections",
    method: "get",
    path: "/api/v1/collections",
    authentication: "authenticated",
    summary: "List collections",
  },
  {
    operationId: "showCollection",
    method: "get",
    path: "/api/v1/collections/{name}",
    authentication: "authenticated",
    summary: "Show one collection",
  },
  {
    operationId: "planCollectionMutation",
    method: "post",
    path: "/api/v1/collections/plan",
    authentication: "mutation",
    summary: "Plan a collection mutation",
  },
  {
    operationId: "applyControlPlaneMutation",
    method: "post",
    path: "/api/v1/mutations/apply",
    authentication: "mutation",
    summary: "Apply an exact control-plane mutation plan",
  },
  {
    operationId: "planSync",
    method: "post",
    path: "/api/v1/sync/plan",
    authentication: "mutation",
    summary: "Plan an exact multi-agent sync",
  },
  {
    operationId: "applySync",
    method: "post",
    path: "/api/v1/sync/apply",
    authentication: "mutation",
    summary: "Apply an exact multi-agent sync plan",
  },
  {
    operationId: "listProfiles",
    method: "get",
    path: "/api/v1/profiles",
    authentication: "authenticated",
    summary: "List sync profiles",
  },
  {
    operationId: "showProfile",
    method: "get",
    path: "/api/v1/profiles/{id}",
    authentication: "authenticated",
    summary: "Show one sync profile",
  },
  {
    operationId: "planProfileMutation",
    method: "post",
    path: "/api/v1/profiles/plan",
    authentication: "mutation",
    summary: "Plan a sync-profile definition mutation",
  },
  {
    operationId: "applyProfileMutation",
    method: "post",
    path: "/api/v1/profiles/apply",
    authentication: "mutation",
    summary: "Apply an exact sync-profile definition plan",
  },
  {
    operationId: "showConfig",
    method: "get",
    path: "/api/v1/config",
    authentication: "authenticated",
    summary: "Show public effective configuration",
  },
  {
    operationId: "getSettings",
    method: "get",
    path: "/api/v1/settings",
    authentication: "authenticated",
    summary: "Show bundled console settings",
  },
  {
    operationId: "planSettingsMutation",
    method: "post",
    path: "/api/v1/settings/plan",
    authentication: "mutation",
    summary: "Plan a settings mutation",
  },
  {
    operationId: "validateConfig",
    method: "post",
    path: "/api/v1/config/validate",
    authentication: "authenticated",
    summary: "Validate configuration without mutation",
  },
  {
    operationId: "refreshInventory",
    method: "get",
    path: "/api/v1/inventory",
    authentication: "authenticated",
    summary: "Refresh all bounded registered Inventory sources",
  },
  {
    operationId: "streamInventory",
    method: "get",
    path: "/api/v1/inventory/stream",
    authentication: "authenticated",
    summary: "Stream bounded Inventory progress and the authoritative result as NDJSON",
  },
  {
    operationId: "refreshInventoryByAgent",
    method: "get",
    path: "/api/v1/inventory/{agentId}",
    authentication: "authenticated",
    summary: "Refresh one registered adapter's bounded Inventory sources",
  },
  {
    operationId: "planInventoryStoreImport",
    method: "post",
    path: "/api/v1/inventory/import/plan",
    authentication: "mutation",
    summary: "Plan an exact Inventory candidate batch for Store import",
  },
  {
    operationId: "applyInventoryStoreImport",
    method: "post",
    path: "/api/v1/inventory/import/apply",
    authentication: "mutation",
    summary: "Apply an unchanged Inventory Store import receipt",
  },
  {
    operationId: "planInventorySecretAdoption",
    method: "post",
    path: "/api/v1/inventory/adoption/plan",
    authentication: "mutation",
    summary: "Plan exact reference-only adoption for one supported Inventory secret field",
  },
  {
    operationId: "applyInventorySecretAdoption",
    method: "post",
    path: "/api/v1/inventory/adoption/apply",
    authentication: "mutation",
    summary: "Apply an unchanged confirmed Inventory secret-adoption plan",
  },
  {
    operationId: "getDiff",
    method: "post",
    path: "/api/v1/diff",
    authentication: "authenticated",
    summary: "Compare desired and applied state",
  },
  {
    operationId: "getStatus",
    method: "get",
    path: "/api/v1/status",
    authentication: "authenticated",
    summary: "Inspect applied target status",
  },
  {
    operationId: "getVerification",
    method: "post",
    path: "/api/v1/verify",
    authentication: "authenticated",
    summary: "Verify desired, applied, disk, and recovery state",
  },
  {
    operationId: "getSummary",
    method: "get",
    path: "/api/v1/summary",
    authentication: "authenticated",
    summary: "Get dashboard summary",
  },
  {
    operationId: "listActivity",
    method: "get",
    path: "/api/v1/activity",
    authentication: "authenticated",
    summary: "List local activity",
  },
  {
    operationId: "listOperations",
    method: "get",
    path: "/api/v1/operations",
    authentication: "authenticated",
    summary: "List operation receipts",
  },
  {
    operationId: "showOperation",
    method: "get",
    path: "/api/v1/operations/{id}",
    authentication: "authenticated",
    summary: "Show one operation receipt",
  },
  {
    operationId: "planRevertMutation",
    method: "post",
    path: "/api/v1/revert/plan",
    authentication: "mutation",
    summary: "Plan an exact ownership-aware revert",
  },
  {
    operationId: "applyRevertMutation",
    method: "post",
    path: "/api/v1/revert/apply",
    authentication: "mutation",
    summary: "Apply an exact revert plan",
  },
  {
    operationId: "getMutationRecovery",
    method: "get",
    path: "/api/v1/recovery",
    authentication: "authenticated",
    summary: "Diagnose durable mutation recovery state",
  },
  {
    operationId: "applyMutationRecovery",
    method: "post",
    path: "/api/v1/recovery/apply",
    authentication: "mutation",
    summary: "Recover one exact durable operation",
  },
  {
    operationId: "getResourceDependencies",
    method: "post",
    path: "/api/v1/resources/dependencies",
    authentication: "authenticated",
    summary: "Inspect exact resource dependencies",
  },
  {
    operationId: "checkResourceUpdate",
    method: "post",
    path: "/api/v1/resources/update/check",
    authentication: "authenticated",
    summary: "Check a resource source for an update",
  },
  {
    operationId: "planResourceUpdate",
    method: "post",
    path: "/api/v1/resources/update/plan",
    authentication: "mutation",
    summary: "Plan an exact staged resource update",
  },
  {
    operationId: "applyResourceUpdate",
    method: "post",
    path: "/api/v1/resources/update/apply",
    authentication: "mutation",
    summary: "Apply an exact staged resource update plan",
  },
  {
    operationId: "planResourceRename",
    method: "post",
    path: "/api/v1/resources/rename/plan",
    authentication: "mutation",
    summary: "Plan an exact resource rename or local fork",
  },
  {
    operationId: "applyResourceRename",
    method: "post",
    path: "/api/v1/resources/rename/apply",
    authentication: "mutation",
    summary: "Apply an exact resource rename plan",
  },
  {
    operationId: "planResourceRemove",
    method: "post",
    path: "/api/v1/resources/remove/plan",
    authentication: "mutation",
    summary: "Plan an exact resource removal",
  },
  {
    operationId: "applyResourceRemove",
    method: "post",
    path: "/api/v1/resources/remove/apply",
    authentication: "mutation",
    summary: "Apply an exact resource removal plan",
  },
  {
    operationId: "planResourceExport",
    method: "post",
    path: "/api/v1/resources/export/plan",
    authentication: "mutation",
    summary: "Plan an exact resource bundle export",
  },
  {
    operationId: "applyResourceExport",
    method: "post",
    path: "/api/v1/resources/export/apply",
    authentication: "mutation",
    summary: "Apply an exact resource bundle export plan",
  },
  {
    operationId: "validateResourceBundle",
    method: "post",
    path: "/api/v1/resources/bundle/validate",
    authentication: "authenticated",
    summary: "Validate a resource bundle",
  },
  {
    operationId: "planResourceBundleImport",
    method: "post",
    path: "/api/v1/resources/bundle-import/plan",
    authentication: "mutation",
    summary: "Plan an exact resource bundle import",
  },
  {
    operationId: "applyResourceBundleImport",
    method: "post",
    path: "/api/v1/resources/bundle-import/apply",
    authentication: "mutation",
    summary: "Apply an exact resource bundle import plan",
  },
  {
    operationId: "planSyncProfileInvocation",
    method: "post",
    path: "/api/v1/profiles/{id}/sync/plan",
    authentication: "mutation",
    summary: "Plan an exact sync-profile invocation",
  },
  {
    operationId: "applySyncProfileInvocation",
    method: "post",
    path: "/api/v1/profiles/{id}/sync/apply",
    authentication: "mutation",
    summary: "Apply an exact sync-profile invocation plan",
  },
  {
    operationId: "verifySyncProfileInvocation",
    method: "post",
    path: "/api/v1/profiles/{id}/verify",
    authentication: "authenticated",
    summary: "Verify a sync-profile invocation",
  },
  {
    operationId: "planSyncProfileUninstall",
    method: "post",
    path: "/api/v1/profiles/{id}/uninstall/plan",
    authentication: "mutation",
    summary: "Plan an exact sync-profile uninstall",
  },
  {
    operationId: "applySyncProfileUninstall",
    method: "post",
    path: "/api/v1/profiles/{id}/uninstall/apply",
    authentication: "mutation",
    summary: "Apply an exact sync-profile uninstall plan",
  },
  {
    operationId: "planDeploymentBaseline",
    method: "post",
    path: "/api/v1/deployments/baseline/plan",
    authentication: "mutation",
    summary: "Review exact local MCP attribution without target writes",
  },
  {
    operationId: "applyDeploymentBaseline",
    method: "post",
    path: "/api/v1/deployments/baseline/apply",
    authentication: "mutation",
    summary: "Apply reviewed Store-only MCP attribution",
  },
] as const satisfies readonly ClientApiRouteBaseDefinition[];

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const REQUEST_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const CLIENT_ERROR_CODES = [
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
] as const satisfies readonly ClientErrorCode[];

type StringSchemaOptions = Pick<ClientJsonSchema, "minLength" | "pattern">;
type ObjectJsonSchema<
  Properties extends Readonly<Record<string, ClientJsonSchema>>,
  Required extends readonly (keyof Properties & string)[],
  Additional extends boolean | ClientJsonSchema,
> = {
  readonly type: "object";
  readonly additionalProperties: Additional;
  readonly properties: Properties;
} & (Required extends readonly [] ? unknown : { readonly required: Required });

function stringSchema(): { readonly type: "string" };
function stringSchema<const Options extends StringSchemaOptions>(
  options: Options,
): { readonly type: "string" } & Options;
function stringSchema(options: StringSchemaOptions = {}) {
  return { type: "string", ...options } as const satisfies ClientJsonSchema;
}
const booleanSchema = { type: "boolean" } as const satisfies ClientJsonSchema;
const integerSchema = (minimum = 0) =>
  ({ type: "integer", minimum }) as const satisfies ClientJsonSchema;
const enumSchema = <const Values extends readonly string[]>(values: Values) =>
  ({ enum: values }) as const satisfies ClientJsonSchema;
const arraySchema = <const Items extends ClientJsonSchema>(items: Items) =>
  ({ type: "array", items }) as const satisfies ClientJsonSchema;
function objectSchema(): ObjectJsonSchema<Readonly<Record<never, never>>, readonly [], false>;
function objectSchema<const Properties extends Readonly<Record<string, ClientJsonSchema>>>(
  properties: Properties,
): ObjectJsonSchema<Properties, readonly [], false>;
function objectSchema<
  const Properties extends Readonly<Record<string, ClientJsonSchema>>,
  const Required extends readonly (keyof Properties & string)[],
  const Additional extends boolean | ClientJsonSchema = false,
>(
  properties: Properties,
  required: Required,
  additionalProperties?: Additional,
): ObjectJsonSchema<Properties, Required, Additional>;
function objectSchema(
  properties: Readonly<Record<string, ClientJsonSchema>>,
  required: readonly string[],
  additionalProperties?: boolean | ClientJsonSchema,
): ClientJsonSchema;
function objectSchema(
  properties: Readonly<Record<string, ClientJsonSchema>> = {},
  required: readonly string[] = [],
  additionalProperties: boolean | ClientJsonSchema = false,
): ClientJsonSchema {
  return {
    type: "object",
    additionalProperties,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

const jsonScalarSchema = {
  type: ["string", "number", "boolean", "null"],
} as const satisfies ClientJsonSchema;
type JsonScalarTypeName = "string" | "number" | "boolean" | "null";
type ExactJsonScalarTypeList<Types extends readonly string[]> =
  ExactType<Types[number], JsonScalarTypeName> extends true ? ExactType<Types["length"], 4> : false;
export type JsonValueScalarTypesSchemaContract = AssertSchemaContract<
  ExactJsonScalarTypeList<typeof jsonScalarSchema.type>
>;

function jsonValueSchema() {
  return { $ref: "#/components/schemas/JsonValue" } as const satisfies ClientJsonSchema;
}

const jsonDetailMapSchema = objectSchema({}, [], jsonValueSchema());
const jsonValueDefinitionSchema = {
  oneOf: [
    jsonScalarSchema,
    arraySchema(jsonValueSchema()),
    objectSchema({}, [], jsonValueSchema()),
  ],
} as const satisfies ClientJsonSchema;
type JsonValueSelfReference = {
  readonly $ref: "#/components/schemas/JsonValue";
};
type InferJsonValueDefinitionVariant<Variant, RecursiveValue> = Variant extends {
  readonly type: "array";
  readonly items: JsonValueSelfReference;
}
  ? readonly RecursiveValue[]
  : Variant extends {
        readonly type: "object";
        readonly additionalProperties: JsonValueSelfReference;
      }
    ? Readonly<Record<string, RecursiveValue>>
    : InferClientJsonSchema<Variant>;
type InferJsonValueDefinition<Schema, RecursiveValue> = Schema extends {
  readonly oneOf: readonly (infer Variant)[];
}
  ? InferJsonValueDefinitionVariant<Variant, RecursiveValue>
  : never;
export type JsonValueSchemaContract = AssertSchemaContract<
  ExactType<
    InferJsonValueDefinition<typeof jsonValueDefinitionSchema, CanonicalJsonValue>,
    CanonicalJsonValue
  >
>;
const nonEmptyStringSchema = stringSchema({ minLength: 1 });
const agentIdSchema = stringSchema({ minLength: 1, pattern: AGENT_ID_PATTERN });
const stringArraySchema = arraySchema(nonEmptyStringSchema);
const capabilitySchema = enumSchema(["rules", "mcp", "skills"]);
const capabilityArraySchema = arraySchema(capabilitySchema);
const scopeSchema = enumSchema(["global", "project"]);
const destinationSchema = enumSchema(["user", "project"]);
const mutationPlanSchema = {
  $ref: "#/components/schemas/MutationPlan",
} as const satisfies ClientJsonSchema;
const mutationPlanDefinitionSchema = createMutationPlanSchema();
export type MutationPlanSchemaContract = AssertSchemaContract<
  ExactSchemaContract<typeof mutationPlanDefinitionSchema, MutationPlan>
>;
const mutationPlanBodySchema = objectSchema({ mutationPlan: mutationPlanSchema }, ["mutationPlan"]);

const warningSchema = objectSchema(
  {
    code: nonEmptyStringSchema,
    message: stringSchema(),
    details: jsonDetailMapSchema,
  },
  ["code", "message"],
);

const targetStateReceiptSchema: ClientJsonSchema = {
  oneOf: [
    objectSchema({ state: { const: "absent" } }, ["state"]),
    objectSchema(
      {
        state: { const: "present" },
        fingerprint: nonEmptyStringSchema,
        recoverySnapshot: nonEmptyStringSchema,
        recoverySnapshotDigest: nonEmptyStringSchema,
        recoverySnapshotMode: integerSchema(),
      },
      ["state", "fingerprint"],
    ),
  ],
};

const lockOwnerEvidenceSchema = objectSchema(
  {
    operationId: nonEmptyStringSchema,
    processId: integerSchema(),
    hostname: nonEmptyStringSchema,
    acquiredAt: nonEmptyStringSchema,
  },
  ["operationId", "processId", "hostname", "acquiredAt"],
);

const staleRevisionDetailsSchema = objectSchema(
  {
    coreCode: { const: "STALE_REVISION" },
    planId: nonEmptyStringSchema,
    expectedRevision: integerSchema(),
    actualRevision: integerSchema(),
    replanRequired: { const: true },
  },
  ["coreCode", "planId", "expectedRevision", "actualRevision", "replanRequired"],
);
const lockConflictDetailsSchema = objectSchema(
  { coreCode: { const: "LOCK_CONFLICT" }, owner: lockOwnerEvidenceSchema },
  ["coreCode", "owner"],
);
const targetConflictDetailsSchema = objectSchema(
  {
    coreCode: { const: "TARGET_PRECONDITION_CONFLICT" },
    planId: nonEmptyStringSchema,
    actionId: nonEmptyStringSchema,
    target: nonEmptyStringSchema,
    expected: targetStateReceiptSchema,
    actual: targetStateReceiptSchema,
    replanRequired: { const: true },
  },
  ["coreCode", "planId", "actionId", "target", "expected", "actual", "replanRequired"],
);
const partialFailureDetailsSchema = objectSchema(
  {
    coreCode: { const: "PARTIAL_FAILURE" },
    operationId: nonEmptyStringSchema,
    failedActionIds: stringArraySchema,
  },
  ["coreCode", "operationId", "failedActionIds"],
);
const recoveryRequiredDetailsSchema: ClientJsonSchema = {
  oneOf: [
    objectSchema(
      {
        coreCode: { const: "INTERRUPTED_OPERATION" },
        operationId: nonEmptyStringSchema,
        journalStatus: enumSchema([
          "prepared",
          "executing",
          "publishing-state",
          "completed",
          "recovery-required",
        ]),
      },
      ["coreCode", "operationId", "journalStatus"],
    ),
    objectSchema(
      {
        coreCode: { const: "MANUAL_RECOVERY_REQUIRED" },
        operationId: nonEmptyStringSchema,
        targets: stringArraySchema,
        guidance: stringSchema(),
      },
      ["coreCode", "operationId", "targets", "guidance"],
    ),
  ],
};
const domainConflictDetailsSchema: ClientJsonSchema = {
  oneOf: [
    objectSchema(
      {
        coreCode: { const: "EXPIRED_PLAN" },
        planId: nonEmptyStringSchema,
        expiredAt: nonEmptyStringSchema,
      },
      ["coreCode", "planId", "expiredAt"],
    ),
    objectSchema(
      {
        coreCode: { const: "INVALID_PLAN_DIGEST" },
        planId: nonEmptyStringSchema,
        expectedDigest: nonEmptyStringSchema,
        actualDigest: nonEmptyStringSchema,
      },
      ["coreCode", "planId", "expectedDigest", "actualDigest"],
    ),
    objectSchema({ coreCode: { const: "INVALID_PLAN" } }, ["coreCode"]),
    {
      ...jsonDetailMapSchema,
      not: objectSchema(
        {
          coreCode: enumSchema(["EXPIRED_PLAN", "INVALID_PLAN_DIGEST", "INVALID_PLAN"]),
        },
        ["coreCode"],
        jsonValueSchema(),
      ),
    },
  ],
};

function clientErrorVariant(
  code: ClientErrorCode,
  details?: ClientJsonSchema,
  detailsRequired = true,
): ClientJsonSchema {
  return objectSchema(
    {
      code: { const: code },
      message: stringSchema(),
      ...(details ? { details } : {}),
    },
    ["code", "message", ...(details && detailsRequired ? ["details"] : [])],
  );
}

const errorSchema: ClientJsonSchema = {
  oneOf: CLIENT_ERROR_CODES.map((code) => {
    switch (code) {
      case "INVALID_INPUT":
        return clientErrorVariant(code, objectSchema({ fields: stringArraySchema }), false);
      case "DOMAIN_VALIDATION_FAILED":
        return clientErrorVariant(code, domainConflictDetailsSchema);
      case "STALE_REVISION":
        return clientErrorVariant(code, staleRevisionDetailsSchema);
      case "LOCK_CONFLICT":
        return clientErrorVariant(code, lockConflictDetailsSchema);
      case "TARGET_CONFLICT":
        return clientErrorVariant(code, targetConflictDetailsSchema);
      case "PARTIAL_FAILURE":
        return clientErrorVariant(code, partialFailureDetailsSchema);
      case "RECOVERY_REQUIRED":
        return clientErrorVariant(code, recoveryRequiredDetailsSchema);
      default:
        return clientErrorVariant(code);
    }
  }),
};

const envelopeBaseProperties = {
  apiVersion: { const: CLIENT_API_VERSION },
  requestId: stringSchema({ pattern: REQUEST_ID_PATTERN }),
  warnings: arraySchema(warningSchema),
} as const satisfies Readonly<Record<string, ClientJsonSchema>>;

const errorEnvelopeSchema = objectSchema(
  {
    ...envelopeBaseProperties,
    status: { const: "error" },
    error: errorSchema,
  },
  ["apiVersion", "requestId", "status", "warnings", "error"],
);

function successEnvelopeSchema(dataSchema: ClientJsonSchema): ClientJsonSchema {
  return objectSchema(
    {
      ...envelopeBaseProperties,
      status: { const: "success" },
      data: dataSchema,
    },
    ["apiVersion", "requestId", "status", "warnings", "data"],
  );
}

function resultEnvelopeSchema(dataSchema: ClientJsonSchema): ClientJsonSchema {
  return { oneOf: [successEnvelopeSchema(dataSchema), errorEnvelopeSchema] };
}

const distributeBodySchema = objectSchema({
  agents: stringArraySchema,
  scope: scopeSchema,
  dir: nonEmptyStringSchema,
  collections: stringArraySchema,
  capabilities: capabilityArraySchema,
  method: enumSchema(["symlink", "copy"]),
  mcpStrategy: enumSchema(["merge", "overwrite"]),
  replaceUnowned: stringArraySchema,
  overrideDrift: stringArraySchema,
  snapshotPassphrase: nonEmptyStringSchema,
});

const syncBodySchema = objectSchema({
  agents: stringArraySchema,
  destination: destinationSchema,
  dir: nonEmptyStringSchema,
  resources: objectSchema({
    ids: { ...stringArraySchema, not: { const: [] } },
    kinds: capabilityArraySchema,
    collections: stringArraySchema,
  }),
  method: enumSchema(["symlink", "copy"]),
  mcpStrategy: enumSchema(["merge", "overwrite"]),
  replaceUnowned: stringArraySchema,
  overrideDrift: stringArraySchema,
  snapshotPassphrase: nonEmptyStringSchema,
});

const revertBodySchema = objectSchema({
  scope: scopeSchema,
  dir: nonEmptyStringSchema,
  agents: stringArraySchema,
  artifactIds: stringArraySchema,
  acknowledgements: stringArraySchema,
  snapshotPassphrase: nonEmptyStringSchema,
  keepBackups: booleanSchema,
  dryRun: booleanSchema,
});

const profileInvocationBodySchema = objectSchema({
  workspaceRoot: nonEmptyStringSchema,
  replaceUnowned: stringArraySchema,
  overrideDrift: stringArraySchema,
  snapshotPassphrase: nonEmptyStringSchema,
});

const syncProfileDesiredSchema = objectSchema(
  {
    agentIds: stringArraySchema,
    scope: scopeSchema,
    resourceIds: stringArraySchema,
    collectionIds: stringArraySchema,
    capabilities: capabilityArraySchema,
    method: enumSchema(["symlink", "copy"]),
    mergePolicy: { const: "merge" },
  },
  ["agentIds", "scope", "resourceIds", "collectionIds", "capabilities", "method", "mergePolicy"],
);

const resourceIdBodySchema = objectSchema({ resourceId: nonEmptyStringSchema }, ["resourceId"]);
const resourceBundleBodySchema = objectSchema({ bundlePath: nonEmptyStringSchema }, ["bundlePath"]);

function inputSchemaFor(route: ClientApiRouteBaseDefinition): ClientJsonSchema {
  const properties: Record<string, ClientJsonSchema> = {};
  const required: string[] = [];
  const path = pathParametersSchema(route.path);
  if ((path.required?.length ?? 0) > 0) {
    properties.path = path;
    required.push("path");
  }
  const query = querySchemaFor(route.operationId);
  if (Object.keys(query.properties ?? {}).length > 0) properties.query = query;
  if (route.method === "post" && route.requestBody !== "none") {
    properties.body = bodySchemaFor(route.operationId);
    required.push("body");
  }
  return objectSchema(properties, required);
}

function pathParametersSchema(path: string): ClientJsonSchema {
  const names = [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1] as string);
  return objectSchema(
    Object.fromEntries(
      names.map((name) => [name, name === "agentId" ? agentIdSchema : nonEmptyStringSchema]),
    ),
    names,
  );
}

function querySchemaFor(operationId: string): ClientJsonSchema {
  switch (operationId) {
    case "listResources":
    case "listResourcesByKind":
      return objectSchema({
        agents: nonEmptyStringSchema,
        collections: nonEmptyStringSchema,
        destination: destinationSchema,
        dir: nonEmptyStringSchema,
        includeDiscovered: enumSchema(["true", "false"]),
      });
    case "listAgents":
      return objectSchema({
        scope: scopeSchema,
        dir: nonEmptyStringSchema,
        agents: nonEmptyStringSchema,
      });
    case "showAgent":
      return objectSchema({ scope: scopeSchema, dir: nonEmptyStringSchema });
    case "refreshInventory":
    case "refreshInventoryByAgent":
      return objectSchema({ dir: nonEmptyStringSchema });
    case "streamInventory":
      return objectSchema({ dir: nonEmptyStringSchema, agentId: agentIdSchema });
    case "getStatus":
      return objectSchema({ scope: scopeSchema, dir: nonEmptyStringSchema });
    case "getSummary":
      return objectSchema({
        scope: scopeSchema,
        dir: nonEmptyStringSchema,
        agents: nonEmptyStringSchema,
        collections: nonEmptyStringSchema,
        capabilities: nonEmptyStringSchema,
        limit: stringSchema({ pattern: "^[0-9]+$" }),
      });
    case "listActivity":
      return objectSchema({
        limit: stringSchema({ pattern: "^[0-9]+$" }),
        actions: nonEmptyStringSchema,
        scope: scopeSchema,
        agents: nonEmptyStringSchema,
      });
    case "listOperations":
      return objectSchema({ limit: stringSchema({ pattern: "^[0-9]+$" }) });
    default:
      return objectSchema();
  }
}

function bodySchemaFor(operationId: string): ClientJsonSchema {
  switch (operationId) {
    case "planDeploymentBaseline":
      return objectSchema({ deploymentId: nonEmptyStringSchema, selectors: stringArraySchema }, [
        "deploymentId",
        "selectors",
      ]);
    case "applyDeploymentBaseline":
      return objectSchema(
        {
          deploymentId: nonEmptyStringSchema,
          selectors: stringArraySchema,
          mutationPlan: mutationPlanSchema,
        },
        ["deploymentId", "selectors", "mutationPlan"],
      );
    case "planAgentMutation":
      return {
        oneOf: [
          objectSchema(
            {
              action: { const: "set-enabled" },
              agentId: nonEmptyStringSchema,
              enabled: booleanSchema,
            },
            ["action", "agentId", "enabled"],
          ),
          objectSchema(
            {
              action: { const: "upsert-adapter" },
              agentId: nonEmptyStringSchema,
              kind: { const: "builtin" },
              adapter: adapterPatchDataSchema,
            },
            ["action", "agentId", "kind", "adapter"],
          ),
          objectSchema(
            {
              action: { const: "upsert-adapter" },
              agentId: nonEmptyStringSchema,
              kind: { const: "custom" },
              adapter: adapterBodyDataSchema,
            },
            ["action", "agentId", "kind", "adapter"],
          ),
          objectSchema({ action: { const: "remove-adapter" }, agentId: nonEmptyStringSchema }, [
            "action",
            "agentId",
          ]),
        ],
      };
    case "planCollectionMutation":
      return {
        oneOf: [
          objectSchema(
            {
              action: { const: "create" },
              collectionName: nonEmptyStringSchema,
              description: stringSchema(),
              resourceIds: stringArraySchema,
            },
            ["action", "collectionName"],
          ),
          objectSchema(
            {
              action: { const: "update" },
              collectionName: nonEmptyStringSchema,
              description: stringSchema(),
              resourceIds: stringArraySchema,
            },
            ["action", "collectionName"],
          ),
          objectSchema({ action: { const: "delete" }, collectionName: nonEmptyStringSchema }, [
            "action",
            "collectionName",
          ]),
          objectSchema(
            {
              action: { const: "set-members" },
              collectionName: nonEmptyStringSchema,
              resourceIds: stringArraySchema,
            },
            ["action", "collectionName", "resourceIds"],
          ),
          objectSchema({ action: { const: "set-defaults" }, collectionNames: stringArraySchema }, [
            "action",
            "collectionNames",
          ]),
        ],
      };
    case "applyControlPlaneMutation":
    case "applyInventoryStoreImport":
    case "applyInventorySecretAdoption":
    case "applySync":
    case "applyProfileMutation":
    case "applyResourceUpdate":
      return mutationPlanBodySchema;
    case "planInventoryStoreImport":
      return objectSchema(
        {
          candidateIds: stringArraySchema,
          agentId: agentIdSchema,
          dir: nonEmptyStringSchema,
          intoCollection: nonEmptyStringSchema,
        },
        ["candidateIds"],
      );
    case "planInventorySecretAdoption":
      return objectSchema(
        {
          candidateId: nonEmptyStringSchema,
          selector: inventorySecretFieldSelectorSchema,
          provider: enumSchema(["vault", "keychain"]),
          agentId: agentIdSchema,
          dir: nonEmptyStringSchema,
        },
        ["candidateId", "selector", "provider"],
      );
    case "planSync":
      return syncBodySchema;
    case "planProfileMutation":
      return {
        oneOf: [
          objectSchema(
            {
              action: enumSchema(["create", "update"]),
              profileId: nonEmptyStringSchema,
              desired: syncProfileDesiredSchema,
            },
            ["action", "profileId", "desired"],
          ),
          objectSchema({ action: { const: "delete" }, profileId: nonEmptyStringSchema }, [
            "action",
            "profileId",
          ]),
        ],
      };
    case "planSettingsMutation":
      return objectSchema({ settings: settingsPatchDataSchema }, ["settings"]);
    case "validateConfig":
      return cellarerConfigInputSchema;
    case "getDiff":
    case "getVerification":
      return distributeBodySchema;
    case "planRevertMutation":
      return revertBodySchema;
    case "applyRevertMutation":
      return objectSchema(
        {
          ...(revertBodySchema.properties ?? {}),
          mutationPlan: mutationPlanSchema,
        },
        ["mutationPlan"],
      );
    case "applyMutationRecovery":
      return objectSchema(
        { operationId: nonEmptyStringSchema, snapshotPassphrase: nonEmptyStringSchema },
        ["operationId"],
      );
    case "getResourceDependencies":
    case "checkResourceUpdate":
    case "planResourceUpdate":
      return resourceIdBodySchema;
    case "planResourceRename":
      return objectSchema(
        {
          resourceId: nonEmptyStringSchema,
          newName: nonEmptyStringSchema,
          mode: enumSchema(["rename", "local-fork"]),
        },
        ["resourceId", "newName", "mode"],
      );
    case "applyResourceRename":
      return objectSchema(
        {
          resourceId: nonEmptyStringSchema,
          newName: nonEmptyStringSchema,
          mode: enumSchema(["rename", "local-fork"]),
          mutationPlan: mutationPlanSchema,
        },
        ["resourceId", "newName", "mode", "mutationPlan"],
      );
    case "planResourceRemove":
      return objectSchema({ resourceId: nonEmptyStringSchema, cascade: booleanSchema }, [
        "resourceId",
        "cascade",
      ]);
    case "applyResourceRemove":
      return objectSchema(
        {
          resourceId: nonEmptyStringSchema,
          cascade: booleanSchema,
          mutationPlan: mutationPlanSchema,
        },
        ["resourceId", "cascade", "mutationPlan"],
      );
    case "planResourceExport":
      return objectSchema({ resourceId: nonEmptyStringSchema, bundlePath: nonEmptyStringSchema }, [
        "resourceId",
        "bundlePath",
      ]);
    case "applyResourceExport":
      return objectSchema(
        {
          resourceId: nonEmptyStringSchema,
          bundlePath: nonEmptyStringSchema,
          mutationPlan: mutationPlanSchema,
        },
        ["resourceId", "bundlePath", "mutationPlan"],
      );
    case "validateResourceBundle":
    case "planResourceBundleImport":
      return resourceBundleBodySchema;
    case "applyResourceBundleImport":
      return objectSchema({ bundlePath: nonEmptyStringSchema, mutationPlan: mutationPlanSchema }, [
        "bundlePath",
        "mutationPlan",
      ]);
    case "planSyncProfileInvocation":
    case "verifySyncProfileInvocation":
      return profileInvocationBodySchema;
    case "applySyncProfileInvocation":
      return objectSchema(
        {
          ...(profileInvocationBodySchema.properties ?? {}),
          mutationPlan: mutationPlanSchema,
        },
        ["mutationPlan"],
      );
    case "planSyncProfileUninstall":
      return objectSchema({
        ...(profileInvocationBodySchema.properties ?? {}),
        acknowledgements: stringArraySchema,
        dryRun: booleanSchema,
      });
    case "applySyncProfileUninstall":
      return objectSchema(
        {
          ...(profileInvocationBodySchema.properties ?? {}),
          mutationPlan: mutationPlanSchema,
          targetKeys: stringArraySchema,
          acknowledgements: stringArraySchema,
        },
        ["mutationPlan", "targetKeys"],
      );
    default:
      throw new TypeError(`missing request body schema for ${operationId}`);
  }
}

const nullableSchema = <const Schema extends ClientJsonSchema>(schema: Schema) =>
  ({ oneOf: [schema, { type: "null" }] }) as const satisfies ClientJsonSchema;
const componentSchema = <const Name extends string>(name: Name) =>
  ({ $ref: `#/components/schemas/${name}` }) as const satisfies ClientJsonSchema;

const appliedReceiptSchema = objectSchema(
  {
    method: enumSchema(["write", "symlink", "junction", "copy"]),
    fingerprint: nonEmptyStringSchema,
    contentFingerprint: nonEmptyStringSchema,
    sourceFingerprint: nonEmptyStringSchema,
    backup: { type: ["string", "null"] },
    generated: booleanSchema,
    appliedAt: nonEmptyStringSchema,
  },
  ["method", "fingerprint", "backup", "generated", "appliedAt"],
);
const targetAcknowledgementSchema = objectSchema(
  {
    kind: enumSchema(["replace-unowned", "override-drift", "revert-drift", "uninstall-drift"]),
    token: nonEmptyStringSchema,
  },
  ["kind", "token"],
);
const targetOwnershipEvidenceSchema = objectSchema(
  {
    key: nonEmptyStringSchema,
    classification: enumSchema([
      "absent",
      "owned-current",
      "owned-drifted",
      "unowned-existing",
      "invalid-owner",
    ]),
    target: nonEmptyStringSchema,
    currentFingerprint: { type: ["string", "null"] },
    expectedReceipt: nullableSchema(appliedReceiptSchema),
  },
  ["key", "classification", "target", "currentFingerprint", "expectedReceipt"],
);
const targetConflictSchema = objectSchema(
  {
    code: enumSchema([
      "SHARED_TARGET_CONFLICT",
      "STATE_UPGRADE_REQUIRED",
      "UNOWNED_TARGET",
      "OWNED_TARGET_DRIFTED",
      "INVALID_TARGET_OWNER",
      "SNAPSHOT_ENCRYPTION_REQUIRED",
      "REVERT_TARGET_DRIFTED",
      "REVERT_SNAPSHOT_UNAVAILABLE",
    ]),
    target: nonEmptyStringSchema,
    message: stringSchema(),
    ownership: targetOwnershipEvidenceSchema,
    acknowledgement: targetAcknowledgementSchema,
  },
  ["code", "target", "message", "ownership"],
);
const desiredTargetEvidenceSchema = objectSchema(
  {
    method: enumSchema(["write", "symlink", "copy"]),
    contentFingerprint: nonEmptyStringSchema,
    sourceFingerprint: nonEmptyStringSchema,
    sourceIdentity: nonEmptyStringSchema,
  },
  ["method"],
);
const storeInputEvidenceSchema = objectSchema(
  {
    artifactId: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
    fingerprint: nonEmptyStringSchema,
  },
  ["artifactId", "path", "fingerprint"],
);
const planActionSchema = objectSchema(
  {
    consumerAgents: stringArraySchema,
    artifact: nonEmptyStringSchema,
    artifactIds: stringArraySchema,
    agent: nonEmptyStringSchema,
    scope: scopeSchema,
    capability: capabilitySchema,
    target: nonEmptyStringSchema,
    source: nonEmptyStringSchema,
    method: enumSchema(["symlink", "copy"]),
    op: enumSchema(["write", "symlink", "copy", "merge", "overwrite", "skip"]),
    reason: stringSchema(),
    preview: objectSchema({ before: stringSchema(), after: stringSchema() }),
    secretRefs: stringArraySchema,
    accidentalPlaintext: booleanSchema,
    desiredEvidence: desiredTargetEvidenceSchema,
    storeInputs: arraySchema(storeInputEvidenceSchema),
    ownership: targetOwnershipEvidenceSchema,
    replacement: objectSchema(
      { acknowledgement: targetAcknowledgementSchema, snapshotRequired: { const: true } },
      ["acknowledgement", "snapshotRequired"],
    ),
  },
  ["artifact", "agent", "scope", "capability", "target", "method", "op"],
);
const secretGuardFindingSchema = objectSchema(
  {
    artifact: nonEmptyStringSchema,
    source: nonEmptyStringSchema,
    line: integerSchema(1),
    rule: nonEmptyStringSchema,
    patternVersion: integerSchema(1),
  },
  ["artifact", "source", "line", "rule"],
);
const secretReferenceFindingSchema = objectSchema(
  {
    reference: nonEmptyStringSchema,
    provider: enumSchema(["environment", "vault", "keychain"]),
    status: enumSchema(["missing", "unavailable"]),
  },
  ["reference", "provider", "status"],
);

const distributePlanDefinitionSchema = objectSchema(
  {
    actions: arraySchema(planActionSchema),
    warnings: stringArraySchema,
    conflicts: arraySchema(targetConflictSchema),
    secretFindings: arraySchema(secretGuardFindingSchema),
    secretReferenceFindings: arraySchema(secretReferenceFindingSchema),
    invalidLedger: { const: true },
  },
  ["actions", "warnings", "conflicts"],
);
export type DistributePlanSchemaContract = AssertSchemaContract<
  ExactSchemaContract<typeof distributePlanDefinitionSchema, DistributePlan>
>;
const distributePlanDataSchema = componentSchema("DistributePlan");

const revertPlanDataSchema = objectSchema(
  {
    targets: arraySchema(componentSchema("RevertTarget")),
    conflicts: arraySchema(targetConflictSchema),
    warnings: stringArraySchema,
  },
  ["targets", "conflicts", "warnings"],
);

const mutationConflictDataSchema: ClientJsonSchema = {
  oneOf: [
    objectSchema(
      { code: { const: "LOCK_CONFLICT" }, message: stringSchema(), owner: lockOwnerEvidenceSchema },
      ["code", "message", "owner"],
    ),
    objectSchema(
      { code: { const: "INVALID_PLAN" }, message: { const: "mutation plan is invalid" } },
      ["code", "message"],
    ),
    objectSchema(
      {
        code: { const: "STALE_REVISION" },
        message: stringSchema(),
        planId: nonEmptyStringSchema,
        expectedRevision: integerSchema(),
        actualRevision: integerSchema(),
        replanRequired: { const: true },
      },
      ["code", "message", "planId", "expectedRevision", "actualRevision", "replanRequired"],
    ),
    objectSchema(
      {
        code: { const: "EXPIRED_PLAN" },
        message: stringSchema(),
        planId: nonEmptyStringSchema,
        expiredAt: nonEmptyStringSchema,
      },
      ["code", "message", "planId", "expiredAt"],
    ),
    objectSchema(
      {
        code: { const: "INVALID_PLAN_DIGEST" },
        message: stringSchema(),
        planId: nonEmptyStringSchema,
        expectedDigest: nonEmptyStringSchema,
        actualDigest: nonEmptyStringSchema,
      },
      ["code", "message", "planId", "expectedDigest", "actualDigest"],
    ),
    objectSchema(
      {
        code: { const: "TARGET_PRECONDITION_CONFLICT" },
        message: stringSchema(),
        planId: nonEmptyStringSchema,
        actionId: nonEmptyStringSchema,
        target: nonEmptyStringSchema,
        expected: targetStateReceiptSchema,
        actual: targetStateReceiptSchema,
      },
      ["code", "message", "planId", "actionId", "target", "expected", "actual"],
    ),
    objectSchema(
      {
        code: { const: "INTERRUPTED_OPERATION" },
        message: stringSchema(),
        operationId: nonEmptyStringSchema,
        journalStatus: enumSchema([
          "prepared",
          "executing",
          "publishing-state",
          "completed",
          "recovery-required",
        ]),
      },
      ["code", "message", "operationId", "journalStatus"],
    ),
    objectSchema(
      {
        code: { const: "PARTIAL_FAILURE" },
        message: stringSchema(),
        operationId: nonEmptyStringSchema,
        failedActionIds: stringArraySchema,
      },
      ["code", "message", "operationId", "failedActionIds"],
    ),
    objectSchema(
      {
        code: { const: "MANUAL_RECOVERY_REQUIRED" },
        message: stringSchema(),
        operationId: nonEmptyStringSchema,
        targets: stringArraySchema,
        guidance: stringSchema(),
      },
      ["code", "message", "operationId", "targets", "guidance"],
    ),
  ],
};

const operationActionReceiptSchema = objectSchema(
  {
    actionId: nonEmptyStringSchema,
    target: nonEmptyStringSchema,
    outcome: enumSchema(["applied", "unchanged", "compensated", "failed"]),
    before: targetStateReceiptSchema,
    after: targetStateReceiptSchema,
    recordedAt: nonEmptyStringSchema,
    error: objectSchema({ code: nonEmptyStringSchema, message: stringSchema() }, [
      "code",
      "message",
    ]),
  },
  ["actionId", "target", "outcome", "before", "after", "recordedAt"],
);

const operationReceiptDefinitionSchema = objectSchema(
  {
    schemaVersion: { const: 1 },
    operationId: nonEmptyStringSchema,
    planId: nonEmptyStringSchema,
    planDigest: nonEmptyStringSchema,
    operation: enumSchema([
      "initialize",
      "apply",
      "revert",
      "settings",
      "secret-metadata",
      "store-import",
      "resource-lifecycle",
      "sync-uninstall",
      "sync-reconcile",
    ]),
    baseRevision: integerSchema(),
    resultingRevision: integerSchema(),
    outcome: enumSchema(["committed", "compensated", "manual-recovery-required"]),
    actionReceipts: arraySchema(operationActionReceiptSchema),
    startedAt: nonEmptyStringSchema,
    completedAt: nonEmptyStringSchema,
  },
  [
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
  ],
);
const operationReceiptDataSchema = componentSchema("OperationReceipt");

const operationResultDefinitionSchema: ClientJsonSchema = {
  oneOf: [
    objectSchema({ ok: { const: true }, receipt: operationReceiptDataSchema }, ["ok", "receipt"]),
    objectSchema(
      {
        ok: { const: false },
        conflict: componentSchema("MutationConflict"),
        journal: componentSchema("OperationJournal"),
      },
      ["ok", "conflict"],
    ),
  ],
};
const operationResultDataSchema = componentSchema("OperationResult");

const mutationPresentationDataSchema = objectSchema(
  {
    planId: nonEmptyStringSchema,
    planDigest: nonEmptyStringSchema,
    operation: nonEmptyStringSchema,
    baseRevision: integerSchema(),
    result: operationResultDataSchema,
  },
  ["planId", "planDigest", "operation", "baseRevision"],
);

const plannedControlPlaneMutationDataSchema = objectSchema(
  {
    plan: mutationPlanSchema,
    changedFields: stringArraySchema,
    receipt: operationReceiptDataSchema,
  },
  ["plan", "changedFields"],
);

const applyMutationDataSchema = objectSchema(
  {
    plan: distributePlanDataSchema,
    entries: arraySchema(componentSchema("LedgerEntry")),
    failures: arraySchema(componentSchema("ApplyFailure")),
    mutation: mutationPresentationDataSchema,
    operation: operationResultDataSchema,
  },
  ["plan", "entries", "failures", "mutation", "operation"],
);

const validationIssueSchema = objectSchema(
  { path: nonEmptyStringSchema, message: stringSchema() },
  ["path", "message"],
);
const resourceSourceDescriptorSchema = {
  oneOf: [
    objectSchema({ type: { const: "local-snapshot" }, capturedFrom: nonEmptyStringSchema }, [
      "type",
    ]),
    objectSchema(
      {
        type: { const: "git" },
        repositoryUrl: nonEmptyStringSchema,
        ref: nonEmptyStringSchema,
        commit: nonEmptyStringSchema,
        subpath: nonEmptyStringSchema,
      },
      ["type", "repositoryUrl", "ref", "commit", "subpath"],
    ),
    objectSchema(
      {
        type: { const: "url" },
        url: nonEmptyStringSchema,
        integrity: nonEmptyStringSchema,
        validators: objectSchema(
          { etag: nonEmptyStringSchema, lastModified: nonEmptyStringSchema },
          [],
        ),
      },
      ["type", "url", "integrity"],
    ),
  ],
} as const satisfies ClientJsonSchema;
const resourceValidationEvidenceSchema = objectSchema(
  {
    status: enumSchema(["validated", "backfilled"]),
    checkedAt: nonEmptyStringSchema,
    checks: arraySchema(
      enumSchema(["content-fingerprint", "manifest", "adapter-compatibility", "secret-scan"]),
    ),
  },
  ["status", "checkedAt", "checks"],
);
const resourceRevisionSchema = objectSchema(
  {
    id: nonEmptyStringSchema,
    contentFingerprint: nonEmptyStringSchema,
    validation: resourceValidationEvidenceSchema,
    source: resourceSourceDescriptorSchema,
  },
  ["id", "contentFingerprint", "validation", "source"],
);
const resourceRecordSchema = objectSchema(
  {
    schemaVersion: { const: 1 },
    resourceId: nonEmptyStringSchema,
    kind: capabilitySchema,
    name: nonEmptyStringSchema,
    currentRevision: resourceRevisionSchema,
  },
  ["schemaVersion", "resourceId", "kind", "name", "currentRevision"],
);
const resourceSyncTargetSchema = objectSchema(
  {
    agent: nonEmptyStringSchema,
    destination: destinationSchema,
    scope: scopeSchema,
    target: nonEmptyStringSchema,
    state: enumSchema(["synced", "drifted", "missing", "blocked"]),
    reason: stringSchema(),
  },
  ["agent", "destination", "scope", "target", "state"],
);
const inventorySecretFieldSelectorSchema = {
  oneOf: [
    objectSchema(
      {
        kind: enumSchema(["environment", "header", "url-query"]),
        server: nonEmptyStringSchema,
        name: nonEmptyStringSchema,
      },
      ["kind", "server", "name"],
    ),
    objectSchema(
      {
        kind: { const: "argument" },
        server: nonEmptyStringSchema,
        name: nonEmptyStringSchema,
        index: integerSchema(),
        style: enumSchema(["assignment", "value"]),
      },
      ["kind", "server", "name", "index", "style"],
    ),
  ],
} as const satisfies ClientJsonSchema;
const inventorySecretAdoptionProviderSchema = {
  oneOf: [
    objectSchema({ kind: { const: "vault" } }, ["kind"]),
    objectSchema({ kind: { const: "keychain" }, service: { const: "cellarer" } }, [
      "kind",
      "service",
    ]),
  ],
} as const satisfies ClientJsonSchema;
const inventorySecretAdoptionOfferSchema = objectSchema(
  { selector: inventorySecretFieldSelectorSchema, targetName: nonEmptyStringSchema },
  ["selector", "targetName"],
);
const inventorySecretAdoptionOrphanEvidenceSchema = objectSchema(
  {
    status: { const: "provider-created-store-unpublished" },
    provider: inventorySecretAdoptionProviderSchema,
    targetName: nonEmptyStringSchema,
    cleanupCommand: stringSchema({
      pattern: "^cellarer secret rm [a-z0-9][a-z0-9-]* --provider (vault|keychain)$",
    }),
  },
  ["status", "provider", "targetName", "cleanupCommand"],
);
const inventorySecretAdoptionExternalEffectSchema = objectSchema(
  {
    effectId: nonEmptyStringSchema,
    kind: { const: "secret-reference-create" },
    provider: inventorySecretAdoptionProviderSchema,
    targetName: nonEmptyStringSchema,
    cleanupCommand: stringSchema({
      pattern: "^cellarer secret rm [a-z0-9][a-z0-9-]* --provider (vault|keychain)$",
    }),
  },
  ["effectId", "kind", "provider", "targetName", "cleanupCommand"],
);
const resourceInventoryFindingSchema = objectSchema(
  {
    code: enumSchema([
      "ADAPTER_DETECTION_FAILED",
      "ADAPTER_PATHS_FAILED",
      "SOURCE_OUTSIDE_BOUNDARY",
      "SOURCE_UNREADABLE",
      "SOURCE_BUDGET_EXCEEDED",
      "UNSAFE_LINK",
      "UNSUPPORTED_SNAPSHOT",
      "SNAPSHOT_STALE",
      "INVALID_STRUCTURE",
      "INVALID_MANIFEST",
      "PARSE_FAILED",
      "PROBABLE_SECRET",
      "secret-adoption-required",
      "CONFLICT",
      "STORE_SNAPSHOT_STALE",
      "STORE_SNAPSHOT_UNSAFE",
      "STORE_PROJECTION_FAILED",
    ]),
    severity: enumSchema(["warning", "blocked"]),
    scope: enumSchema(["refresh", "source", "candidate"]),
    remediation: enumSchema([
      "review-adapter",
      "check-source-access",
      "remove-unsafe-link",
      "retry-refresh",
      "fix-structure",
      "remove-secret-values",
      "adopt-supported-secret",
      "resolve-conflict",
      "repair-store",
    ]),
    sourceId: nonEmptyStringSchema,
    adoption: inventorySecretAdoptionOfferSchema,
  },
  ["code", "severity", "scope", "remediation"],
);
const resourceInventoryAdapterSchema = objectSchema(
  {
    id: nonEmptyStringSchema,
    displayName: nonEmptyStringSchema,
    enabled: booleanSchema,
    detected: booleanSchema,
  },
  ["id", "displayName", "enabled", "detected"],
);
const resourceInventorySourceSchema = objectSchema(
  {
    id: nonEmptyStringSchema,
    kind: capabilitySchema,
    scope: scopeSchema,
    location: nonEmptyStringSchema,
    adapters: arraySchema(resourceInventoryAdapterSchema),
  },
  ["id", "kind", "scope", "location", "adapters"],
);
const resourceDtoDefinitionSchema = objectSchema(
  {
    id: nonEmptyStringSchema,
    kind: capabilitySchema,
    name: nonEmptyStringSchema,
    source: nonEmptyStringSchema,
    state: enumSchema(["managed", "discovered", "synced", "drifted", "missing", "blocked"]),
    currentRevision: resourceRevisionSchema,
    provenance: resourceSourceDescriptorSchema,
    discovered: objectSchema(
      {
        agent: nonEmptyStringSchema,
        destination: destinationSchema,
        source: nonEmptyStringSchema,
        candidateId: nonEmptyStringSchema,
        defaultSelected: booleanSchema,
        sources: arraySchema(resourceInventorySourceSchema),
        relatedAdapters: arraySchema(resourceInventoryAdapterSchema),
        findings: arraySchema(resourceInventoryFindingSchema),
      },
      [
        "agent",
        "destination",
        "source",
        "candidateId",
        "defaultSelected",
        "sources",
        "relatedAdapters",
        "findings",
      ],
    ),
    membership: objectSchema({ collections: stringArraySchema }, ["collections"]),
    selection: objectSchema(
      {
        desired: booleanSchema,
        collections: stringArraySchema,
        inventoryDefault: booleanSchema,
      },
      ["desired", "collections"],
    ),
    validation: objectSchema(
      {
        status: enumSchema(["valid", "warning", "invalid"]),
        issues: arraySchema(validationIssueSchema),
      },
      ["status", "issues"],
    ),
    secretReferenceNames: stringArraySchema,
    usage: objectSchema(
      {
        desired: arraySchema(objectSchema({ collection: nonEmptyStringSchema }, ["collection"])),
        applied: arraySchema(resourceSyncTargetSchema),
      },
      ["desired", "applied"],
    ),
    lastActivityAt: nonEmptyStringSchema,
  },
  [
    "id",
    "kind",
    "name",
    "source",
    "state",
    "membership",
    "selection",
    "validation",
    "secretReferenceNames",
    "usage",
  ],
);
export type ControlPlaneResourceSchemaContract = AssertSchemaContract<
  ExactSchemaContract<typeof resourceDtoDefinitionSchema, ControlPlaneResourceDto>
>;
const resourceCountsSchema = objectSchema(
  {
    managed: integerSchema(),
    discovered: integerSchema(),
    synced: integerSchema(),
    drifted: integerSchema(),
    missing: integerSchema(),
    blocked: integerSchema(),
  },
  ["managed", "discovered", "synced", "drifted", "missing", "blocked"],
);
const controlPlaneResourceListDataSchema = objectSchema(
  {
    generatedAt: nonEmptyStringSchema,
    resources: arraySchema(componentSchema("Resource")),
    counts: resourceCountsSchema,
    warnings: stringArraySchema,
  },
  ["generatedAt", "resources", "counts", "warnings"],
);
export type ControlPlaneResourceListSchemaContract = AssertSchemaContract<
  ExactSchemaContract<typeof controlPlaneResourceListDataSchema, ControlPlaneResourceListDto>
>;

const agentDtoDefinitionSchema = objectSchema(
  {
    id: nonEmptyStringSchema,
    displayName: nonEmptyStringSchema,
    adapterKind: enumSchema(["built-in", "custom"]),
    supported: { const: true },
    detected: booleanSchema,
    configured: booleanSchema,
    enabled: booleanSchema,
    detectionEvidence: objectSchema({ root: nonEmptyStringSchema }),
    compatibility: arraySchema(
      objectSchema(
        {
          capability: capabilitySchema,
          scope: scopeSchema,
          evidence: enumSchema(["documented", "unsupported", "unknown", "user-defined"]),
          native: { const: "unknown" },
          contractVersion: nonEmptyStringSchema,
          location: { anyOf: [nonEmptyStringSchema, { type: "null" }] },
          sources: arraySchema(nonEmptyStringSchema),
          prerequisites: arraySchema(nonEmptyStringSchema),
        },
        [
          "capability",
          "scope",
          "evidence",
          "native",
          "contractVersion",
          "location",
          "sources",
          "prerequisites",
        ],
      ),
    ),
    capabilities: capabilityArraySchema,
    capabilityScopes: objectSchema(
      {
        rules: arraySchema(scopeSchema),
        mcp: arraySchema(scopeSchema),
        skills: arraySchema(scopeSchema),
      },
      ["rules", "mcp", "skills"],
    ),
    targets: arraySchema(
      objectSchema(
        { capability: capabilitySchema, scope: scopeSchema, path: nonEmptyStringSchema },
        ["capability", "scope", "path"],
      ),
    ),
    validationIssues: arraySchema(validationIssueSchema),
  },
  [
    "id",
    "displayName",
    "adapterKind",
    "supported",
    "detected",
    "configured",
    "enabled",
    "detectionEvidence",
    "compatibility",
    "capabilities",
    "capabilityScopes",
    "targets",
    "validationIssues",
  ],
);
export type ControlPlaneAgentSchemaContract = AssertSchemaContract<
  ExactSchemaContract<typeof agentDtoDefinitionSchema, ControlPlaneAgentDto>
>;
const controlPlaneAgentListDataSchema = objectSchema(
  {
    storeRoot: nonEmptyStringSchema,
    scope: scopeSchema,
    dir: nonEmptyStringSchema,
    agents: arraySchema(componentSchema("Agent")),
    warnings: stringArraySchema,
  },
  ["storeRoot", "scope", "agents", "warnings"],
);
export type ControlPlaneAgentListSchemaContract = AssertSchemaContract<
  ExactSchemaContract<typeof controlPlaneAgentListDataSchema, ControlPlaneAgentListDto>
>;
const collectionDtoDefinitionSchema = objectSchema(
  {
    name: nonEmptyStringSchema,
    description: stringSchema(),
    isDefault: booleanSchema,
    resourceIds: stringArraySchema,
  },
  ["name", "isDefault", "resourceIds"],
);
const syncProfileDefinitionSchema = objectSchema(
  {
    schemaVersion: { const: 1 },
    profileId: nonEmptyStringSchema,
    revision: nonEmptyStringSchema,
    createdAt: nonEmptyStringSchema,
    updatedAt: nonEmptyStringSchema,
    desired: syncProfileDesiredSchema,
  },
  ["schemaVersion", "profileId", "revision", "createdAt", "updatedAt", "desired"],
);
const activityEventDefinitionSchema = objectSchema(
  {
    version: { const: 1 },
    id: nonEmptyStringSchema,
    time: nonEmptyStringSchema,
    actor: enumSchema(["you", "system"]),
    action: enumSchema(["apply", "inventory-import", "scan-import", "revert"]),
    scope: scopeSchema,
    projectDir: nonEmptyStringSchema,
    agents: stringArraySchema,
    capabilities: capabilityArraySchema,
    affectedCount: integerSchema(),
    warningsCount: integerSchema(),
    summary: stringSchema(),
    resources: objectSchema(
      { ledgerEntryKeys: stringArraySchema, artifactIds: stringArraySchema },
      ["ledgerEntryKeys", "artifactIds"],
    ),
    secretRefs: stringArraySchema,
  },
  [
    "version",
    "id",
    "time",
    "actor",
    "action",
    "agents",
    "capabilities",
    "affectedCount",
    "warningsCount",
    "summary",
    "secretRefs",
  ],
);
export type ActivityEventSchemaContract = AssertSchemaContract<
  ExactSchemaContract<typeof activityEventDefinitionSchema, ActivityEvent>
>;
const activityListDataSchema = objectSchema(
  { events: arraySchema(componentSchema("ActivityEvent")), warnings: stringArraySchema },
  ["events", "warnings"],
);
type ActivityListData = { events: ActivityEvent[]; warnings: string[] };
export type ActivityListSchemaContract = AssertSchemaContract<
  ExactSchemaContract<typeof activityListDataSchema, ActivityListData>
>;
const operationSummaryDefinitionSchema = objectSchema(
  {
    operationId: nonEmptyStringSchema,
    planId: nonEmptyStringSchema,
    operation: enumSchema([
      "initialize",
      "apply",
      "revert",
      "settings",
      "secret-metadata",
      "store-import",
      "resource-lifecycle",
      "sync-uninstall",
      "sync-reconcile",
    ]),
    baseRevision: integerSchema(),
    resultingRevision: integerSchema(),
    outcome: enumSchema(["committed", "compensated", "manual-recovery-required"]),
    actionCount: integerSchema(),
    startedAt: nonEmptyStringSchema,
    completedAt: nonEmptyStringSchema,
  },
  [
    "operationId",
    "planId",
    "operation",
    "baseRevision",
    "resultingRevision",
    "outcome",
    "actionCount",
    "startedAt",
    "completedAt",
  ],
);

const resolvedSyncProfileResourceSchema = objectSchema(
  {
    resourceId: nonEmptyStringSchema,
    revision: nonEmptyStringSchema,
    capability: capabilitySchema,
  },
  ["resourceId", "revision", "capability"],
);
const syncProfileTargetEvidenceSchema = objectSchema(
  {
    profileId: nonEmptyStringSchema,
    profileRevision: nonEmptyStringSchema,
    resolvedResources: arraySchema(resolvedSyncProfileResourceSchema),
  },
  ["profileId", "profileRevision", "resolvedResources"],
);
const ledgerEntrySchema = objectSchema(
  {
    itemAttribution: enumSchema(["unknown", "known"]),
    contributions: arraySchema(
      objectSchema(
        {
          selector: nonEmptyStringSchema,
          fingerprint: nonEmptyStringSchema,
          resourceIds: stringArraySchema,
          provenance: enumSchema(["resource", "local-baseline"]),
        },
        ["selector", "fingerprint", "resourceIds", "provenance"],
      ),
    ),
    deploymentId: nonEmptyStringSchema,
    deploymentRoot: nonEmptyStringSchema,
    agent: nonEmptyStringSchema,
    scope: scopeSchema,
    capability: capabilitySchema,
    target: nonEmptyStringSchema,
    projectRoot: nonEmptyStringSchema,
    artifactIds: stringArraySchema,
    syncProfile: syncProfileTargetEvidenceSchema,
    receipt: appliedReceiptSchema,
    secretRefs: stringArraySchema,
  },
  ["agent", "scope", "capability", "target", "artifactIds", "receipt"],
);
const applyFailureSchema = objectSchema(
  {
    code: enumSchema(["SNAPSHOT_FAILED", "ACTION_IO_FAILED"]),
    target: nonEmptyStringSchema,
    message: stringSchema(),
  },
  ["code", "target", "message"],
);
const revertFailureSchema = objectSchema(
  {
    code: enumSchema(["SNAPSHOT_PASSPHRASE_REQUIRED", "REVERT_FAILED"]),
    target: nonEmptyStringSchema,
    message: stringSchema(),
  },
  ["code", "target", "message"],
);
const statusItemSchema = objectSchema(
  {
    artifact: nonEmptyStringSchema,
    agent: nonEmptyStringSchema,
    scope: scopeSchema,
    capability: capabilitySchema,
    target: nonEmptyStringSchema,
    status: enumSchema(["ok", "drifted", "missing", "broken-link"]),
  },
  ["artifact", "agent", "scope", "capability", "target", "status"],
);
export type StatusItemSchemaContract = AssertSchemaContract<
  ExactSchemaContract<typeof statusItemSchema, StatusItem>
>;
const statusListDataSchema = objectSchema(
  { generatedAt: nonEmptyStringSchema, items: arraySchema(statusItemSchema) },
  ["generatedAt", "items"],
);
type StatusListData = { generatedAt: string; items: StatusItem[] };
export type StatusListSchemaContract = AssertSchemaContract<
  ExactSchemaContract<typeof statusListDataSchema, StatusListData>
>;
const desiredAppliedItemSchema = objectSchema(
  {
    agent: nonEmptyStringSchema,
    scope: scopeSchema,
    capability: capabilitySchema,
    target: nonEmptyStringSchema,
    status: enumSchema([
      "in-sync",
      "missing-applied",
      "selection-mismatch",
      "content-mismatch",
      "method-mismatch",
      "provenance-mismatch",
      "unverifiable",
      "unexpected-applied",
    ]),
    desiredArtifactIds: stringArraySchema,
    appliedArtifactIds: stringArraySchema,
    desiredMethod: enumSchema(["write", "symlink", "copy"]),
    appliedMethod: enumSchema(["write", "symlink", "copy"]),
    comparisons: objectSchema(
      {
        selection: enumSchema(["matched", "mismatched", "unverifiable", "not-applicable"]),
        content: enumSchema(["matched", "mismatched", "unverifiable", "not-applicable"]),
        method: enumSchema(["matched", "mismatched", "unverifiable", "not-applicable"]),
        provenance: enumSchema(["matched", "mismatched", "unverifiable", "not-applicable"]),
      },
      ["selection", "content", "method", "provenance"],
    ),
  },
  [
    "agent",
    "scope",
    "capability",
    "target",
    "status",
    "desiredArtifactIds",
    "appliedArtifactIds",
    "comparisons",
  ],
);
const mutationRecoveryPresentationSchema = objectSchema(
  {
    status: enumSchema([
      "clean",
      "incomplete",
      "completed-pending-cleanup",
      "manual-recovery-required",
    ]),
    operationId: nonEmptyStringSchema,
    planId: nonEmptyStringSchema,
    baseRevision: integerSchema(),
    error: mutationConflictDataSchema,
  },
  ["status"],
);
const configOsDefaultsSchema = objectSchema({
  win32: objectSchema({ method: enumSchema(["symlink", "copy"]) }),
  darwin: objectSchema({ method: enumSchema(["symlink", "copy"]) }),
  linux: objectSchema({ method: enumSchema(["symlink", "copy"]) }),
});
const configDefaultsSchema = objectSchema(
  {
    method: enumSchema(["symlink", "copy"]),
    collections: stringArraySchema,
    secretMode: enumSchema(["env", "vault", "keychain"]),
    os: configOsDefaultsSchema,
  },
  ["method", "collections", "secretMode"],
);
const configCollectionSchema = objectSchema({ description: stringSchema() });
const secretPatternSuppressionSchema = objectSchema(
  {
    source: stringSchema({
      minLength: 1,
      pattern: NORMALIZED_STORE_RELATIVE_SOURCE_PATTERN,
    }),
    rule: nonEmptyStringSchema,
    patternVersion: integerSchema(1),
  },
  ["source", "rule", "patternVersion"],
);
const configArtifactSchema = objectSchema(
  {
    collections: stringArraySchema,
    secretPatternSuppressions: arraySchema(secretPatternSuppressionSchema),
  },
  ["collections"],
);
const adapterRulesSchema = objectSchema({
  global: nonEmptyStringSchema,
  project: nonEmptyStringSchema,
  format: { const: "markdown" },
});
const adapterMcpDialectSchema = objectSchema({
  expansionPositions: arraySchema(enumSchema(["command", "args", "env", "url", "headers"])),
  semanticDialect: enumSchema(["standard", "claude", "gemini", "codex"]),
  commandStyle: enumSchema(["scalar", "array"]),
  envKey: nonEmptyStringSchema,
  urlKey: nonEmptyStringSchema,
  typeField: nonEmptyStringSchema,
  stdioType: nonEmptyStringSchema,
  remoteType: nonEmptyStringSchema,
});
const adapterMcpSchema = objectSchema({
  global: nonEmptyStringSchema,
  project: nonEmptyStringSchema,
  format: enumSchema(["json", "toml"]),
  serversKey: nonEmptyStringSchema,
  mergeStrategy: enumSchema(["merge", "overwrite"]),
  supportedSecretReferences: arraySchema(stringSchema({ pattern: "^(environment|cellarer)$" })),
  dialect: adapterMcpDialectSchema,
});
const adapterSkillsSchema = objectSchema({
  global: nonEmptyStringSchema,
  project: nonEmptyStringSchema,
  format: { const: "dir" },
});
const adapterCapabilitiesSchema = objectSchema({
  rules: arraySchema(scopeSchema),
  mcp: arraySchema(scopeSchema),
  skills: arraySchema(scopeSchema),
});
const adapterDiscoverySchema = arraySchema(
  objectSchema(
    {
      sourceId: stringSchema({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
      scope: scopeSchema,
      kind: capabilitySchema,
      path: nonEmptyStringSchema,
      locator: enumSchema(["file", "tree"]),
      maxDepth: { type: "integer", minimum: 1, maximum: 64 },
      maxEntries: { type: "integer", minimum: 1, maximum: 100000 },
      maxBytes: { type: "integer", minimum: 1, maximum: 234881024 },
      precedence: {
        oneOf: [
          objectSchema(
            {
              policy: enumSchema(["unknown", "cumulative"]),
              rank: integerSchema(),
              evidence: nonEmptyStringSchema,
            },
            ["policy", "evidence"],
          ),
          objectSchema(
            { policy: { const: "ranked" }, rank: integerSchema(), evidence: nonEmptyStringSchema },
            ["policy", "rank", "evidence"],
          ),
        ],
      },
    },
    [
      "sourceId",
      "scope",
      "kind",
      "path",
      "locator",
      "maxDepth",
      "maxEntries",
      "maxBytes",
      "precedence",
    ],
  ),
);
const adapterDefinitionProperties = {
  discovery: adapterDiscoverySchema,
  displayName: nonEmptyStringSchema,
  detect: objectSchema({ global: stringArraySchema, project: stringArraySchema }),
  rules: adapterRulesSchema,
  mcp: adapterMcpSchema,
  skills: adapterSkillsSchema,
  capabilities: adapterCapabilitiesSchema,
} as const satisfies Readonly<Record<string, ClientJsonSchema>>;
const adapterPatchDataSchema = objectSchema(adapterDefinitionProperties);
const adapterOverrideDataSchema = objectSchema({
  enabled: booleanSchema,
  ...adapterDefinitionProperties,
});
const adapterBodyDataSchema: ClientJsonSchema = {
  oneOf: [
    objectSchema(
      {
        ...adapterDefinitionProperties,
        mcp: { ...adapterMcpSchema, required: ["supportedSecretReferences"] },
      },
      ["mcp"],
    ),
    {
      ...objectSchema(adapterDefinitionProperties),
      anyOf: [{ required: ["rules"] }, { required: ["skills"] }],
      not: { required: ["mcp"] },
    },
  ],
};
const settingsPatchDataSchema: ClientJsonSchema = {
  ...objectSchema({
    method: enumSchema(["symlink", "copy"]),
    secretMode: enumSchema(["env", "vault", "keychain"]),
    os: configOsDefaultsSchema,
  }),
  minProperties: 1,
};
const keyedObjectSchema = (
  valueSchema: ClientJsonSchema,
  propertyNames: ClientJsonSchema,
): ClientJsonSchema => ({
  ...objectSchema({}, [], valueSchema),
  propertyNames,
});
const nonEmptyKeyedObjectSchema = (valueSchema: ClientJsonSchema): ClientJsonSchema =>
  keyedObjectSchema(valueSchema, nonEmptyStringSchema);
const agentKeyedObjectSchema = (valueSchema: ClientJsonSchema): ClientJsonSchema =>
  keyedObjectSchema(valueSchema, agentIdSchema);
const cellarerConfigOutputProperties = {
  version: { const: 1 },
  defaults: configDefaultsSchema,
  collections: nonEmptyKeyedObjectSchema(configCollectionSchema),
  artifacts: nonEmptyKeyedObjectSchema(configArtifactSchema),
  adapterOverrides: agentKeyedObjectSchema(adapterOverrideDataSchema),
  customAdapters: agentKeyedObjectSchema(adapterBodyDataSchema),
} as const satisfies Readonly<Record<string, ClientJsonSchema>>;
const configDefaultsInputSchema = objectSchema({
  method: enumSchema(["symlink", "copy"]),
  collections: stringArraySchema,
  secretMode: enumSchema(["env", "vault", "keychain"]),
  os: configOsDefaultsSchema,
});
const configArtifactInputSchema = objectSchema({
  collections: stringArraySchema,
  secretPatternSuppressions: arraySchema(secretPatternSuppressionSchema),
});
const cellarerConfigInputSchema = objectSchema({
  version: { const: 1 },
  defaults: configDefaultsInputSchema,
  collections: nonEmptyKeyedObjectSchema(configCollectionSchema),
  artifacts: nonEmptyKeyedObjectSchema(configArtifactInputSchema),
  adapterOverrides: agentKeyedObjectSchema(adapterOverrideDataSchema),
  customAdapters: agentKeyedObjectSchema(adapterBodyDataSchema),
});
const cellarerConfigOutputSchema = objectSchema(cellarerConfigOutputProperties, [
  "version",
  "defaults",
  "collections",
  "artifacts",
  "adapterOverrides",
  "customAdapters",
]);
const secretRefStatSchema = objectSchema(
  { name: nonEmptyStringSchema, ledgerEntryCount: integerSchema() },
  ["name", "ledgerEntryCount"],
);
const resourceDependencyReportSchema = objectSchema(
  {
    schemaVersion: { const: 1 },
    resourceId: nonEmptyStringSchema,
    currentRevisionId: nonEmptyStringSchema,
    collections: arraySchema(
      objectSchema({ collectionId: nonEmptyStringSchema, resourceId: nonEmptyStringSchema }, [
        "collectionId",
        "resourceId",
      ]),
    ),
    profiles: arraySchema(
      objectSchema(
        {
          profileId: nonEmptyStringSchema,
          profileRevision: nonEmptyStringSchema,
          viaResource: booleanSchema,
          collectionIds: stringArraySchema,
        },
        ["profileId", "profileRevision", "viaResource", "collectionIds"],
      ),
    ),
    desiredSelections: arraySchema(
      objectSchema(
        {
          selector: { const: "defaults.collections" },
          collectionId: nonEmptyStringSchema,
          resourceId: nonEmptyStringSchema,
        },
        ["selector", "collectionId", "resourceId"],
      ),
    ),
    ownedTargets: arraySchema(
      objectSchema(
        {
          key: nonEmptyStringSchema,
          agent: nonEmptyStringSchema,
          scope: scopeSchema,
          capability: capabilitySchema,
          target: nonEmptyStringSchema,
          resourceId: nonEmptyStringSchema,
          receiptFingerprint: nonEmptyStringSchema,
        },
        ["key", "agent", "scope", "capability", "target", "resourceId", "receiptFingerprint"],
      ),
    ),
  },
  [
    "schemaVersion",
    "resourceId",
    "currentRevisionId",
    "collections",
    "profiles",
    "desiredSelections",
    "ownedTargets",
  ],
);
const revertTargetDefinitionSchema = objectSchema(
  {
    target: nonEmptyStringSchema,
    owners: arraySchema(componentSchema("LedgerEntry")),
    expectedReceipt: appliedReceiptSchema,
    ownership: targetOwnershipEvidenceSchema,
    snapshot: objectSchema(
      {
        path: { type: ["string", "null"] },
        status: enumSchema(["none", "available", "missing", "invalid"]),
        encrypted: booleanSchema,
        digest: nonEmptyStringSchema,
        mode: integerSchema(),
      },
      ["path", "status", "encrypted"],
    ),
    consumerSet: stringArraySchema,
    proposedAction: enumSchema(["detach-consumer", "remove-target", "restore-snapshot"]),
    blocked: booleanSchema,
    blockReason: stringSchema(),
    acknowledgement: targetAcknowledgementSchema,
    driftOverridden: booleanSchema,
  },
  [
    "target",
    "owners",
    "expectedReceipt",
    "ownership",
    "snapshot",
    "proposedAction",
    "blocked",
    "driftOverridden",
  ],
);
const dashboardAgentDefinitionSchema = objectSchema(
  {
    id: nonEmptyStringSchema,
    displayName: nonEmptyStringSchema,
    enabled: booleanSchema,
    scope: scopeSchema,
    root: nonEmptyStringSchema,
    detected: booleanSchema,
    status: enumSchema(["disabled", "not-found", "detected", "ready", "warning", "unsupported"]),
    supportedCapabilities: capabilityArraySchema,
    capabilities: arraySchema(
      objectSchema(
        {
          capability: capabilitySchema,
          status: enumSchema(["ready", "warning", "unsupported"]),
          paths: stringArraySchema,
          warnings: stringArraySchema,
        },
        ["capability", "status", "paths", "warnings"],
      ),
    ),
    warnings: stringArraySchema,
  },
  [
    "id",
    "displayName",
    "enabled",
    "scope",
    "detected",
    "status",
    "supportedCapabilities",
    "capabilities",
    "warnings",
  ],
);
export type DashboardAgentSchemaContract = AssertSchemaContract<
  ExactSchemaContract<typeof dashboardAgentDefinitionSchema, DashboardAgentReadiness>
>;
const verificationCoverageSchema = objectSchema(
  {
    expected: integerSchema(),
    observed: integerSchema(),
    failed: integerSchema(),
    complete: booleanSchema,
    items: arraySchema(
      objectSchema(
        {
          agent: stringSchema(),
          scope: scopeSchema,
          capability: enumSchema(["rules", "mcp", "skills"]),
          outcome: enumSchema(["covered", "no-op", "unsupported", "disabled", "blocked", "failed"]),
          code: enumSchema([
            "EVALUATED",
            "EMPTY_SELECTION",
            "UNSUPPORTED_CAPABILITY",
            "AGENT_DISABLED",
            "PLANNING_BLOCKED",
            "PLANNING_FAILED",
            "OBSERVATION_FAILED",
          ]),
        },
        ["agent", "scope", "capability", "outcome", "code"],
      ),
    ),
  },
  ["expected", "observed", "failed", "complete", "items"],
);
const configurationOutcomeSchema = enumSchema(["healthy", "unhealthy", "no-op", "incomplete"]);
const verificationRuntimeSchema = objectSchema({ observation: enumSchema(["unknown"]) }, [
  "observation",
]);
const dashboardCoverageDefinitionSchema = objectSchema(
  {
    configuration: configurationOutcomeSchema,
    coverage: verificationCoverageSchema,
    runtime: verificationRuntimeSchema,
    collection: nonEmptyStringSchema,
    scope: scopeSchema,
    percentage: { type: ["number", "null"] },
    appliedCount: integerSchema(),
    desiredCount: integerSchema(),
    driftedCount: integerSchema(),
    missingCount: integerSchema(),
    brokenLinkCount: integerSchema(),
    blockedCount: integerSchema(),
    targetsCount: integerSchema(),
    artifactsCount: integerSchema(),
    lastAppliedAt: nonEmptyStringSchema,
    emptyReason: stringSchema(),
  },
  [
    "configuration",
    "coverage",
    "runtime",
    "collection",
    "scope",
    "percentage",
    "appliedCount",
    "desiredCount",
    "driftedCount",
    "missingCount",
    "brokenLinkCount",
    "blockedCount",
    "targetsCount",
    "artifactsCount",
  ],
);
export type DashboardCoverageSchemaContract = AssertSchemaContract<
  ExactSchemaContract<typeof dashboardCoverageDefinitionSchema, DashboardCoverageGroup>
>;
const syncTargetUninstallTargetSchema = objectSchema(
  {
    consumerSet: stringArraySchema,
    proposedAction: enumSchema(["detach-consumer", "remove-target", "prune-mcp"]),
    after: stringSchema(),
    key: nonEmptyStringSchema,
    target: nonEmptyStringSchema,
    agent: nonEmptyStringSchema,
    scope: scopeSchema,
    capability: capabilitySchema,
    artifactIds: stringArraySchema,
    classification: enumSchema([
      "absent",
      "owned-current",
      "owned-drifted",
      "unowned-existing",
      "invalid-owner",
    ]),
    currentFingerprint: { type: ["string", "null"] },
    expectedReceiptFingerprint: nonEmptyStringSchema,
    blocked: booleanSchema,
    blockReason: stringSchema(),
    acknowledgement: targetAcknowledgementSchema,
    driftOverridden: booleanSchema,
    ownerSyncProfile: syncProfileTargetEvidenceSchema,
  },
  [
    "key",
    "target",
    "agent",
    "scope",
    "capability",
    "artifactIds",
    "classification",
    "currentFingerprint",
    "expectedReceiptFingerprint",
    "blocked",
    "driftOverridden",
  ],
);
const syncTargetUninstallConflictSchema = objectSchema(
  {
    code: enumSchema([
      "UNINSTALL_TARGET_DRIFTED",
      "UNINSTALL_TARGET_INVALID_OWNER",
      "UNINSTALL_TARGET_NOT_FOUND",
      "UNINSTALL_PROFILE_OWNER_MISMATCH",
    ]),
    key: nonEmptyStringSchema,
    target: nonEmptyStringSchema,
    message: stringSchema(),
    acknowledgement: targetAcknowledgementSchema,
  },
  ["code", "key", "target", "message"],
);
const mutationAuthorizationEnvelopeSchema = (domain: string): ClientJsonSchema =>
  objectSchema(
    {
      schemaVersion: { const: 1 },
      domain: { const: domain },
      algorithm: { const: "HMAC-SHA-256" },
      authorityId: nonEmptyStringSchema,
      authorityEpoch: integerSchema(1),
      seal: nonEmptyStringSchema,
    },
    ["schemaVersion", "domain", "algorithm", "authorityId", "authorityEpoch", "seal"],
  );
const durablePlanActionSchema = objectSchema(
  {
    actionId: nonEmptyStringSchema,
    kind: nonEmptyStringSchema,
    target: nonEmptyStringSchema,
    payloadDigest: nonEmptyStringSchema,
    payload: jsonDetailMapSchema,
    postcondition: targetStateReceiptSchema,
  },
  ["actionId", "kind", "target", "payloadDigest"],
);
const durableMutationPlanSchema = objectSchema(
  {
    schemaVersion: { const: 1 },
    planId: nonEmptyStringSchema,
    operation: enumSchema([
      "initialize",
      "apply",
      "revert",
      "settings",
      "secret-metadata",
      "store-import",
      "resource-lifecycle",
      "sync-uninstall",
      "sync-reconcile",
    ]),
    baseRevision: integerSchema(),
    normalizedInputsDigest: nonEmptyStringSchema,
    targetPreconditions: arraySchema(
      objectSchema(
        {
          actionId: nonEmptyStringSchema,
          target: nonEmptyStringSchema,
          expected: targetStateReceiptSchema,
        },
        ["actionId", "target", "expected"],
      ),
    ),
    actions: arraySchema(durablePlanActionSchema),
    externalEffects: arraySchema(inventorySecretAdoptionExternalEffectSchema),
    expires: {
      oneOf: [
        objectSchema({ policy: { const: "none" } }, ["policy"]),
        objectSchema({ policy: { const: "expires-at" }, expiresAt: nonEmptyStringSchema }, [
          "policy",
          "expiresAt",
        ]),
      ],
    },
    digest: nonEmptyStringSchema,
    durableDigest: nonEmptyStringSchema,
    authorization: mutationAuthorizationEnvelopeSchema("durable-plan-v1"),
  },
  [
    "schemaVersion",
    "planId",
    "operation",
    "baseRevision",
    "normalizedInputsDigest",
    "targetPreconditions",
    "actions",
    "expires",
    "digest",
    "durableDigest",
    "authorization",
  ],
);
const operationJournalSchema = objectSchema(
  {
    schemaVersion: { const: 1 },
    operationId: nonEmptyStringSchema,
    sequence: integerSchema(),
    previousJournalSeal: { type: ["string", "null"] },
    plan: durableMutationPlanSchema,
    nextRevision: integerSchema(),
    status: enumSchema([
      "prepared",
      "executing",
      "publishing-state",
      "completed",
      "recovery-required",
    ]),
    startedAt: nonEmptyStringSchema,
    updatedAt: nonEmptyStringSchema,
    actions: arraySchema({
      oneOf: [
        objectSchema(
          {
            actionId: nonEmptyStringSchema,
            target: nonEmptyStringSchema,
            status: { const: "pending" },
          },
          ["actionId", "target", "status"],
        ),
        objectSchema(
          {
            actionId: nonEmptyStringSchema,
            target: nonEmptyStringSchema,
            status: enumSchema(["succeeded", "failed"]),
            receipt: operationActionReceiptSchema,
          },
          ["actionId", "target", "status", "receipt"],
        ),
      ],
    }),
    externalEffects: arraySchema({
      oneOf: [
        objectSchema({ effectId: nonEmptyStringSchema, status: { const: "pending" } }, [
          "effectId",
          "status",
        ]),
        objectSchema(
          {
            effectId: nonEmptyStringSchema,
            status: { const: "succeeded" },
            evidence: inventorySecretAdoptionOrphanEvidenceSchema,
          },
          ["effectId", "status", "evidence"],
        ),
      ],
    }),
    statePublications: arraySchema(
      objectSchema(
        { path: nonEmptyStringSchema, digest: nonEmptyStringSchema, mode: integerSchema() },
        ["path", "digest"],
      ),
    ),
    completedReceipt: operationReceiptDataSchema,
    authorization: mutationAuthorizationEnvelopeSchema("operation-journal-v1"),
  },
  [
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
    "authorization",
  ],
);
const remoteResourceEvidenceSchema: ClientJsonSchema = {
  oneOf: [
    objectSchema(
      {
        type: { const: "git" },
        repositoryUrl: nonEmptyStringSchema,
        ref: nonEmptyStringSchema,
        commit: nonEmptyStringSchema,
        subpath: nonEmptyStringSchema,
      },
      ["type", "repositoryUrl", "ref", "commit", "subpath"],
    ),
    objectSchema(
      {
        type: { const: "url" },
        url: nonEmptyStringSchema,
        integrity: nonEmptyStringSchema,
        validators: objectSchema({
          etag: nonEmptyStringSchema,
          lastModified: nonEmptyStringSchema,
        }),
      },
      ["type", "url", "integrity"],
    ),
  ],
};
const resourceUpdateCheckSchema: ClientJsonSchema = {
  oneOf: [
    objectSchema(
      {
        status: { const: "uncheckable" },
        resourceId: nonEmptyStringSchema,
        currentRevisionId: nonEmptyStringSchema,
        reason: { const: "no-verifiable-remote-source" },
      },
      ["status", "resourceId", "currentRevisionId", "reason"],
    ),
    objectSchema(
      {
        status: enumSchema(["current", "update-available"]),
        resourceId: nonEmptyStringSchema,
        currentRevisionId: nonEmptyStringSchema,
        currentContentFingerprint: nonEmptyStringSchema,
        checkedAt: nonEmptyStringSchema,
        evidence: remoteResourceEvidenceSchema,
      },
      [
        "status",
        "resourceId",
        "currentRevisionId",
        "currentContentFingerprint",
        "checkedAt",
        "evidence",
      ],
    ),
  ],
};
const resourceUpdateDiffSchema = objectSchema(
  {
    type: { const: "resource-content" },
    resourceId: nonEmptyStringSchema,
    redacted: { const: true },
    files: arraySchema(
      objectSchema(
        {
          path: nonEmptyStringSchema,
          change: enumSchema(["added", "removed", "modified"]),
          beforeFingerprint: nonEmptyStringSchema,
          afterFingerprint: nonEmptyStringSchema,
        },
        ["path", "change"],
      ),
    ),
  },
  ["type", "resourceId", "redacted", "files"],
);
const stagedResourceUpdateSchema = objectSchema(
  {
    schemaVersion: { const: 1 },
    resourceId: nonEmptyStringSchema,
    kind: capabilitySchema,
    name: nonEmptyStringSchema,
    currentRevisionId: nonEmptyStringSchema,
    currentContentFingerprint: nonEmptyStringSchema,
    sourceEvidence: remoteResourceEvidenceSchema,
    stagedContentDigest: nonEmptyStringSchema,
    stagedBytes: integerSchema(),
    stagePath: nonEmptyStringSchema,
    stageFileDigest: nonEmptyStringSchema,
    validation: resourceValidationEvidenceSchema,
    diff: resourceUpdateDiffSchema,
  },
  [
    "schemaVersion",
    "resourceId",
    "kind",
    "name",
    "currentRevisionId",
    "currentContentFingerprint",
    "sourceEvidence",
    "stagedContentDigest",
    "stagedBytes",
    "stagePath",
    "stageFileDigest",
    "validation",
    "diff",
  ],
);

const appliedResourceLifecycleDataSchema = objectSchema(
  {
    plan: mutationPlanSchema,
    resource: nullableSchema(resourceRecordSchema),
    operation: operationResultDataSchema,
  },
  ["plan", "resource", "operation"],
);

const controlPlaneConfigDataSchema = cellarerConfigOutputSchema;

const verificationDataSchema = objectSchema(
  {
    storeRevision: integerSchema(),
    desiredVsApplied: objectSchema(
      {
        status: enumSchema(["converged", "diverged"]),
        items: arraySchema(desiredAppliedItemSchema),
      },
      ["status", "items"],
    ),
    appliedVsDisk: objectSchema(
      { status: enumSchema(["converged", "diverged"]), items: arraySchema(statusItemSchema) },
      ["status", "items"],
    ),
    recovery: mutationRecoveryPresentationSchema,
    healthy: booleanSchema,
    configuration: configurationOutcomeSchema,
    coverage: verificationCoverageSchema,
    runtime: verificationRuntimeSchema,
  },
  [
    "storeRevision",
    "desiredVsApplied",
    "appliedVsDisk",
    "recovery",
    "healthy",
    "configuration",
    "coverage",
    "runtime",
  ],
);

const dashboardSummaryDataSchema = objectSchema(
  {
    generatedAt: nonEmptyStringSchema,
    localSafety: objectSchema(
      {
        localOnly: { const: true },
        host: { const: "127.0.0.1" },
        database: { const: false },
        secrets: stringSchema({ pattern: "^masked$" }),
      },
      ["localOnly", "host", "database", "secrets"],
    ),
    scope: scopeSchema,
    dir: nonEmptyStringSchema,
    collections: stringArraySchema,
    capabilities: capabilityArraySchema,
    artifactCounts: objectSchema(
      {
        rules: integerSchema(),
        mcp: integerSchema(),
        skills: integerSchema(),
        total: integerSchema(),
      },
      ["rules", "mcp", "skills", "total"],
    ),
    agentCounts: objectSchema(
      {
        registered: integerSchema(),
        detected: integerSchema(),
        ready: integerSchema(),
        warning: integerSchema(),
        missing: integerSchema(),
      },
      ["registered", "detected", "ready", "warning", "missing"],
    ),
    driftCounts: objectSchema(
      {
        ok: integerSchema(),
        drifted: integerSchema(),
        missing: integerSchema(),
        "broken-link": integerSchema(),
      },
      ["ok", "drifted", "missing", "broken-link"],
    ),
    secretRefs: arraySchema(secretRefStatSchema),
    isEmptyStore: booleanSchema,
    agents: arraySchema(componentSchema("DashboardAgent")),
    distributionCoverage: arraySchema(componentSchema("DashboardCoverage")),
    driftItems: arraySchema(statusItemSchema),
    latestActivity: arraySchema(componentSchema("ActivityEvent")),
    warnings: stringArraySchema,
  },
  [
    "generatedAt",
    "localSafety",
    "scope",
    "collections",
    "capabilities",
    "artifactCounts",
    "agentCounts",
    "driftCounts",
    "secretRefs",
    "isEmptyStore",
    "agents",
    "distributionCoverage",
    "driftItems",
    "latestActivity",
    "warnings",
  ],
);
export type DashboardSummarySchemaContract = AssertSchemaContract<
  ExactSchemaContract<typeof dashboardSummaryDataSchema, DashboardSummaryResult>
>;

const settingsSummaryDataSchema = objectSchema(
  {
    storeRoot: nonEmptyStringSchema,
    cellarerHomeActive: booleanSchema,
    defaults: configDefaultsSchema,
    collections: arraySchema(
      objectSchema({ name: nonEmptyStringSchema, description: stringSchema() }, ["name"]),
    ),
    builtinAdapterIds: stringArraySchema,
    customAdapterIds: stringArraySchema,
    secretRefs: arraySchema(secretRefStatSchema),
  },
  [
    "storeRoot",
    "cellarerHomeActive",
    "defaults",
    "collections",
    "builtinAdapterIds",
    "customAdapterIds",
    "secretRefs",
  ],
);
export type SettingsSummarySchemaContract = AssertSchemaContract<
  ExactSchemaContract<typeof settingsSummaryDataSchema, SettingsSummary>
>;

const inventoryFindingSchema = objectSchema(
  {
    code: enumSchema([
      "ADAPTER_DETECTION_FAILED",
      "ADAPTER_PATHS_FAILED",
      "SOURCE_OUTSIDE_BOUNDARY",
      "SOURCE_UNREADABLE",
      "SOURCE_BUDGET_EXCEEDED",
      "UNSAFE_LINK",
      "UNSUPPORTED_SNAPSHOT",
      "SNAPSHOT_STALE",
      "INVALID_STRUCTURE",
      "INVALID_MANIFEST",
      "PARSE_FAILED",
      "PROBABLE_SECRET",
      "secret-adoption-required",
      "CONFLICT",
      "STORE_SNAPSHOT_STALE",
      "STORE_SNAPSHOT_UNSAFE",
      "STORE_PROJECTION_FAILED",
    ]),
    severity: enumSchema(["warning", "blocked"]),
    scope: enumSchema(["refresh", "source", "candidate"]),
    remediation: enumSchema([
      "review-adapter",
      "check-source-access",
      "remove-unsafe-link",
      "retry-refresh",
      "fix-structure",
      "remove-secret-values",
      "adopt-supported-secret",
      "resolve-conflict",
      "repair-store",
    ]),
    sourceId: nonEmptyStringSchema,
    adoption: inventorySecretAdoptionOfferSchema,
  },
  ["code", "severity", "scope", "remediation"],
);
const inventoryRelatedAdapterSchema = objectSchema(
  {
    id: agentIdSchema,
    displayName: nonEmptyStringSchema,
    enabled: booleanSchema,
    detected: booleanSchema,
  },
  ["id", "displayName", "enabled", "detected"],
);
const inventorySourceSchema = objectSchema(
  {
    id: nonEmptyStringSchema,
    kind: capabilitySchema,
    scope: scopeSchema,
    location: nonEmptyStringSchema,
    adapters: arraySchema(inventoryRelatedAdapterSchema),
  },
  ["id", "kind", "scope", "location", "adapters"],
);
const inventoryManagedMatchSchema = objectSchema(
  { resourceId: nonEmptyStringSchema, revisionId: nonEmptyStringSchema },
  ["resourceId", "revisionId"],
);
const inventoryCandidateSchema = objectSchema(
  {
    id: nonEmptyStringSchema,
    kind: capabilitySchema,
    name: nonEmptyStringSchema,
    contentFingerprint: stringSchema({ pattern: "^sha256:[0-9a-f]{64}$" }),
    state: enumSchema(["ready", "needs-attention", "in-store"]),
    defaultSelected: booleanSchema,
    sources: arraySchema(inventorySourceSchema),
    relatedAdapters: arraySchema(inventoryRelatedAdapterSchema),
    findings: arraySchema(inventoryFindingSchema),
    managedMatch: inventoryManagedMatchSchema,
    conflictGroupId: nonEmptyStringSchema,
  },
  [
    "id",
    "kind",
    "name",
    "contentFingerprint",
    "state",
    "defaultSelected",
    "sources",
    "relatedAdapters",
    "findings",
  ],
);
const inventoryCoverageSchema = objectSchema(
  {
    adapterId: agentIdSchema,
    sourceId: nonEmptyStringSchema,
    scope: scopeSchema,
    kind: capabilitySchema,
    location: stringSchema(),
    bounds: objectSchema(
      { maxDepth: integerSchema(), maxEntries: integerSchema(), maxBytes: integerSchema() },
      ["maxDepth", "maxEntries", "maxBytes"],
    ),
    dimension: enumSchema([
      "source",
      "plugins",
      "managed",
      "ancestors",
      "nested-projects",
      "native-expansion",
    ]),
    status: enumSchema(["observed", "excluded", "unavailable", "unknown"]),
    mode: enumSchema(["declared", "placement-only"]),
    reason: stringSchema(),
  },
  ["adapterId", "dimension", "status", "mode", "reason"],
);
const inventoryEffectiveResourceSchema = objectSchema(
  {
    candidateId: nonEmptyStringSchema,
    adapterId: agentIdSchema,
    sourceId: nonEmptyStringSchema,
    scope: scopeSchema,
    state: enumSchema(["effective", "shadowed", "ambiguous", "unknown"]),
    policy: enumSchema(["unknown", "ranked", "cumulative"]),
    reason: stringSchema(),
    evidence: stringSchema(),
  },
  ["candidateId", "adapterId", "sourceId", "scope", "state", "policy", "reason", "evidence"],
);
const inventoryRefreshDataSchema = objectSchema(
  {
    generatedAt: nonEmptyStringSchema,
    coverage: arraySchema(inventoryCoverageSchema),
    effectiveResources: arraySchema(inventoryEffectiveResourceSchema),
    resolutionContext: enumSchema(["user", "project"]),
    candidates: arraySchema(inventoryCandidateSchema),
    findings: arraySchema(inventoryFindingSchema),
    counts: objectSchema(
      {
        total: integerSchema(),
        ready: integerSchema(),
        needsAttention: integerSchema(),
        inStore: integerSchema(),
        observedSources: integerSchema(),
        failedSources: integerSchema(),
      },
      ["total", "ready", "needsAttention", "inStore", "observedSources", "failedSources"],
    ),
    completeness: enumSchema(["complete", "partial", "failed"]),
  },
  ["generatedAt", "candidates", "findings", "counts", "completeness"],
);
const inventoryStreamBase = {
  attempt: integerSchema(),
  sequence: integerSchema(),
};
const inventoryStreamEventSchema = {
  oneOf: [
    objectSchema(
      { type: { const: "started" }, ...inventoryStreamBase, totalSources: integerSchema() },
      ["type", "attempt", "sequence", "totalSources"],
    ),
    objectSchema(
      {
        type: { const: "progress" },
        ...inventoryStreamBase,
        completedSources: integerSchema(),
        totalSources: integerSchema(),
        candidates: arraySchema(
          objectSchema(
            {
              id: nonEmptyStringSchema,
              kind: capabilitySchema,
              sourceCount: integerSchema(),
              sources: arraySchema(inventorySourceSchema),
            },
            ["id", "kind", "sourceCount", "sources"],
          ),
        ),
        findingCodes: arraySchema(inventoryFindingSchema.properties?.code ?? stringSchema()),
      },
      [
        "type",
        "attempt",
        "sequence",
        "completedSources",
        "totalSources",
        "candidates",
        "findingCodes",
      ],
    ),
    objectSchema({ type: { const: "reset" }, ...inventoryStreamBase }, [
      "type",
      "attempt",
      "sequence",
    ]),
    objectSchema(
      { type: { const: "completed" }, ...inventoryStreamBase, result: inventoryRefreshDataSchema },
      ["type", "attempt", "sequence", "result"],
    ),
    objectSchema(
      {
        type: { const: "failed" },
        ...inventoryStreamBase,
        code: enumSchema(["INTERNAL_ERROR", "CANCELLED"]),
      },
      ["type", "attempt", "sequence", "code"],
    ),
  ],
} as const satisfies ClientJsonSchema;
export type InventoryStreamSchemaContract = AssertSchemaContract<
  ExactSchemaContract<typeof inventoryStreamEventSchema, InventoryStreamEvent>
>;
const inventoryRefreshWithCompletenessSchema = <
  const Completeness extends "complete" | "partial" | "failed",
>(
  completeness: Completeness,
) =>
  objectSchema(
    {
      ...(inventoryRefreshDataSchema.properties ?? {}),
      completeness: { const: completeness },
    },
    ["generatedAt", "candidates", "findings", "counts", "completeness"],
  );
const postCommitInventoryRetryCommandSchema = stringSchema({
  minLength: 1,
  pattern: `^cellarer inventory refresh --agent ${AGENT_ID_PATTERN.slice(1, -1)}$`,
});
const postCommitInventoryRefreshDataSchema = {
  oneOf: [
    objectSchema(
      {
        agentId: agentIdSchema,
        status: { const: "complete" },
        inventory: inventoryRefreshWithCompletenessSchema("complete"),
      },
      ["agentId", "status", "inventory"],
    ),
    objectSchema(
      {
        agentId: agentIdSchema,
        status: { const: "partial" },
        inventory: inventoryRefreshWithCompletenessSchema("partial"),
        retryCommand: postCommitInventoryRetryCommandSchema,
      },
      ["agentId", "status", "inventory", "retryCommand"],
    ),
    objectSchema(
      {
        agentId: agentIdSchema,
        status: { const: "failed" },
        inventory: inventoryRefreshWithCompletenessSchema("failed"),
        retryCommand: postCommitInventoryRetryCommandSchema,
      },
      ["agentId", "status", "inventory", "retryCommand"],
    ),
  ],
} as const satisfies ClientJsonSchema;
const appliedControlPlaneMutationDataSchema = objectSchema(
  {
    plan: mutationPlanSchema,
    changedFields: stringArraySchema,
    operation: operationResultDataSchema,
    mutation: mutationPresentationDataSchema,
    receipt: operationReceiptDataSchema,
    postCommitInventoryRefresh: postCommitInventoryRefreshDataSchema,
  },
  ["plan", "changedFields", "operation", "mutation"],
);
const inventoryStoreImportPlanDataSchema = objectSchema(
  {
    inventory: inventoryRefreshDataSchema,
    candidateIds: stringArraySchema,
    mutationPlan: mutationPlanSchema,
  },
  ["inventory", "candidateIds", "mutationPlan"],
);
const inventoryStoreImportApplyDataSchema = objectSchema(
  {
    mutationPlan: mutationPlanSchema,
    candidateIds: stringArraySchema,
    resourceIds: stringArraySchema,
    operation: operationResultDataSchema,
    warnings: stringArraySchema,
  },
  ["mutationPlan", "candidateIds", "resourceIds", "operation", "warnings"],
);
const inventorySecretAdoptionPlanDataSchema = objectSchema(
  {
    inventory: inventoryRefreshDataSchema,
    candidateId: nonEmptyStringSchema,
    selector: inventorySecretFieldSelectorSchema,
    provider: inventorySecretAdoptionProviderSchema,
    targetName: nonEmptyStringSchema,
    mutationPlan: mutationPlanSchema,
  },
  ["inventory", "candidateId", "selector", "provider", "targetName", "mutationPlan"],
);
const inventorySecretAdoptionApplyDataSchema = objectSchema(
  {
    mutationPlan: mutationPlanSchema,
    candidateId: nullableSchema(nonEmptyStringSchema),
    provider: nullableSchema(inventorySecretAdoptionProviderSchema),
    targetName: nullableSchema(nonEmptyStringSchema),
    status: enumSchema([
      "applied",
      "rejected",
      "provider-precondition-conflict",
      "orphaned-reference",
    ]),
    operation: operationResultDataSchema,
    orphan: inventorySecretAdoptionOrphanEvidenceSchema,
  },
  ["mutationPlan", "candidateId", "provider", "targetName", "status", "operation"],
);
export type InventoryRefreshSchemaContract = AssertSchemaContract<
  ExactSchemaContract<typeof inventoryRefreshDataSchema, InventoryRefreshResult>
>;

const mutationRecoveryDiagnosisDataSchema = objectSchema(
  {
    status: enumSchema([
      "clean",
      "incomplete",
      "completed-pending-cleanup",
      "manual-recovery-required",
    ]),
    journal: nullableSchema(operationJournalSchema),
    lockOwner: nullableSchema(lockOwnerEvidenceSchema),
    recoveryLockOwner: nullableSchema(lockOwnerEvidenceSchema),
    receipt: nullableSchema(operationReceiptDataSchema),
    orphanEvidence: inventorySecretAdoptionOrphanEvidenceSchema,
    message: stringSchema(),
  },
  ["status", "journal", "lockOwner", "recoveryLockOwner", "receipt", "message"],
);

const openApiDocumentDataSchema = objectSchema(
  {
    openapi: { const: "3.1.0" },
    info: objectSchema({ title: nonEmptyStringSchema, version: { const: CLIENT_API_VERSION } }, [
      "title",
      "version",
    ]),
    jsonSchemaDialect: { const: JSON_SCHEMA_DIALECT },
    paths: jsonDetailMapSchema,
    components: objectSchema(
      { securitySchemes: jsonDetailMapSchema, schemas: jsonDetailMapSchema },
      ["securitySchemes", "schemas"],
    ),
    "x-cellarer-authentication-modes": arraySchema(enumSchema(["bearer", "browser-session"])),
    "x-cellarer-active-authentication-mode": enumSchema([
      "bearer",
      "browser-session",
      "contract-discovery",
    ]),
    "x-cellarer-browser-session-policy": objectSchema(
      {
        bootstrapPath: { const: "/api/v1/auth/session" },
        cookieName: { const: "cellarer_session" },
        httpOnly: { const: true },
        sameSite: { const: "Strict" },
        mutationOrigin: { const: "exact-loopback-origin" },
      },
      ["bootstrapPath", "cookieName", "httpOnly", "sameSite", "mutationOrigin"],
    ),
  },
  [
    "openapi",
    "info",
    "jsonSchemaDialect",
    "paths",
    "components",
    "x-cellarer-authentication-modes",
    "x-cellarer-active-authentication-mode",
    "x-cellarer-browser-session-policy",
  ],
);

function successDataSchemaFor(operationId: string): ClientJsonSchema {
  switch (operationId) {
    case "planDeploymentBaseline":
      return objectSchema({ value: jsonDetailMapSchema, plan: mutationPlanSchema }, [
        "value",
        "plan",
      ]);
    case "applyDeploymentBaseline":
      return objectSchema(
        {
          plan: mutationPlanSchema,
          changedFields: stringArraySchema,
          operation: operationResultDataSchema,
        },
        ["plan", "changedFields", "operation"],
      );
    case "getHealth":
      return objectSchema({ live: booleanSchema }, ["live"]);
    case "bootstrapBrowserSession":
      return objectSchema(
        { authenticated: { const: true }, authMode: { const: "browser-session" } },
        ["authenticated", "authMode"],
      );
    case "getVersion":
      return objectSchema(
        {
          apiVersion: { const: CLIENT_API_VERSION },
          contractId: { const: CLIENT_API_CONTRACT_ID },
        },
        ["apiVersion", "contractId"],
      );
    case "getCapabilities":
      return objectSchema(
        {
          apiVersion: { const: CLIENT_API_VERSION },
          contractId: { const: CLIENT_API_CONTRACT_ID },
          operations: stringArraySchema,
        },
        ["apiVersion", "contractId", "operations"],
      );
    case "getReadiness":
      return objectSchema(
        {
          ready: booleanSchema,
          blockers: arraySchema(
            objectSchema(
              {
                code: enumSchema([
                  "STORE_NOT_READY",
                  "MUTATION_AUTHORITY_UNAVAILABLE",
                  "MUTATION_AUTHORITY_NOT_CURRENT",
                  "MUTATION_LOCKED",
                  "RECOVERY_REQUIRED",
                ]),
                operationId: nonEmptyStringSchema,
              },
              ["code"],
            ),
          ),
        },
        ["ready", "blockers"],
      );
    case "getOpenApi":
      return openApiDocumentDataSchema;
    case "listResources":
    case "listResourcesByKind":
      return controlPlaneResourceListDataSchema;
    case "listAgents":
      return controlPlaneAgentListDataSchema;
    case "showAgent":
      return objectSchema(
        { agent: nullableSchema(componentSchema("Agent")), warnings: stringArraySchema },
        ["agent", "warnings"],
      );
    case "planAgentMutation":
    case "planCollectionMutation":
    case "planSettingsMutation":
      return plannedControlPlaneMutationDataSchema;
    case "listCollections":
      return objectSchema(
        { revision: integerSchema(), collections: arraySchema(componentSchema("Collection")) },
        ["revision", "collections"],
      );
    case "showCollection":
      return objectSchema(
        { revision: integerSchema(), collection: nullableSchema(componentSchema("Collection")) },
        ["revision", "collection"],
      );
    case "applyControlPlaneMutation":
      return appliedControlPlaneMutationDataSchema;
    case "planSync":
      return objectSchema({ plan: distributePlanDataSchema, mutationPlan: mutationPlanSchema }, [
        "plan",
        "mutationPlan",
      ]);
    case "applySync":
      return applyMutationDataSchema;
    case "listProfiles":
      return objectSchema({ profiles: arraySchema(componentSchema("SyncProfile")) }, ["profiles"]);
    case "showProfile":
      return objectSchema({ profile: nullableSchema(componentSchema("SyncProfile")) }, ["profile"]);
    case "planProfileMutation":
      return objectSchema(
        {
          profile: nullableSchema(componentSchema("SyncProfile")),
          plan: mutationPlanSchema,
          operation: operationResultDataSchema,
        },
        ["profile", "plan"],
      );
    case "applyProfileMutation":
      return objectSchema({ plan: mutationPlanSchema, operation: operationResultDataSchema }, [
        "plan",
        "operation",
      ]);
    case "showConfig":
      return objectSchema({ revision: integerSchema(), config: controlPlaneConfigDataSchema }, [
        "revision",
        "config",
      ]);
    case "getSettings":
      return settingsSummaryDataSchema;
    case "validateConfig":
      return objectSchema(
        {
          valid: booleanSchema,
          config: controlPlaneConfigDataSchema,
          issues: arraySchema(validationIssueSchema),
        },
        ["valid", "issues"],
      );
    case "refreshInventory":
    case "refreshInventoryByAgent":
      return inventoryRefreshDataSchema;
    case "streamInventory":
      return inventoryStreamEventSchema;
    case "planInventoryStoreImport":
      return inventoryStoreImportPlanDataSchema;
    case "applyInventoryStoreImport":
      return inventoryStoreImportApplyDataSchema;
    case "planInventorySecretAdoption":
      return inventorySecretAdoptionPlanDataSchema;
    case "applyInventorySecretAdoption":
      return inventorySecretAdoptionApplyDataSchema;
    case "getDiff":
      return objectSchema(
        {
          storeRevision: integerSchema(),
          status: enumSchema(["converged", "diverged"]),
          items: arraySchema(desiredAppliedItemSchema),
        },
        ["storeRevision", "status", "items"],
      );
    case "getStatus":
      return statusListDataSchema;
    case "getVerification":
      return verificationDataSchema;
    case "getSummary":
      return dashboardSummaryDataSchema;
    case "listActivity":
      return activityListDataSchema;
    case "listOperations":
      return objectSchema({ operations: arraySchema(componentSchema("OperationSummary")) }, [
        "operations",
      ]);
    case "showOperation":
      return objectSchema(
        {
          operation: nullableSchema(
            objectSchema(
              {
                ...(operationReceiptDefinitionSchema.properties ?? {}),
                recoveryStatus: enumSchema(["clean", "manual-recovery-required"]),
              },
              [...(operationReceiptDefinitionSchema.required ?? []), "recoveryStatus"],
            ),
          ),
        },
        ["operation"],
      );
    case "planRevertMutation":
      return objectSchema({ plan: revertPlanDataSchema, mutationPlan: mutationPlanSchema }, [
        "plan",
        "mutationPlan",
      ]);
    case "applyRevertMutation":
      return objectSchema(
        {
          plan: revertPlanDataSchema,
          reverted: arraySchema(componentSchema("LedgerEntry")),
          failures: arraySchema(componentSchema("RevertFailure")),
          warnings: stringArraySchema,
          mutation: mutationPresentationDataSchema,
          operation: operationResultDataSchema,
        },
        ["plan", "reverted", "failures", "warnings", "mutation", "operation"],
      );
    case "getMutationRecovery":
      return mutationRecoveryDiagnosisDataSchema;
    case "applyMutationRecovery":
      return objectSchema({ operation: operationResultDataSchema }, ["operation"]);
    case "getResourceDependencies":
      return resourceDependencyReportSchema;
    case "checkResourceUpdate":
      return resourceUpdateCheckSchema;
    case "planResourceUpdate":
      return objectSchema(
        {
          plan: mutationPlanSchema,
          resource: resourceRecordSchema,
          diff: resourceUpdateDiffSchema,
          check: resourceUpdateCheckSchema,
          candidate: stagedResourceUpdateSchema,
        },
        ["plan", "resource", "diff", "check", "candidate"],
      );
    case "applyResourceUpdate":
    case "applyResourceRename":
    case "applyResourceRemove":
    case "applyResourceExport":
    case "applyResourceBundleImport":
      return appliedResourceLifecycleDataSchema;
    case "planResourceRename":
    case "planResourceRemove":
      return objectSchema(
        {
          plan: mutationPlanSchema,
          blocked: stringArraySchema,
          dependencyReport: resourceDependencyReportSchema,
          resource: nullableSchema(resourceRecordSchema),
        },
        ["plan", "blocked", "resource"],
      );
    case "planResourceExport":
    case "planResourceBundleImport":
      return objectSchema(
        {
          plan: mutationPlanSchema,
          bundleDigest: nonEmptyStringSchema,
          resource: resourceRecordSchema,
        },
        ["plan", "bundleDigest", "resource"],
      );
    case "validateResourceBundle":
      return objectSchema(
        {
          resource: resourceRecordSchema,
          bundleDigest: nonEmptyStringSchema,
          contentFingerprint: nonEmptyStringSchema,
        },
        ["resource", "bundleDigest", "contentFingerprint"],
      );
    case "planSyncProfileInvocation":
      return objectSchema(
        {
          plan: distributePlanDataSchema,
          mutationPlan: mutationPlanSchema,
          profile: componentSchema("SyncProfile"),
          workspaceRoot: { type: ["string", "null"] },
          resolvedAgents: stringArraySchema,
          resolvedResources: arraySchema(resolvedSyncProfileResourceSchema),
        },
        ["plan", "mutationPlan", "profile", "workspaceRoot", "resolvedAgents", "resolvedResources"],
      );
    case "applySyncProfileInvocation":
      return objectSchema(
        {
          ...(applyMutationDataSchema.properties ?? {}),
          profileId: nonEmptyStringSchema,
        },
        [...(applyMutationDataSchema.required ?? []), "profileId"],
      );
    case "verifySyncProfileInvocation":
      return objectSchema(
        {
          ...(verificationDataSchema.properties ?? {}),
          profileId: nonEmptyStringSchema,
          profileRevision: nonEmptyStringSchema,
          resolvedResources: arraySchema(resolvedSyncProfileResourceSchema),
        },
        [
          ...(verificationDataSchema.required ?? []),
          "profileId",
          "profileRevision",
          "resolvedResources",
        ],
      );
    case "planSyncProfileUninstall":
      return objectSchema(
        {
          targets: arraySchema(syncTargetUninstallTargetSchema),
          conflicts: arraySchema(syncTargetUninstallConflictSchema),
          mutationPlan: mutationPlanSchema,
          profile: componentSchema("SyncProfile"),
          targetKeys: stringArraySchema,
        },
        ["targets", "conflicts", "mutationPlan", "profile", "targetKeys"],
      );
    case "applySyncProfileUninstall":
      return objectSchema(
        {
          targets: arraySchema(syncTargetUninstallTargetSchema),
          conflicts: arraySchema(syncTargetUninstallConflictSchema),
          mutationPlan: mutationPlanSchema,
          uninstalled: arraySchema(componentSchema("LedgerEntry")),
          operation: operationResultDataSchema,
        },
        ["targets", "conflicts", "mutationPlan", "uninstalled", "operation"],
      );
    default:
      throw new TypeError(`missing success data schema for ${operationId}`);
  }
}

export const CLIENT_API_ROUTES: readonly ClientApiRouteDefinition[] = CLIENT_API_ROUTE_BASES.map(
  (route) => {
    const dataSchema = successDataSchemaFor(route.operationId);
    return {
      ...route,
      inputSchema: inputSchemaFor(route),
      outputSchema:
        route.operationId === "streamInventory" ? dataSchema : resultEnvelopeSchema(dataSchema),
      httpStatusMappings: statusMappingsFor(route),
    };
  },
);

function statusMappingsFor(
  route: ClientApiRouteBaseDefinition,
): readonly ClientApiHttpStatusMapping[] {
  const mappings: ClientApiHttpStatusMapping[] = [{ status: 200, outcome: "success" }];
  if (route.operationId === "getReadiness") {
    mappings.push({ status: 503, outcome: "success" });
  }
  if (
    (route.method === "post" && route.requestBody !== "none") ||
    Object.keys(querySchemaFor(route.operationId).properties ?? {}).length > 0
  ) {
    mappings.push({
      status: 400,
      outcome: "error",
      errorCodes: ["INVALID_INPUT", "DOMAIN_VALIDATION_FAILED"],
    });
  }
  if (route.authentication === "browser-bootstrap") {
    mappings.push({ status: 403, outcome: "error", errorCodes: ["POLICY_VIOLATION"] });
  } else if (route.authentication !== "public") {
    mappings.push(
      { status: 401, outcome: "error", errorCodes: ["POLICY_VIOLATION"] },
      { status: 403, outcome: "error", errorCodes: ["POLICY_VIOLATION"] },
    );
  }
  if (route.method === "post" && route.requestBody !== "none") {
    mappings.push({
      status: 413,
      outcome: "error",
      errorCodes: ["DOMAIN_VALIDATION_FAILED"],
    });
  }
  if (route.operationId.startsWith("apply")) {
    mappings.push({
      status: 409,
      outcome: "error",
      errorCodes: ["STALE_REVISION", "LOCK_CONFLICT", "TARGET_CONFLICT", "RECOVERY_REQUIRED"],
    });
  }
  mappings.push({
    status: 500,
    outcome: "error",
    errorCodes: route.operationId.startsWith("apply")
      ? ["EXECUTION_FAILED", "PARTIAL_FAILURE", "INTERNAL_ERROR"]
      : ["INTERNAL_ERROR"],
  });
  return mappings.sort((left, right) => left.status - right.status);
}

function createMutationPlanSchema() {
  const targetState = {
    oneOf: [
      objectSchema({ state: { const: "absent" } }, ["state"]),
      objectSchema(
        {
          state: { const: "present" },
          fingerprint: nonEmptyStringSchema,
          recoverySnapshot: nonEmptyStringSchema,
          recoverySnapshotDigest: nonEmptyStringSchema,
          recoverySnapshotMode: integerSchema(),
        },
        ["state", "fingerprint"],
      ),
    ],
  } satisfies ClientJsonSchema;
  const actionPrecondition = objectSchema(
    {
      actionId: nonEmptyStringSchema,
      target: nonEmptyStringSchema,
      expected: targetState,
    },
    ["actionId", "target", "expected"],
  );
  const action = objectSchema(
    {
      actionId: nonEmptyStringSchema,
      kind: nonEmptyStringSchema,
      target: nonEmptyStringSchema,
      payload: jsonDetailMapSchema,
      postcondition: targetState,
    },
    ["actionId", "kind", "target", "payload"],
  );
  const expiry = {
    oneOf: [
      objectSchema({ policy: { const: "none" } }, ["policy"]),
      objectSchema({ policy: { const: "expires-at" }, expiresAt: nonEmptyStringSchema }, [
        "policy",
        "expiresAt",
      ]),
    ],
  } satisfies ClientJsonSchema;
  const authorization = objectSchema(
    {
      schemaVersion: { const: 1 },
      domain: { const: "executable-plan-v1" },
      algorithm: { const: "HMAC-SHA-256" },
      authorityId: nonEmptyStringSchema,
      authorityEpoch: integerSchema(1),
      seal: stringSchema({ pattern: "^hmac-sha256:[0-9a-f]{64}$" }),
    },
    ["schemaVersion", "domain", "algorithm", "authorityId", "authorityEpoch", "seal"],
  );
  return objectSchema(
    {
      schemaVersion: { const: 1 },
      planId: nonEmptyStringSchema,
      operation: enumSchema([
        "initialize",
        "apply",
        "revert",
        "settings",
        "secret-metadata",
        "store-import",
        "resource-lifecycle",
        "sync-uninstall",
        "sync-reconcile",
      ]),
      baseRevision: integerSchema(),
      normalizedInputs: jsonDetailMapSchema,
      targetPreconditions: arraySchema(actionPrecondition),
      actions: arraySchema(action),
      expires: expiry,
      digest: stringSchema({ pattern: "^sha256:[0-9a-f]{64}$" }),
      authorization,
    },
    [
      "schemaVersion",
      "planId",
      "operation",
      "baseRevision",
      "normalizedInputs",
      "targetPreconditions",
      "actions",
      "expires",
      "digest",
      "authorization",
    ],
  );
}

export function createClientOpenApiDocument(
  activeAuthenticationMode?: ClientOpenApiAuthenticationMode,
): Readonly<Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of CLIENT_API_ROUTES) {
    const inputProperties = route.inputSchema.properties ?? {};
    const parameters = [
      ...openApiParameters(inputProperties.path, "path"),
      ...openApiParameters(inputProperties.query, "query"),
    ];
    const bodySchema = inputProperties.body;
    const pathItem = paths[route.path] ?? {};
    pathItem[route.method] = {
      operationId: route.operationId,
      summary: route.summary,
      security:
        route.authentication === "public" || route.authentication === "browser-bootstrap"
          ? []
          : activeAuthenticationMode === "bearer"
            ? [{ localManagedClientAuth: [] }]
            : activeAuthenticationMode === "browser-session"
              ? [{ localBrowserSession: [] }]
              : [{ localManagedClientAuth: [] }, { localBrowserSession: [] }],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(bodySchema
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: bodySchema } },
            },
          }
        : {}),
      responses: Object.fromEntries(
        route.httpStatusMappings.map((mapping) => [
          String(mapping.status),
          {
            description:
              mapping.outcome === "success" ? "Versioned client success" : "Typed client error",
            content: {
              [route.operationId === "streamInventory" && mapping.outcome === "success"
                ? "application/x-ndjson"
                : "application/json"]: {
                schema:
                  mapping.outcome === "success"
                    ? route.operationId === "streamInventory"
                      ? route.outputSchema
                      : successSchemaFromResult(route.outputSchema)
                    : errorEnvelopeSchema,
              },
            },
            ...(mapping.errorCodes ? { "x-cellarer-error-codes": mapping.errorCodes } : {}),
          },
        ]),
      ),
      "x-cellarer-authentication": route.authentication,
      "x-cellarer-input-schema": route.inputSchema,
      "x-cellarer-output-schema": route.outputSchema,
    };
    paths[route.path] = pathItem;
  }
  return createSafeObservableOpenApiDocument({
    openapi: "3.1.0",
    info: { title: "cellarer local client API", version: CLIENT_API_VERSION },
    jsonSchemaDialect: JSON_SCHEMA_DIALECT,
    paths,
    components: {
      securitySchemes: {
        localManagedClientAuth: { type: "http", scheme: "bearer" },
        localBrowserSession: { type: "apiKey", in: "cookie", name: "cellarer_session" },
      },
      schemas: {
        JsonValue: jsonValueDefinitionSchema,
        ClientWarning: warningSchema,
        ClientError: errorSchema,
        ClientSuccessResult: successEnvelopeSchema(jsonDetailMapSchema),
        ClientErrorResult: errorEnvelopeSchema,
        ClientResult: {
          $id: CLIENT_API_CONTRACT_ID,
          $schema: JSON_SCHEMA_DIALECT,
          ...resultEnvelopeSchema(jsonDetailMapSchema),
        },
        MutationPlan: mutationPlanDefinitionSchema,
        DistributePlan: distributePlanDefinitionSchema,
        MutationConflict: mutationConflictDataSchema,
        OperationReceipt: operationReceiptDefinitionSchema,
        OperationResult: operationResultDefinitionSchema,
        Resource: resourceDtoDefinitionSchema,
        Agent: agentDtoDefinitionSchema,
        Collection: collectionDtoDefinitionSchema,
        SyncProfile: syncProfileDefinitionSchema,
        ActivityEvent: activityEventDefinitionSchema,
        OperationSummary: operationSummaryDefinitionSchema,
        LedgerEntry: ledgerEntrySchema,
        ApplyFailure: applyFailureSchema,
        RevertFailure: revertFailureSchema,
        RevertTarget: revertTargetDefinitionSchema,
        DashboardAgent: dashboardAgentDefinitionSchema,
        DashboardCoverage: dashboardCoverageDefinitionSchema,
        OperationJournal: operationJournalSchema,
      },
    },
    "x-cellarer-authentication-modes": ["bearer", "browser-session"],
    "x-cellarer-active-authentication-mode": activeAuthenticationMode ?? "contract-discovery",
    "x-cellarer-browser-session-policy": {
      bootstrapPath: "/api/v1/auth/session",
      cookieName: "cellarer_session",
      httpOnly: true,
      sameSite: "Strict",
      mutationOrigin: "exact-loopback-origin",
    },
  });
}

function successSchemaFromResult(resultSchema: ClientJsonSchema): ClientJsonSchema {
  return resultSchema.oneOf?.[0] ?? resultSchema;
}

function openApiParameters(
  schema: ClientJsonSchema | undefined,
  location: "path" | "query",
): readonly Readonly<Record<string, unknown>>[] {
  if (!schema?.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, propertySchema]) => ({
    name,
    in: location,
    required: location === "path" || required.has(name),
    schema: propertySchema,
  }));
}
