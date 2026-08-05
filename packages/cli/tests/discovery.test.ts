import { readFileSync } from "node:fs";
import { CLI_PROTOCOL_VERSION } from "@cellarer/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram } from "../src/program.js";
import { commandRegistry, commandSchemas } from "../src/protocol/command-registry.js";
import { CLI_ERROR_SCHEMA, CLI_WARNING_SCHEMA } from "../src/protocol/schemas.js";

const originalStdoutWrite = process.stdout.write;
const originalExitCode = process.exitCode;

interface TestEnvelope {
  readonly status: string;
  readonly command: string;
  readonly data: Record<string, unknown>;
  readonly error?: { readonly code: string };
}

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  process.exitCode = originalExitCode;
});

describe("CLI protocol discovery", () => {
  it("reports capabilities directly from the typed command registry", async () => {
    const program = buildProgram();
    expect(program.commands.find((command) => command.name() === "capabilities")).toBeDefined();

    const envelope = await invokeJson(["--output", "json", "capabilities"]);

    expect(envelope.status).toBe("success");
    expect(envelope.command).toBe("capabilities");
    expect(envelope.data).toEqual({
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
    });
  });

  it("returns one reported schema by identifier", async () => {
    const program = buildProgram();
    expect(program.commands.find((command) => command.name() === "schema")).toBeDefined();
    const requestedId = commandRegistry.find(({ command }) => command === "status")?.inputSchemaId;
    expect(requestedId).toBeDefined();

    const envelope = await invokeJson(["--output", "json", "schema", requestedId as string]);

    expect(envelope.status).toBe("success");
    expect(envelope.data).toEqual({
      bundleVersion: 1,
      protocolVersion: CLI_PROTOCOL_VERSION,
      schemas: [{ schemaId: requestedId, schema: commandSchemas[requestedId as string] }],
    });
  });

  it("preserves public schema keywords for protected descriptor fields", async () => {
    const requestedId = commandRegistry.find(
      ({ command }) => command === "secret.add",
    )?.inputSchemaId;
    expect(requestedId).toBeDefined();

    const envelope = await invokeJson(["--output", "json", "schema", requestedId as string]);
    const schema = (envelope.data.schemas as Array<{ schema: Record<string, unknown> }>)[0]
      ?.schema as {
      properties?: { input?: { properties?: { passphraseFd?: unknown } } };
    };

    expect(schema.properties?.input?.properties?.passphraseFd).toEqual({
      type: "integer",
      minimum: 3,
      maximum: 2_147_483_647,
    });
  });

  it("returns a deterministic locally consumable schema bundle", async () => {
    const first = await invokeJson(["--output", "json", "schema"]);
    const second = await invokeJson(["--output", "json", "schema"]);
    const expectedIds = [
      CLI_WARNING_SCHEMA.$id as string,
      CLI_ERROR_SCHEMA.$id as string,
      ...Object.keys(commandSchemas),
    ].sort();

    expect(first.status).toBe("success");
    expect(first.data).toEqual(second.data);
    expect(first.data).toMatchObject({
      bundleVersion: 1,
      protocolVersion: CLI_PROTOCOL_VERSION,
    });
    expect(
      (first.data.schemas as Array<{ schemaId: string }>).map(({ schemaId }) => schemaId),
    ).toEqual(expectedIds);
  });

  it("rejects an unknown schema identifier with a typed input failure", async () => {
    const envelope = await invokeJson([
      "--output",
      "json",
      "schema",
      "urn:cellarer:cli:protocol:1.0:missing",
    ]);

    expect(process.exitCode).toBe(2);
    expect(envelope).toMatchObject({
      command: "schema",
      status: "error",
      error: { code: "INVALID_INPUT" },
    });
  });
});

describe("CLI installed version metadata", () => {
  it("uses the CLI package metadata as the program version", () => {
    const packageMetadata = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(buildProgram().version()).toBe(packageMetadata.version);
  });
});

async function invokeJson(args: readonly string[]): Promise<TestEnvelope> {
  const stdout: string[] = [];
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  await buildProgram().parseAsync(["node", "cellarer", ...args], { from: "node" });

  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0] as string) as TestEnvelope;
}
