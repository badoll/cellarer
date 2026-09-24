import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createRealEnv,
  type Env,
  initializeStore,
  parseAdapterBodyConfig,
  validateControlPlaneConfig,
} from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLIENT_API_ROUTES,
  type ClientApiMethod,
  createClientOpenApiDocument,
} from "../src/api-contract.js";
import { createApp } from "../src/app.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

interface JsonSchema {
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly exclusiveMaximum?: number;
  readonly exclusiveMinimum?: number;
  readonly maximum?: number;
  readonly maxItems?: number;
  readonly maxLength?: number;
  readonly maxProperties?: number;
  readonly minItems?: number;
  readonly minLength?: number;
  readonly minProperties?: number;
  readonly minimum?: number;
  readonly multipleOf?: number;
  readonly pattern?: string;
  readonly propertyNames?: JsonSchema;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly if?: JsonSchema;
  readonly then?: JsonSchema;
  readonly not?: JsonSchema;
  readonly uniqueItems?: boolean;
  readonly $ref?: string;
}

const forbiddenJsonValueNarrowingKeywords = [
  "const",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maximum",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minimum",
  "minItems",
  "minLength",
  "minProperties",
  "multipleOf",
  "pattern",
  "propertyNames",
  "required",
  "uniqueItems",
] as const;

function assertExactJsonValueSchemaKeys(
  schema: JsonSchema,
  expected: readonly (keyof JsonSchema)[],
  path: string,
): void {
  const actual = Object.keys(schema).sort();
  const allowed = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(allowed)) {
    throw new Error(`${path}: expected only ${allowed.join(", ")}; received ${actual.join(", ")}`);
  }
}

function assertJsonValueReference(schema: JsonSchema | undefined, path: string): void {
  if (schema === undefined) throw new Error(`${path}: missing recursive JsonValue reference`);
  assertExactJsonValueSchemaKeys(schema, ["$ref"], path);
  if (schema.$ref !== "#/components/schemas/JsonValue") {
    throw new Error(`${path}: must recursively reference JsonValue`);
  }
}

function assertCanonicalJsonValueSchema(schema: JsonSchema): void {
  assertExactJsonValueSchemaKeys(schema, ["oneOf"], "JsonValue");
  if (schema.oneOf?.length !== 3) {
    throw new Error("JsonValue: expected scalar, array, and object variants");
  }
  const [scalar, array, object] = schema.oneOf;
  if (scalar === undefined || array === undefined || object === undefined) {
    throw new Error("JsonValue: missing canonical variant");
  }

  assertExactJsonValueSchemaKeys(scalar, ["type"], "JsonValue.scalar");
  if (JSON.stringify(scalar.type) !== JSON.stringify(["string", "number", "boolean", "null"])) {
    throw new Error("JsonValue.scalar: unexpected scalar type set or order");
  }

  assertExactJsonValueSchemaKeys(array, ["items", "type"], "JsonValue.array");
  if (array.type !== "array") throw new Error("JsonValue.array: expected array type");
  assertJsonValueReference(array.items, "JsonValue.array.items");

  assertExactJsonValueSchemaKeys(
    object,
    ["additionalProperties", "properties", "type"],
    "JsonValue.object",
  );
  if (object.type !== "object") throw new Error("JsonValue.object: expected object type");
  if (object.properties === undefined || Object.keys(object.properties).length !== 0) {
    throw new Error("JsonValue.object: properties must remain exactly empty");
  }
  if (typeof object.additionalProperties !== "object") {
    throw new Error("JsonValue.object: additionalProperties must be the recursive schema");
  }
  assertJsonValueReference(object.additionalProperties, "JsonValue.object.additionalProperties");
}

function schemaContainsKeyword(value: unknown, keyword: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (!Array.isArray(value) && Object.hasOwn(value, keyword)) return true;
  return Object.values(value).some((child) => schemaContainsKeyword(child, keyword));
}

interface RuntimeRouteDefinition {
  readonly operationId: string;
  readonly method: ClientApiMethod;
  readonly path: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly httpStatusMappings: readonly {
    readonly status: number;
    readonly outcome: "success" | "error";
    readonly errorCodes?: readonly string[];
  }[];
}

interface GoldenCase {
  readonly status: number;
  readonly body: unknown;
}

describe("local client route registry", () => {
  let root: string;
  let storeRoot: string;
  let env: Env;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-api-registry-")));
    storeRoot = join(root, "home", ".cellarer");
    const real = createRealEnv();
    env = {
      ...real,
      homedir: () => join(root, "home"),
      cwd: () => join(root, "cwd"),
      now: () => new Date("2026-08-10T12:00:00.000Z"),
      randomId: () => "generated-request",
      mutationAuthority: deterministicMutationAuthority(),
    };
    await env.fs.mkdir(join(storeRoot, "store", "rules"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("matches the exact golden success, domain-error, and redacted internal-error envelopes", async () => {
    const golden = JSON.parse(
      await fs.readFile(new URL("./fixtures/local-client-api-v1.json", import.meta.url), "utf8"),
    ) as Record<string, GoldenCase>;
    const failingEnv: Env = {
      ...env,
      fs: {
        ...env.fs,
        readdir: async () => {
          throw new Error("canary-private-stack-and-path");
        },
      },
    };
    const cases = [
      {
        name: "version",
        response: await createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } }).request(
          "/api/v1/version",
          {
            headers: { "x-request-id": "req-golden-version" },
          },
        ),
      },
      {
        name: "validationError",
        response: await createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } }).request(
          "/api/v1/resources/not-a-kind",
          {
            headers: { "x-request-id": "req-golden-validation" },
          },
        ),
      },
      {
        name: "internalError",
        response: await createApp({
          env: failingEnv,
          storeRoot,
          auth: { mode: "trusted-embedded" },
        }).request("/api/v1/resources/rules", {
          headers: { "x-request-id": "req-golden-internal" },
        }),
      },
    ];

    for (const testCase of cases) {
      const expected = golden[testCase.name];
      expect(expected).toBeDefined();
      const text = await testCase.response.text();
      expect(testCase.response.status).toBe(expected?.status);
      expect(JSON.parse(text)).toEqual(expected?.body);
      expect(text).not.toContain("canary-private-stack-and-path");
    }
  });

  it("replaces an invalid supplied request identifier with a valid generated identifier", async () => {
    const response = await createApp({
      env,
      storeRoot,
      auth: { mode: "trusted-embedded" },
    }).request("/api/v1/version", {
      headers: { "x-request-id": "invalid request id with spaces" },
    });

    expect(await response.json()).toMatchObject({ requestId: "req-generated-request" });
  });

  it("declares closed input/output schemas and stable HTTP mappings for every operation", () => {
    const routes = CLIENT_API_ROUTES as unknown as readonly RuntimeRouteDefinition[];
    for (const route of routes) {
      expect(route.inputSchema, `${route.operationId} input schema`).toBeDefined();
      expect(route.outputSchema, `${route.operationId} output schema`).toBeDefined();
      expect(route.httpStatusMappings, `${route.operationId} HTTP mappings`).not.toEqual([]);
      assertClosedJsonSchema(route.inputSchema, `${route.operationId}.input`);
      assertClosedJsonSchema(route.outputSchema, `${route.operationId}.output`);
    }
  });

  it("publishes request bodies, typed error statuses, and closed route schemas in OpenAPI 3.1", () => {
    const document = createClientOpenApiDocument() as {
      readonly paths: Record<
        string,
        Record<
          string,
          {
            readonly requestBody?: unknown;
            readonly responses: Record<string, unknown>;
            readonly "x-cellarer-input-schema"?: JsonSchema;
            readonly "x-cellarer-output-schema"?: JsonSchema;
          }
        >
      >;
      readonly components: {
        readonly schemas: Record<string, JsonSchema>;
        readonly securitySchemes: Record<string, unknown>;
      };
    };
    const inventoryImport = document.paths["/api/v1/inventory/import/plan"]?.post;
    const browserBootstrap = document.paths["/api/v1/auth/session"]?.post;

    expect(inventoryImport?.requestBody).toBeDefined();
    expect(browserBootstrap?.requestBody).toBeUndefined();
    expect(Object.keys(inventoryImport?.responses ?? {}).sort()).toEqual([
      "200",
      "400",
      "401",
      "403",
      "413",
      "500",
    ]);
    expect(inventoryImport?.["x-cellarer-input-schema"]).toBeDefined();
    expect(inventoryImport?.["x-cellarer-output-schema"]).toBeDefined();
    expect(document.components.securitySchemes).toEqual({
      localManagedClientAuth: { type: "http", scheme: "bearer" },
      localBrowserSession: { type: "apiKey", in: "cookie", name: "cellarer_session" },
    });
    for (const [name, schema] of Object.entries(document.components.schemas)) {
      assertClosedJsonSchema(schema, `components.schemas.${name}`);
    }
  });

  it("omits removed discovery, scan, and legacy import surfaces from routes and OpenAPI", () => {
    const removedPaths = [
      "/api/v1/discovery",
      "/api/v1/scan/plan",
      "/api/v1/scan/apply",
      "/api/v1/import/plan",
      "/api/v1/import/apply",
    ];
    const document = createClientOpenApiDocument() as {
      readonly paths: Readonly<Record<string, unknown>>;
      readonly components: { readonly schemas: Readonly<Record<string, unknown>> };
    };

    expect(CLIENT_API_ROUTES.map(({ path }) => path)).not.toEqual(
      expect.arrayContaining(removedPaths),
    );
    expect(Object.keys(document.paths)).not.toEqual(expect.arrayContaining(removedPaths));
    expect(document.components.schemas).not.toHaveProperty("ScanPlan");
  });

  it("publishes only the exact unconstrained recursive JsonValue structure", () => {
    const document = createClientOpenApiDocument() as {
      readonly components: { readonly schemas: Record<string, JsonSchema> };
    };
    const jsonValue = document.components.schemas.JsonValue as JsonSchema;

    expect(() => assertCanonicalJsonValueSchema(jsonValue)).not.toThrow();
    for (const keyword of forbiddenJsonValueNarrowingKeywords) {
      expect(schemaContainsKeyword(jsonValue, keyword), keyword).toBe(false);
    }
  });

  it("publishes every canonical agent capability scope as required", () => {
    const document = createClientOpenApiDocument() as {
      readonly components: { readonly schemas: Record<string, JsonSchema> };
    };
    const agent = document.components.schemas.Agent;
    const capabilityScopes = agent?.properties?.capabilityScopes;

    expect(agent?.required).toContain("capabilityScopes");
    expect(capabilityScopes?.required).toEqual(["rules", "mcp", "skills"]);
  });

  it.each([
    ["negative number", -1],
    ["fractional number", 1.5],
    ["zero", 0],
    ["empty string", ""],
    ["array", [null, -1.25, ""]],
    ["object", { enabled: false, count: 0 }],
    ["nested value", { values: [null, { amount: -0.5, label: "" }] }],
  ])("accepts the canonical JsonValue runtime probe: %s", (_name, value) => {
    const document = createClientOpenApiDocument() as {
      readonly components: { readonly schemas: Record<string, JsonSchema> };
    };

    expect(
      schemaErrors(
        value,
        document.components.schemas.JsonValue as JsonSchema,
        document.components.schemas,
        "$",
      ),
    ).toEqual([]);
  });

  it("honors a minimum mutation at the existing JSON Schema validator boundary", () => {
    const document = createClientOpenApiDocument() as {
      readonly components: { readonly schemas: Record<string, JsonSchema> };
    };
    const jsonValue = structuredClone(document.components.schemas.JsonValue);
    const scalar = jsonValue.oneOf?.[0];
    if (scalar === undefined) throw new Error("JsonValue scalar variant is missing");
    Object.assign(scalar, { minimum: 0 });
    expect(() => assertCanonicalJsonValueSchema(jsonValue)).toThrow(/minimum/u);

    expect(schemaErrors(-1, jsonValue, document.components.schemas, "$.")).not.toEqual([]);
  });

  it("rejects minLength drift and honors it at the JSON Schema validator boundary", () => {
    const document = createClientOpenApiDocument() as {
      readonly components: { readonly schemas: Record<string, JsonSchema> };
    };
    const jsonValue = structuredClone(document.components.schemas.JsonValue);
    const scalar = jsonValue.oneOf?.[0];
    if (scalar === undefined) throw new Error("JsonValue scalar variant is missing");
    Object.assign(scalar, { minLength: 1 });

    expect(() => assertCanonicalJsonValueSchema(jsonValue)).toThrow(/minLength/u);
    expect(schemaErrors("", jsonValue, document.components.schemas, "$")).not.toEqual([]);
  });

  it("honors a minItems mutation at the existing JSON Schema validator boundary", () => {
    const document = createClientOpenApiDocument() as {
      readonly components: { readonly schemas: Record<string, JsonSchema> };
    };
    const jsonValue = structuredClone(document.components.schemas.JsonValue);
    const array = jsonValue.oneOf?.[1];
    if (array === undefined) throw new Error("JsonValue array variant is missing");
    Object.assign(array, { minItems: 1 });
    expect(() => assertCanonicalJsonValueSchema(jsonValue)).toThrow(/minItems/u);

    expect(schemaErrors([], jsonValue, document.components.schemas, "$.")).not.toEqual([]);
  });

  it("publishes an explicit closed success DTO for every implemented operation", () => {
    for (const route of CLIENT_API_ROUTES) {
      const success = route.outputSchema.oneOf?.[0];
      const data =
        route.operationId === "streamInventory" ? route.outputSchema : success?.properties?.data;

      expect(data, `${route.operationId} success data`).toBeDefined();
      const variants = data?.oneOf ?? (data ? [data] : []);
      for (const variant of variants) {
        expect(variant.type, `${route.operationId} success data type`).toBe("object");
        expect(
          variant.additionalProperties,
          `${route.operationId} success DTO must reject unknown root fields`,
        ).toBe(false);
        expect(
          Object.keys(variant.properties ?? {}),
          `${route.operationId} success DTO must publish its fields`,
        ).not.toHaveLength(0);
      }
    }

    const planSync = CLIENT_API_ROUTES.find((route) => route.operationId === "planSync");
    const planSyncData = planSync?.outputSchema.oneOf?.[0]?.properties?.data;
    expect(planSyncData?.required).toEqual(["plan", "mutationPlan"]);
    expect(planSyncData?.properties?.mutationPlan?.$ref).toBe("#/components/schemas/MutationPlan");
  });

  it("publishes closed nested schemas for stable Core DTOs instead of JsonValue", () => {
    const document = createClientOpenApiDocument() as {
      readonly paths: Record<
        string,
        Record<
          string,
          {
            readonly operationId: string;
            readonly "x-cellarer-input-schema": JsonSchema;
            readonly "x-cellarer-output-schema": JsonSchema;
          }
        >
      >;
      readonly components: { readonly schemas: Record<string, JsonSchema> };
    };
    const successData = (operationId: string): JsonSchema | undefined => {
      for (const pathItem of Object.values(document.paths)) {
        for (const operation of Object.values(pathItem)) {
          if (operation.operationId === operationId) {
            return operation["x-cellarer-output-schema"].oneOf?.[0]?.properties?.data;
          }
        }
      }
      return undefined;
    };
    const inputBody = (operationId: string): JsonSchema | undefined => {
      for (const pathItem of Object.values(document.paths)) {
        for (const operation of Object.values(pathItem)) {
          if (operation.operationId === operationId) {
            return operation["x-cellarer-input-schema"].properties?.body;
          }
        }
      }
      return undefined;
    };
    const resolve = (schema: JsonSchema | undefined): JsonSchema | undefined => {
      const name = schema?.$ref?.match(/^#\/components\/schemas\/(.+)$/)?.[1];
      return name ? document.components.schemas[name] : schema;
    };
    const property = (schema: JsonSchema | undefined, name: string): JsonSchema | undefined =>
      resolve(schema)?.properties?.[name];
    const items = (schema: JsonSchema | undefined): JsonSchema | undefined =>
      resolve(schema)?.items;
    const stable = [
      ["planSync actions", items(property(property(successData("planSync"), "plan"), "actions"))],
      [
        "planSync conflicts",
        items(property(property(successData("planSync"), "plan"), "conflicts")),
      ],
      ["resources", items(property(successData("listResources"), "resources"))],
      ["agents", items(property(successData("listAgents"), "agents"))],
      ["collections", items(property(successData("listCollections"), "collections"))],
      ["profiles", items(property(successData("listProfiles"), "profiles"))],
      ["activity", items(property(successData("listActivity"), "events"))],
      ["operations", items(property(successData("listOperations"), "operations"))],
      ["Inventory candidates", items(property(successData("refreshInventory"), "candidates"))],
      [
        "Inventory import candidate IDs",
        property(inputBody("planInventoryStoreImport"), "candidateIds"),
      ],
      ["config", property(successData("showConfig"), "config")],
      ["agent adapter request", inputBody("planAgentMutation")],
      ["settings request", property(inputBody("planSettingsMutation"), "settings")],
      ["config validation request", inputBody("validateConfig")],
      [
        "operation conflict",
        resolve(property(successData("applySync"), "operation"))?.oneOf?.[1]?.properties?.conflict,
      ],
    ] as const;

    for (const [label, schema] of stable) {
      assertStableClosedJsonSchema(schema, document.components.schemas, label, new Set());
    }

    expect(inputBody("applyInventoryStoreImport")).toEqual({
      type: "object",
      properties: { mutationPlan: { $ref: "#/components/schemas/MutationPlan" } },
      required: ["mutationPlan"],
      additionalProperties: false,
    });
  });

  it("validates representative real read and plan responses against the published schemas", async () => {
    await initializeStore(env, storeRoot);
    await env.fs.writeFile(join(storeRoot, "store", "rules", "style.md"), "# style");
    const app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
    const configInput = {
      version: 1,
      defaults: {
        method: "copy",
        collections: ["default"],
        secretMode: "env",
        os: { darwin: { method: "copy" } },
      },
      collections: { default: { description: "Default resources" } },
      artifacts: {
        "rules/style": {
          collections: ["default"],
          secretPatternSuppressions: [
            { source: "rules/style.md", rule: "github-pat", patternVersion: 1 },
          ],
        },
      },
      adapterOverrides: {
        codex: {
          enabled: false,
          rules: { global: "~/.codex/AGENTS.md", format: "markdown" },
          capabilities: { rules: ["global"] },
        },
      },
      customAdapters: {
        "local-agent": {
          displayName: "Local Agent",
          rules: { global: "~/.local-agent/RULES.md", format: "markdown" },
          capabilities: { rules: ["global"] },
        },
      },
    } as const;
    const resourcesResponse = await app.request("/api/v1/resources?includeDiscovered=false");
    const planResponse = await app.request("/api/v1/sync/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        destination: "user",
        resources: { kinds: ["rules"] },
      }),
    });
    expect(resourcesResponse.status).toBe(200);
    expect(planResponse.status, await planResponse.clone().text()).toBe(200);
    const resourcesBody = await resourcesResponse.json();
    const planBody = (await planResponse.json()) as {
      readonly data: { readonly mutationPlan: Readonly<Record<string, unknown>> };
    };
    const alteredPlan = structuredClone(planBody.data.mutationPlan) as {
      actions: { payload: Record<string, unknown> }[];
    };
    const alteredAction = alteredPlan.actions[0];
    if (!alteredAction) throw new Error("expected a sync action to alter");
    alteredAction.payload.data = "contract-altering-value";
    const alteredResponse = await app.request("/api/v1/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationPlan: alteredPlan }),
    });
    const applyResponse = await app.request("/api/v1/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationPlan: planBody.data.mutationPlan }),
    });
    const invalidResponse = await app.request("/api/v1/resources/not-a-kind");
    const configResponse = await app.request("/api/v1/config");
    const configValidationResponse = await app.request("/api/v1/config/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(configInput),
    });
    expect(alteredResponse.status).toBe(400);
    expect(applyResponse.status, await applyResponse.clone().text()).toBe(200);
    expect(invalidResponse.status).toBe(400);
    expect(configResponse.status).toBe(200);
    expect(configValidationResponse.status).toBe(200);

    const document = createClientOpenApiDocument() as {
      readonly paths: Record<
        string,
        Record<
          string,
          {
            readonly operationId: string;
            readonly "x-cellarer-input-schema": JsonSchema;
            readonly "x-cellarer-output-schema": JsonSchema;
          }
        >
      >;
      readonly components: { readonly schemas: Record<string, JsonSchema> };
    };
    const outputSchema = (operationId: string): JsonSchema => {
      for (const pathItem of Object.values(document.paths)) {
        for (const operation of Object.values(pathItem)) {
          if (operation.operationId === operationId) return operation["x-cellarer-output-schema"];
        }
      }
      throw new Error(`missing operation schema: ${operationId}`);
    };
    const cases = [
      ["listResources", resourcesBody],
      ["planSync", planBody],
      ["applySync", await applyResponse.json()],
      ["applySync", await alteredResponse.json()],
      ["listResources", await invalidResponse.json()],
      ["showConfig", await configResponse.json()],
      ["validateConfig", await configValidationResponse.json()],
    ] as const;
    for (const [operationId, body] of cases) {
      expect(
        schemaErrors(body, outputSchema(operationId), document.components.schemas, "$"),
        `${operationId} response contract errors`,
      ).toEqual([]);
    }

    const inputBodySchema = (operationId: string): JsonSchema => {
      for (const pathItem of Object.values(document.paths)) {
        for (const operation of Object.values(pathItem)) {
          if (operation.operationId === operationId) {
            const schema = operation["x-cellarer-input-schema"].properties?.body;
            if (schema) return schema;
          }
        }
      }
      throw new Error(`missing request body schema: ${operationId}`);
    };
    const requestCases = [
      [
        "planAgentMutation",
        {
          action: "upsert-adapter",
          agentId: "local-agent",
          kind: "custom",
          adapter: { rules: { global: "~/.local-agent/RULES.md" } },
        },
      ],
      ["planSettingsMutation", { settings: { method: "copy" } }],
      ["validateConfig", configInput],
    ] as const;
    for (const [operationId, body] of requestCases) {
      expect(
        schemaErrors(body, inputBodySchema(operationId), document.components.schemas, "$"),
        `${operationId} request contract errors`,
      ).toEqual([]);
    }
    expect(
      schemaErrors(
        { unknownConfigField: true },
        inputBodySchema("validateConfig"),
        document.components.schemas,
        "$",
      ),
    ).not.toEqual([]);
  });

  it("keeps every stable domain-validation details variant mutually exclusive", () => {
    const document = createClientOpenApiDocument() as {
      readonly components: { readonly schemas: Record<string, JsonSchema> };
    };
    const errorSchema = document.components.schemas.ClientError;
    if (!errorSchema) throw new Error("missing ClientError component schema");
    const variants = [
      { coreCode: "INVALID_PLAN" },
      { coreCode: "EXPIRED_PLAN", planId: "untrusted", expiredAt: "untrusted" },
      {
        coreCode: "INVALID_PLAN_DIGEST",
        planId: "untrusted",
        expectedDigest: "untrusted",
        actualDigest: "invalid",
      },
    ];
    for (const details of variants) {
      expect(
        schemaErrors(
          {
            code: "DOMAIN_VALIDATION_FAILED",
            message: "mutation plan is invalid",
            details,
          },
          errorSchema,
          document.components.schemas,
          "$",
        ),
      ).toEqual([]);
    }
  });

  it("keeps custom-adapter and raw config input schemas aligned with Core parsing", () => {
    const document = createClientOpenApiDocument() as {
      readonly paths: Record<
        string,
        Record<
          string,
          {
            readonly operationId: string;
            readonly "x-cellarer-input-schema": JsonSchema;
          }
        >
      >;
      readonly components: { readonly schemas: Record<string, JsonSchema> };
    };
    const inputBodySchema = (operationId: string): JsonSchema => {
      for (const pathItem of Object.values(document.paths)) {
        for (const operation of Object.values(pathItem)) {
          if (operation.operationId === operationId) {
            const schema = operation["x-cellarer-input-schema"].properties?.body;
            if (schema) return schema;
          }
        }
      }
      throw new Error(`missing request body schema: ${operationId}`);
    };
    const customAdapterSchema = inputBodySchema("planAgentMutation");
    const invalidMcpAdapter = {
      action: "upsert-adapter",
      agentId: "local-agent",
      kind: "custom",
      adapter: { mcp: { global: "~/.local-agent/mcp.json" } },
    } as const;
    expect(() => parseAdapterBodyConfig(invalidMcpAdapter.adapter)).toThrow(
      "mcp adapter must declare supportedSecretReferences",
    );
    expect(
      schemaErrors(invalidMcpAdapter, customAdapterSchema, document.components.schemas, "$"),
    ).not.toEqual([]);

    const validMcpAdapter = {
      ...invalidMcpAdapter,
      adapter: {
        mcp: {
          global: "~/.local-agent/mcp.json",
          supportedSecretReferences: ["environment"],
        },
      },
    } as const;
    expect(parseAdapterBodyConfig(validMcpAdapter.adapter)).toMatchObject(validMcpAdapter.adapter);
    expect(
      schemaErrors(validMcpAdapter, customAdapterSchema, document.components.schemas, "$"),
    ).toEqual([]);

    const discoveryAdapter = (precedence: unknown) => ({
      action: "upsert-adapter",
      agentId: "local-agent",
      kind: "custom",
      adapter: {
        skills: { global: "~/.write" },
        discovery: [
          {
            sourceId: "fixture",
            scope: "global",
            kind: "skills",
            path: "~/.read",
            locator: "tree",
            maxDepth: 16,
            maxEntries: 1000,
            maxBytes: 10000,
            precedence,
          },
        ],
      },
    });
    for (const precedence of [
      { policy: "unknown", evidence: "fixture" },
      { policy: "ranked", rank: 1, evidence: "fixture" },
    ]) {
      const input = discoveryAdapter(precedence);
      expect(() => parseAdapterBodyConfig(input.adapter)).not.toThrow();
      expect(schemaErrors(input, customAdapterSchema, document.components.schemas, "$")).toEqual(
        [],
      );
    }
    for (const precedence of [
      { policy: "ranked", evidence: "fixture" },
      { policy: "unknown", evidence: "fixture", unexpected: true },
    ]) {
      const input = discoveryAdapter(precedence);
      expect(() => parseAdapterBodyConfig(input.adapter)).toThrow();
      expect(
        schemaErrors(input, customAdapterSchema, document.components.schemas, "$"),
      ).not.toEqual([]);
    }

    const configSchema = inputBodySchema("validateConfig");
    const validConfigs = [
      { defaults: { method: "copy" } },
      { artifacts: { "rules/style": {} } },
    ] as const;
    for (const input of validConfigs) {
      expect(validateControlPlaneConfig(input).valid).toBe(true);
      expect(schemaErrors(input, configSchema, document.components.schemas, "$"), input).toEqual(
        [],
      );
    }

    const invalidConfigs = [
      { collections: { "": {} } },
      { adapterOverrides: { "invalid agent id": {} } },
      { customAdapters: { "local-agent": invalidMcpAdapter.adapter } },
    ] as const;
    for (const input of invalidConfigs) {
      expect(validateControlPlaneConfig(input).valid).toBe(false);
      expect(
        schemaErrors(input, configSchema, document.components.schemas, "$"),
        input,
      ).not.toEqual([]);
    }
  });

  it("matches the explicit Hono /api/v1 method and path surface exactly", () => {
    const app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
    const actual = app.routes
      .filter((route) => route.method !== "ALL" && route.path.startsWith("/api/v1/"))
      .map((route) => `${route.method.toLowerCase()} ${normalizeHonoPath(route.path)}`)
      .sort();
    const registered = CLIENT_API_ROUTES.map((route) => `${route.method} ${route.path}`).sort();

    expect(actual).toEqual(registered);
    expect(
      app.routes.filter(
        (route) =>
          route.method !== "ALL" &&
          route.path.startsWith("/api/") &&
          !route.path.startsWith("/api/v1/"),
      ),
    ).toEqual([]);
  });

  it("returns not found for a removed legacy route before observing Core", async () => {
    let filesystemEffects = 0;
    const noCoreEnv: Env = {
      ...env,
      fs: new Proxy(env.fs, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          return (..._args: unknown[]) => {
            filesystemEffects += 1;
            throw new Error(`unexpected Core filesystem effect: ${String(property)}`);
          };
        },
      }),
    };
    const response = await createApp({
      env: noCoreEnv,
      storeRoot,
      auth: { mode: "trusted-embedded" },
    }).request("/api/agents");

    expect(response.status).toBe(404);
    expect(filesystemEffects).toBe(0);
  });
});

function normalizeHonoPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function assertClosedJsonSchema(schema: JsonSchema | undefined, path: string): void {
  expect(schema, path).toBeDefined();
  if (!schema) return;
  if (schema.$ref) return;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.includes("object") || schema.properties || schema.additionalProperties !== undefined) {
    expect(schema.additionalProperties, `${path} must close object properties`).not.toBeUndefined();
    expect(schema.additionalProperties, `${path} must not allow arbitrary properties`).not.toBe(
      true,
    );
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    assertClosedJsonSchema(child, `${path}.properties.${name}`);
  }
  if (typeof schema.additionalProperties === "object") {
    assertClosedJsonSchema(schema.additionalProperties, `${path}.additionalProperties`);
  }
  if (schema.items) assertClosedJsonSchema(schema.items, `${path}.items`);
  if (schema.propertyNames) {
    assertClosedJsonSchema(schema.propertyNames, `${path}.propertyNames`);
  }
  for (const [index, child] of (schema.oneOf ?? []).entries()) {
    assertClosedJsonSchema(child, `${path}.oneOf[${index}]`);
  }
  for (const [index, child] of (schema.anyOf ?? []).entries()) {
    assertClosedJsonSchema(child, `${path}.anyOf[${index}]`);
  }
  for (const [index, child] of (schema.allOf ?? []).entries()) {
    assertClosedJsonSchema(child, `${path}.allOf[${index}]`);
  }
  if (schema.if) assertClosedJsonSchema(schema.if, `${path}.if`);
  if (schema.then) assertClosedJsonSchema(schema.then, `${path}.then`);
  if (schema.not) assertClosedJsonSchema(schema.not, `${path}.not`);
}

function assertStableClosedJsonSchema(
  schema: JsonSchema | undefined,
  components: Readonly<Record<string, JsonSchema>>,
  path: string,
  refs: Set<string>,
): void {
  expect(schema, path).toBeDefined();
  if (!schema) return;
  if (schema.$ref) {
    expect(schema.$ref, `${path} must not use the open JsonValue contract`).not.toBe(
      "#/components/schemas/JsonValue",
    );
    const name = schema.$ref.match(/^#\/components\/schemas\/(.+)$/)?.[1];
    expect(name, `${path} must use a local component ref`).toBeDefined();
    if (!name || refs.has(name)) return;
    refs.add(name);
    assertStableClosedJsonSchema(components[name], components, `${path} -> ${name}`, refs);
    return;
  }
  assertClosedJsonSchema(schema, path);
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    assertStableClosedJsonSchema(child, components, `${path}.properties.${name}`, new Set(refs));
  }
  if (schema.items) {
    assertStableClosedJsonSchema(schema.items, components, `${path}.items`, new Set(refs));
  }
  if (schema.propertyNames) {
    assertStableClosedJsonSchema(
      schema.propertyNames,
      components,
      `${path}.propertyNames`,
      new Set(refs),
    );
  }
  if (typeof schema.additionalProperties === "object") {
    assertStableClosedJsonSchema(
      schema.additionalProperties,
      components,
      `${path}.additionalProperties`,
      new Set(refs),
    );
  }
  for (const [index, child] of (schema.oneOf ?? []).entries()) {
    assertStableClosedJsonSchema(child, components, `${path}.oneOf[${index}]`, new Set(refs));
  }
  for (const [index, child] of (schema.anyOf ?? []).entries()) {
    assertStableClosedJsonSchema(child, components, `${path}.anyOf[${index}]`, new Set(refs));
  }
  for (const [index, child] of (schema.allOf ?? []).entries()) {
    assertStableClosedJsonSchema(child, components, `${path}.allOf[${index}]`, new Set(refs));
  }
  if (schema.not) {
    assertStableClosedJsonSchema(schema.not, components, `${path}.not`, new Set(refs));
  }
}

function schemaErrors(
  value: unknown,
  schema: JsonSchema,
  components: Readonly<Record<string, JsonSchema>>,
  path: string,
): string[] {
  if (schema.$ref) {
    const name = schema.$ref.match(/^#\/components\/schemas\/(.+)$/)?.[1];
    return name && components[name]
      ? schemaErrors(value, components[name], components, path)
      : [`${path}: unresolved ref ${schema.$ref}`];
  }
  if (schema.oneOf) {
    const branches = schema.oneOf.map((branch) => schemaErrors(value, branch, components, path));
    const matches = branches.filter((errors) => errors.length === 0);
    return matches.length === 1
      ? []
      : [`${path}: expected exactly one oneOf match, found ${matches.length}`, ...branches.flat()];
  }
  if (schema.anyOf) {
    const branches = schema.anyOf.map((branch) => schemaErrors(value, branch, components, path));
    if (!branches.some((errors) => errors.length === 0)) {
      return [`${path}: expected at least one anyOf match`, ...branches.flat()];
    }
  }
  if (schema.not && schemaErrors(value, schema.not, components, path).length === 0) {
    return [`${path}: matched forbidden schema`];
  }
  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    return [`${path}: expected const ${JSON.stringify(schema.const)}`];
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    return [`${path}: value is outside enum`];
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((type) => matchesJsonType(value, type))) {
    return [`${path}: expected ${types.join("|")}`];
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    return [`${path}: expected a number greater than or equal to ${schema.minimum}`];
  }
  if (typeof value === "number" && schema.maximum !== undefined && value > schema.maximum) {
    return [`${path}: expected a number less than or equal to ${schema.maximum}`];
  }
  if (
    typeof value === "number" &&
    schema.exclusiveMinimum !== undefined &&
    value <= schema.exclusiveMinimum
  ) {
    return [`${path}: expected a number greater than ${schema.exclusiveMinimum}`];
  }
  if (
    typeof value === "number" &&
    schema.exclusiveMaximum !== undefined &&
    value >= schema.exclusiveMaximum
  ) {
    return [`${path}: expected a number less than ${schema.exclusiveMaximum}`];
  }
  if (
    typeof value === "number" &&
    schema.multipleOf !== undefined &&
    !Number.isInteger(value / schema.multipleOf)
  ) {
    return [`${path}: expected a multiple of ${schema.multipleOf}`];
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return [`${path}: expected at least ${schema.minLength} characters`];
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      return [`${path}: value does not match pattern`];
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return [`${path}: expected at most ${schema.maxLength} characters`];
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return [`${path}: expected at least ${schema.minItems} items`];
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return [`${path}: expected at most ${schema.maxItems} items`];
    }
    if (
      schema.uniqueItems === true &&
      value.some((item, index) =>
        value.slice(0, index).some((other) => isDeepStrictEqual(item, other)),
      )
    ) {
      return [`${path}: expected unique items`];
    }
    const itemSchema = schema.items;
    return itemSchema
      ? value.flatMap((child, index) =>
          schemaErrors(child, itemSchema, components, `${path}[${index}]`),
        )
      : [];
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (schema.minProperties !== undefined && Object.keys(record).length < schema.minProperties) {
      return [`${path}: expected at least ${schema.minProperties} properties`];
    }
    if (schema.maxProperties !== undefined && Object.keys(record).length > schema.maxProperties) {
      return [`${path}: expected at most ${schema.maxProperties} properties`];
    }
    const errors = (schema.required ?? [])
      .filter((key) => !Object.hasOwn(record, key))
      .map((key) => `${path}: missing required ${key}`);
    for (const [key, child] of Object.entries(record)) {
      if (schema.propertyNames) {
        errors.push(...schemaErrors(key, schema.propertyNames, components, `${path}.{key}`));
      }
      const property = schema.properties?.[key];
      if (property) errors.push(...schemaErrors(child, property, components, `${path}.${key}`));
      else if (schema.additionalProperties === false)
        errors.push(`${path}: unknown property ${key}`);
      else if (typeof schema.additionalProperties === "object") {
        errors.push(
          ...schemaErrors(child, schema.additionalProperties, components, `${path}.${key}`),
        );
      }
    }
    return errors;
  }
  return [];
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    default:
      return typeof value === type;
  }
}
