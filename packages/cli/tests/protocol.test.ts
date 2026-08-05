import { readFileSync } from "node:fs";
import { CLI_PROTOCOL_VERSION, type CliErrorCode, type CliResultEnvelope } from "@cellarer/core";
import { describe, expect, it } from "vitest";
import {
  commandRegistry,
  getCommandDefinition,
  getProtocolSchemaBundle,
} from "../src/protocol/command-registry.js";
import { CLI_EXIT_CODE, exitCodeForError } from "../src/protocol/exit-mapper.js";
import { createProtocolRenderer } from "../src/protocol/renderer.js";
import { resolveRequestId } from "../src/protocol/request-id.js";

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

    renderer.event({ code: "PLAN_READY", data: { actions: 2 } });
    renderer.success({ operationId: "operation-1" });

    const records = stdout
      .join("")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records[0]).toEqual(golden.event);
    expect(records.filter((record) => "status" in record)).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({
      status: "success",
      data: { operationId: "operation-1" },
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
    expect(stdout.join("")).toContain("[REDACTED]");
    expect(Object.isFrozen(payload)).toBe(false);
    expect(Object.isFrozen(payload.schema)).toBe(false);
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

  it("derives structured input bindings from the same registry metadata as schemas", () => {
    for (const definition of commandRegistry) {
      const inputData = definition.inputSchema.properties?.input;
      const schemaFields = Object.keys(inputData?.properties ?? {}).sort();
      const bindingFields = [...new Set(definition.inputBindings.map(({ field }) => field))].sort();

      expect(bindingFields, definition.command).toEqual(schemaFields);
    }
  });
});
