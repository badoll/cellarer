import { readFileSync } from "node:fs";
import { CLI_PROTOCOL_VERSION, type CliErrorCode, type CliResultEnvelope } from "@cellarer/core";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/program.js";
import {
  createCommandCatalog,
  defineCommandContract,
  defineCommandDomain,
} from "../src/protocol/command-contract.js";
import {
  commandRegistry,
  getCommandDefinition,
  getProtocolSchemaBundle,
} from "../src/protocol/command-registry.js";
import { CLI_EXIT_CODE, exitCodeForError } from "../src/protocol/exit-mapper.js";
import { createProtocolRenderer } from "../src/protocol/renderer.js";
import { resolveRequestId } from "../src/protocol/request-id.js";
import { type JsonSchema, jsonSchema } from "../src/protocol/schemas.js";

interface GoldenFixture {
  success: CliResultEnvelope<{ items: never[] }>;
  event: unknown;
  conflict: CliResultEnvelope;
}

const golden = JSON.parse(
  readFileSync(new URL("./fixtures/agent-cli-protocol-v1.json", import.meta.url), "utf8"),
) as GoldenFixture;

describe("agent CLI protocol v1 golden boundary", () => {
  it("emits exactly one compact JSON success envelope to stdout", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const renderer = createProtocolRenderer({
      command: "status",
      output: "json",
      requestId: "req-fixed",
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(renderer.success({ items: [] })).toBe(CLI_EXIT_CODE.SUCCESS);
    expect(stdout).toEqual([`${JSON.stringify(golden.success)}\n`]);
    expect(stderr).toEqual([]);
  });

  it("emits complete JSONL events followed by exactly one terminal record", () => {
    const stdout: string[] = [];
    const renderer = createProtocolRenderer({
      command: "apply",
      output: "jsonl",
      requestId: "req-fixed",
      stdout: (chunk) => stdout.push(chunk),
      stderr: () => {},
    });

    renderer.event({ code: "PLAN_READY", data: { phase: "apply", current: 0, total: 2 } });
    renderer.failure({ code: "EXECUTION_FAILED", message: "apply failed safely" });

    const records = stdout
      .join("")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records[0]).toEqual(golden.event);
    expect(records.filter((record) => "status" in record)).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({
      status: "error",
      error: { code: "EXECUTION_FAILED" },
    });
    expect(() => renderer.event({ code: "TOO_LATE", data: {} })).toThrow(/terminal result/i);
  });

  it("keeps diagnostics on stderr, redacts both streams, and maps handled failures", () => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const stdout: string[] = [];
    const stderr: string[] = [];
    const renderer = createProtocolRenderer({
      command: "apply",
      output: "json",
      requestId: "req-fixed",
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    renderer.diagnostic(`debug token ${canary}`, { accessToken: canary });
    expect(
      renderer.failure({
        code: "STALE_REVISION",
        message: "Store revision changed",
        details: { accessToken: canary },
      }),
    ).toBe(CLI_EXIT_CODE.CONFLICT);

    expect(stdout).toEqual([`${JSON.stringify(golden.conflict)}\n`]);
    expect(stderr).toEqual(["[REDACTED]\n"]);
    expect(stdout.join("") + stderr.join("")).not.toContain(canary);
  });

  it.each([
    "json",
    "jsonl",
  ] as const)("emits exactly one internal-error terminal record for hostile diagnostics in %s mode", (output) => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const hostileErrors: Array<[string, unknown]> = [
      [
        "stack",
        Object.defineProperty(new Error("safe message"), "stack", {
          configurable: true,
          get() {
            throw new Error(`hostile stack: ${canary}`);
          },
        }),
      ],
      [
        "message",
        Object.defineProperties(new Error("safe message"), {
          stack: { configurable: true, value: undefined },
          message: {
            configurable: true,
            get() {
              throw new Error(`hostile message: ${canary}`);
            },
          },
        }),
      ],
      [
        "toString",
        Object.defineProperty({}, "toString", {
          configurable: true,
          get() {
            throw new Error(`hostile toString: ${canary}`);
          },
        }),
      ],
    ];

    for (const [label, error] of hostileErrors) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const renderer = createProtocolRenderer({
        command: "status",
        output,
        requestId: `req-hostile-${label}`,
        stdout: (chunk) => stdout.push(chunk),
        stderr: (chunk) => stderr.push(chunk),
      });

      expect(() => renderer.internalFailure(error), label).not.toThrow();
      expect(stderr, label).toEqual(["Unexpected internal failure\n"]);
      expect(stdout, label).toHaveLength(1);
      expect(stdout[0]?.trimEnd().split("\n"), label).toHaveLength(1);
      expect(JSON.parse(stdout[0] as string), label).toMatchObject({
        command: "status",
        requestId: `req-hostile-${label}`,
        status: "error",
        error: { code: "INTERNAL_ERROR" },
      });
      expect(stdout.join("") + stderr.join(""), label).not.toContain(canary);
      expect(renderer.terminalEmitted, label).toBe(true);
    }
  });

  it("redacts a readable internal diagnostic without traversing a hostile cause", () => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const error = new Error(`unexpected failure: ${canary}`);
    Object.defineProperty(error, "cause", {
      configurable: true,
      get() {
        throw new Error(`hostile cause: ${canary}`);
      },
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const renderer = createProtocolRenderer({
      command: "status",
      output: "json",
      requestId: "req-hostile-cause",
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(renderer.internalFailure(error)).toBe(CLI_EXIT_CODE.INTERNAL);

    expect(stderr).toEqual(["[REDACTED]\n"]);
    expect(stdout).toHaveLength(1);
    expect(stdout.join("") + stderr.join("")).not.toContain(canary);
  });

  it("does not treat an ordinary schema-shaped secret payload as a public schema", () => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const stdout: string[] = [];
    const renderer = createProtocolRenderer({
      command: "schema",
      output: "json",
      requestId: "req-fixed",
      stdout: (chunk) => stdout.push(chunk),
      stderr: () => {},
    });

    const payload = {
      schema: {
        properties: {
          passphraseFd: { type: "integer", minimum: 0 },
          accessToken: canary,
        },
      },
    };

    renderer.success(payload);

    expect(stdout.join("")).not.toContain(canary);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      status: "error",
      error: { code: "INTERNAL_ERROR" },
    });
    expect(Object.isFrozen(payload)).toBe(false);
    expect(Object.isFrozen(payload.schema)).toBe(false);
  });

  it.each([
    "json",
    "jsonl",
  ] as const)("replaces schema-invalid success output with one redacted internal terminal in %s mode", (output) => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const stdout: string[] = [];
    const stderr: string[] = [];
    const renderer = createProtocolRenderer({
      command: "status",
      output,
      requestId: `req-invalid-success-${output}`,
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(
      renderer.success({ items: [], extra: canary } as never, [], { accessToken: canary }),
    ).toBe(CLI_EXIT_CODE.INTERNAL);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] as string)).toMatchObject({
      status: "error",
      error: { code: "INTERNAL_ERROR", message: "Unexpected internal failure" },
    });
    expect(stdout.join("") + stderr.join("")).not.toContain(canary);
    expect(renderer.terminalEmitted).toBe(true);
  });

  it("keeps valid JSONL prefixes and replaces a schema-invalid event with the terminal failure", () => {
    const stdout: string[] = [];
    const renderer = createProtocolRenderer({
      command: "apply",
      output: "jsonl",
      requestId: "req-invalid-event",
      stdout: (chunk) => stdout.push(chunk),
      stderr: () => {},
    });

    renderer.event({ code: "APPLY_STARTED", data: { phase: "apply", current: 0, total: 1 } });
    renderer.event({ code: "INVALID_EVENT", data: { phase: "apply", current: "zero" } } as never);

    const records = stdout.map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ sequence: 1, event: { code: "APPLY_STARTED" } });
    expect(records[1]).toMatchObject({
      status: "error",
      error: { code: "INTERNAL_ERROR" },
    });
    expect(records[1]).not.toHaveProperty("event");
    expect(renderer.terminalEmitted).toBe(true);
    expect(renderer.internalFailure(new Error("later failure"))).toBe(CLI_EXIT_CODE.INTERNAL);
    expect(stdout).toHaveLength(2);
  });

  it("fails closed when a resource reference-name getter cannot produce schema-valid output", () => {
    const resource = {
      id: "mcp/context",
      kind: "mcp",
      name: "context",
      source: "store",
      state: "managed",
      membership: { collections: [] },
      selection: { desired: false, collections: [] },
      validation: { status: "valid", issues: [] },
      usage: { desired: [], applied: [] },
    } as Record<string, unknown>;
    Object.defineProperty(resource, "secretReferenceNames", {
      enumerable: true,
      get() {
        throw new Error("hostile reference getter");
      },
    });
    const stdout: string[] = [];
    const renderer = createProtocolRenderer({
      command: "resource.list",
      output: "json",
      requestId: "req-hostile-reference-names",
      stdout: (chunk) => stdout.push(chunk),
      stderr: () => {},
    });

    expect(
      renderer.success({
        generatedAt: "2026-08-06T00:00:00.000Z",
        resources: [resource],
        counts: {
          managed: 1,
          discovered: 0,
          synced: 0,
          drifted: 0,
          missing: 0,
          blocked: 0,
        },
        warnings: [],
      }),
    ).toBe(CLI_EXIT_CODE.INTERNAL);
    expect(JSON.parse(stdout[0] as string)).toMatchObject({
      status: "error",
      error: { code: "INTERNAL_ERROR" },
    });
  });

  it("preserves normal resource reference names through the output schema gate", () => {
    const stdout: string[] = [];
    const renderer = createProtocolRenderer({
      command: "resource.list",
      output: "json",
      requestId: "req-valid-reference-names",
      stdout: (chunk) => stdout.push(chunk),
      stderr: () => {},
    });

    expect(
      renderer.success({
        generatedAt: "2026-08-06T00:00:00.000Z",
        resources: [
          {
            id: "mcp/context",
            kind: "mcp",
            name: "context",
            source: "store",
            state: "managed",
            membership: { collections: [] },
            selection: { desired: false, collections: [] },
            validation: { status: "valid", issues: [] },
            secretReferenceNames: ["CTX_TOKEN"],
            usage: { desired: [], applied: [] },
          },
        ],
        counts: {
          managed: 1,
          discovered: 0,
          synced: 0,
          drifted: 0,
          missing: 0,
          blocked: 0,
        },
        warnings: [],
      }),
    ).toBe(CLI_EXIT_CODE.SUCCESS);
    expect(JSON.parse(stdout[0] as string)).toMatchObject({
      status: "success",
      data: { resources: [{ secretReferenceNames: ["CTX_TOKEN"] }] },
    });
  });

  it("replaces schema-invalid handled errors without recursively rendering the invalid record", () => {
    const stdout: string[] = [];
    const renderer = createProtocolRenderer({
      command: "status",
      output: "json",
      requestId: "req-invalid-error",
      stdout: (chunk) => stdout.push(chunk),
      stderr: () => {},
    });

    expect(renderer.failure({ code: "STALE_REVISION", message: 7, extra: true } as never)).toBe(
      CLI_EXIT_CODE.INTERNAL,
    );
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] as string)).toMatchObject({
      status: "error",
      error: { code: "INTERNAL_ERROR" },
    });
  });

  it("mints a deeply immutable public schema bundle that is safe to reuse", () => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const schemaId = getCommandDefinition("secret.add")?.inputSchemaId;
    const bundle = getProtocolSchemaBundle(schemaId);
    expect(bundle).toBeDefined();
    const schema = bundle?.schemas[0]?.schema as Record<string, unknown>;
    const hadAccessToken = Object.hasOwn(schema, "accessToken");
    const previousAccessToken = schema.accessToken;
    const outputs: string[] = [];

    let didMutate = false;
    try {
      didMutate = Reflect.set(schema, "accessToken", canary);
      for (let invocation = 0; invocation < 2; invocation += 1) {
        const renderer = createProtocolRenderer({
          command: "schema",
          output: "json",
          requestId: `req-schema-${invocation}`,
          stdout: (chunk) => outputs.push(chunk),
          stderr: () => {},
        });
        renderer.success(bundle);
      }
    } finally {
      if (hadAccessToken) Reflect.set(schema, "accessToken", previousAccessToken);
      else Reflect.deleteProperty(schema, "accessToken");
    }

    expect(didMutate).toBe(false);
    expectDeeplyFrozen(bundle);
    expect(outputs).toHaveLength(2);
    expect(outputs.join("")).not.toContain(canary);
    expect(JSON.parse(outputs[0] as string)).toMatchObject({
      command: "schema",
      status: "success",
      data: { bundleVersion: 1, schemas: [{ schemaId }] },
    });
  });

  it("maps every stable error code to its public exit class", () => {
    const expected: Record<CliErrorCode, number> = {
      INVALID_USAGE: 2,
      INVALID_INPUT: 2,
      INPUT_REQUIRED: 2,
      INPUT_AMBIGUITY: 2,
      POLICY_VIOLATION: 3,
      DOMAIN_VALIDATION_FAILED: 3,
      STALE_REVISION: 4,
      LOCK_CONFLICT: 4,
      TARGET_CONFLICT: 4,
      EXECUTION_FAILED: 5,
      PARTIAL_FAILURE: 5,
      RECOVERY_REQUIRED: 6,
      INTERNAL_ERROR: 70,
    };

    for (const [code, exitCode] of Object.entries(expected)) {
      expect(exitCodeForError({ code: code as CliErrorCode })).toBe(exitCode);
    }
  });
});

function expectDeeplyFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeeplyFrozen(child, seen);
}

describe("command contract kernel", () => {
  it("generates Commander registration and every protocol projection from one aggregate", async () => {
    const contract = testCommandContract("probe.echo");
    const catalog = createCommandCatalog([
      defineCommandDomain({ id: "probe", contracts: [contract] }),
    ]);
    const program = new Command();
    const invoked: string[] = [];

    catalog.registerCommander(program, async (selected) => {
      invoked.push(selected.command);
    });
    await program.parseAsync(["node", "test", "probe", "echo", "--message", "hello"], {
      from: "node",
    });

    expect(invoked).toEqual(["probe.echo"]);
    expect(catalog.getCapabilities().commands).toEqual([
      {
        command: "probe.echo",
        mutability: "read",
        streaming: false,
        inputSchemaId: contract.inputSchemaId,
        outputSchemaId: contract.outputSchemaId,
        requiredFeatures: ["probe"],
      },
    ]);
    expect(catalog.getInputBindings("probe.echo")).toEqual([
      { field: "message", option: "message" },
    ]);
    expect(catalog.getRendererMetadata("probe.echo")).toEqual({
      command: "probe.echo",
      streaming: false,
      outputSchema: contract.outputSchema,
    });
    const schemaBundle = catalog.getSchemaBundle();
    expect(
      schemaBundle?.schemas
        .map(({ schemaId }) => schemaId)
        .filter((schemaId) => schemaId.includes("command:probe.echo")),
    ).toEqual([contract.inputSchemaId, contract.outputSchemaId]);
    expect(
      schemaBundle?.schemas.find(({ schemaId }) => schemaId === contract.inputSchemaId)?.schema,
    ).not.toBe(contract.inputSchema);
    expectDeeplyFrozen(schemaBundle);
  });

  it("rejects executable leaves without contracts and contracts without executable leaves", () => {
    const catalog = createCommandCatalog([
      defineCommandDomain({ id: "probe", contracts: [testCommandContract("probe.echo")] }),
    ]);

    expect(() => catalog.assertExecutableParity(["probe.echo", "probe.orphan"])).toThrow(
      /executable command probe\.orphan has no contract/,
    );
    expect(() => catalog.assertExecutableParity([])).toThrow(
      /contract probe\.echo has no executable command/,
    );
  });

  it("rejects duplicate command paths and schema IDs", () => {
    const first = testCommandContract("probe.echo");
    const second = testCommandContract("probe.other");
    const duplicateInputSchema = {
      ...second,
      inputSchemaId: first.inputSchemaId,
      inputSchema: { ...second.inputSchema, $id: first.inputSchemaId },
    };

    expect(() =>
      createCommandCatalog([
        defineCommandDomain({ id: "one", contracts: [first] }),
        defineCommandDomain({ id: "two", contracts: [first] }),
      ]),
    ).toThrow(/duplicate command path probe\.echo/);
    expect(() =>
      createCommandCatalog([
        defineCommandDomain({ id: "one", contracts: [first, duplicateInputSchema] }),
      ]),
    ).toThrow(/duplicate schema ID/);
  });

  it("rejects invalid streaming, schema identity, and input-binding combinations", () => {
    const base = testCommandContract("probe.echo");

    expect(() =>
      createCommandCatalog([
        defineCommandDomain({ id: "probe", contracts: [{ ...base, streaming: true }] }),
      ]),
    ).toThrow(/event schema exactly when streaming/);
    expect(() =>
      createCommandCatalog([
        defineCommandDomain({
          id: "probe",
          contracts: [{ ...base, inputSchemaId: "urn:wrong" }],
        }),
      ]),
    ).toThrow(/input schema ID/);
    expect(() =>
      defineCommandContract({
        ...testCommandContractInput("probe.unbound"),
        bindings: [],
      }),
    ).toThrow(/input bindings/);
  });
});

function testCommandContract(command: string) {
  return defineCommandContract(testCommandContractInput(command));
}

function testCommandContractInput(command: string) {
  const leafName = command.split(".").at(-1) as string;
  return {
    command,
    mutability: "read" as const,
    requiredFeatures: ["probe"],
    input: jsonSchema.object({ message: jsonSchema.string() }),
    bindings: [{ field: "message", option: "message" }],
    output: jsonSchema.object({ echoed: jsonSchema.string() }, ["echoed"]),
    createCommand: () =>
      new Command(leafName).description("echo a probe value").option("--message <message>"),
    normalize: ({ command: leaf }: { command: Command }) => ({
      message: String(leaf.opts().message ?? ""),
    }),
    execute: async (input: { message: string }) => ({
      ok: true as const,
      data: { echoed: input.message },
      warnings: [],
      context: input,
    }),
    presentText: () => undefined,
    mapError: () => undefined,
  };
}

describe("agent CLI protocol foundation", () => {
  it("resolves supplied request IDs and creates valid generated IDs", () => {
    expect(resolveRequestId("caller:request-42")).toBe("caller:request-42");
    expect(resolveRequestId(undefined, () => "00000000-0000-4000-8000-000000000042")).toBe(
      "req-00000000-0000-4000-8000-000000000042",
    );
    expect(() => resolveRequestId("contains whitespace")).toThrow(/request id/i);
  });

  it("registers every current leaf command with unique command-specific schemas", () => {
    expect(CLI_PROTOCOL_VERSION).toBe("1.0");
    expect(commandRegistry.map(({ command }) => command)).toEqual([
      "init",
      "add",
      "agents",
      "ls",
      "apply",
      "authority.rotate",
      "scan",
      "revert",
      "status",
      "secret.add",
      "secret.ls",
      "secret.rm",
      "doctor",
      "ui",
      "capabilities",
      "schema",
      "resource.list",
      "resource.show",
      "agent.list",
      "agent.show",
      "agent.enable",
      "agent.disable",
      "agent.configure",
      "agent.reset",
      "agent.add",
      "agent.update",
      "agent.remove",
      "collection.list",
      "collection.show",
      "collection.create",
      "collection.update",
      "collection.delete",
      "collection.members.set",
      "collection.defaults.set",
      "config.show",
      "config.validate",
      "config.update",
      "config.reset",
      "diff",
      "verify",
      "summary",
      "discovery.summary",
      "operation.list",
      "operation.show",
      "operation.recover",
      "plan",
      "resource.dependencies",
      "resource.check",
      "resource.update",
      "resource.rename",
      "resource.remove",
      "resource.export",
      "resource.import",
      "profile.list",
      "profile.show",
      "profile.create",
      "profile.update",
      "profile.delete",
      "sync.plan",
      "sync.apply",
      "sync.verify",
      "sync.uninstall",
    ]);

    const schemaIds = new Set<string>();
    for (const definition of commandRegistry) {
      expect(definition.inputSchema.$id).toBe(definition.inputSchemaId);
      expect(definition.outputSchema.$id).toBe(definition.outputSchemaId);
      expect(definition.outputSchema.properties?.command).toEqual({ const: definition.command });
      schemaIds.add(definition.inputSchemaId);
      schemaIds.add(definition.outputSchemaId);
    }
    expect(schemaIds.size).toBe(commandRegistry.length * 2);
    expect(getCommandDefinition("status")?.mutability).toBe("read");
    expect(getCommandDefinition("apply")?.streaming).toBe(true);
  });

  it("publishes closed command data schemas with every observable root field", () => {
    const lsOutput = getCommandDefinition("ls")?.outputSchema.properties?.data;

    expect(lsOutput?.additionalProperties).toBe(false);
    expect(lsOutput?.properties).toHaveProperty("storeEmpty", { type: "boolean" });
  });

  it("recursively closes every public command input, output, and event object schema", () => {
    for (const definition of commandRegistry) {
      auditClosedObjects(definition.inputSchema, `${definition.command}.input`);
      auditClosedObjects(definition.outputSchema, `${definition.command}.output`);
      if (definition.eventSchema) {
        auditClosedObjects(definition.eventSchema, `${definition.command}.event`);
      }
    }
  });

  it("derives structured input bindings from the same registry metadata as schemas", () => {
    for (const definition of commandRegistry) {
      const inputData = definition.inputSchema.properties?.input;
      const schemaFields = Object.keys(inputData?.properties ?? {}).sort();
      const bindingFields = [...new Set(definition.inputBindings.map(({ field }) => field))].sort();

      expect(bindingFields, definition.command).toEqual(schemaFields);
    }
  });

  it("keeps bilingual plan/apply and recovery examples aligned with public help", () => {
    const documents = ["../../../docs/README.md", "../../../docs/README.zh-CN.md"].map((path) =>
      readFileSync(new URL(path, import.meta.url), "utf8"),
    );
    for (const document of documents) {
      expect(document).toContain("apply --plan");
      expect(document).toContain("input.plan");
      expect(document).toContain("operation recover operation-<id> --dry-run");
      expect(document).not.toMatch(/does not resubmit the serialized|不会重新提交序列化/);
    }

    const apply = buildProgram().commands.find((command) => command.name() === "apply");
    expect(apply?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--plan", "--dry-run"]),
    );
  });
});

function auditClosedObjects(schema: JsonSchema, path: string): void {
  if (schema["x-cellarer-opaque"] === true) return;
  const semanticKeys = Object.keys(schema).filter(
    (key) => key !== "$id" && key !== "$schema" && key !== "title" && key !== "description",
  );
  expect(semanticKeys, `${path} empty branch`).not.toEqual([]);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  // Conditional `if` fragments may constrain properties without declaring an object value of
  // their own. Audit every actual object declaration and every explicit map schema.
  const isObjectSchema = types.includes("object") || schema.additionalProperties !== undefined;
  if (isObjectSchema) {
    expect(schema.additionalProperties, path).toBeDefined();
    expect(schema.additionalProperties, path).not.toBe(true);
    if (schema.additionalProperties !== false) {
      expect(Object.keys(schema.properties ?? {}), `${path} map leaf`).toEqual([]);
      expect(typeof schema.additionalProperties, `${path} map value schema`).toBe("object");
    }
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    auditClosedObjects(child, `${path}.properties.${key}`);
  }
  if (schema.items) auditClosedObjects(schema.items, `${path}.items`);
  if (typeof schema.additionalProperties === "object") {
    auditClosedObjects(schema.additionalProperties, `${path}.additionalProperties`);
  }
  for (const [index, child] of (schema.oneOf ?? []).entries()) {
    auditClosedObjects(child, `${path}.oneOf[${index}]`);
  }
  for (const [index, child] of (schema.allOf ?? []).entries()) {
    auditClosedObjects(child, `${path}.allOf[${index}]`);
  }
  if (schema.if) auditClosedObjects(schema.if, `${path}.if`);
  if (schema.then) auditClosedObjects(schema.then, `${path}.then`);
  if (schema.not) auditClosedObjects(schema.not, `${path}.not`);
}
