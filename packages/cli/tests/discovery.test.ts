import { readFileSync } from "node:fs";
import { CLI_PROTOCOL_VERSION } from "@cellarer/core";
import type { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { createCliCommandCatalog } from "../src/commands/command-catalog.js";
import { buildProgram } from "../src/program.js";
import { commandFromCatalog } from "../src/protocol/command-contract.js";
import { commandRegistry, commandSchemas } from "../src/protocol/command-registry.js";
import { CLI_ERROR_SCHEMA, CLI_WARNING_SCHEMA } from "../src/protocol/schemas.js";

const originalStdoutWrite = process.stdout.write;
const originalExitCode = process.exitCode;
const INITIALIZATION_DISCOVERY_COMMANDS = ["init", "capabilities", "schema"] as const;

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
  it("drives initialization and discovery leaves from one parity-preserving domain catalog", () => {
    const aggregate = createCliCommandCatalog();
    const contracts = aggregate.contracts.filter(({ command }) =>
      INITIALIZATION_DISCOVERY_COMMANDS.includes(
        command as (typeof INITIALIZATION_DISCOVERY_COMMANDS)[number],
      ),
    );

    expect(contracts.map(({ command }) => command)).toEqual(INITIALIZATION_DISCOVERY_COMMANDS);
    expect(aggregate.definitions).toBe(aggregate.contracts);
    expect(aggregate.definitions.map(({ command }) => command)).toEqual(
      commandRegistry.map(({ command }) => command),
    );

    const program = buildProgram();
    for (const contract of contracts) {
      const published = commandRegistry.find(({ command }) => command === contract.command);
      expect(published).toBeDefined();
      expect(protocolProjection(contract)).toEqual(
        protocolProjection(published as NonNullable<typeof published>),
      );

      const registered = findLeaf(program, contract.command);
      const declared = contract.createCommand();
      expect(commanderProjection(registered)).toEqual(commanderProjection(declared));
    }
  });

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

  it("keeps standalone discovery backed by the complete aggregate", async () => {
    const stdout: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const command = commandFromCatalog(createCliCommandCatalog(), "capabilities");
    command.option("--json");

    await command.parseAsync(["node", "capabilities", "--json"], { from: "node" });

    const envelope = JSON.parse(stdout.join("")) as TestEnvelope;
    expect((envelope.data.commands as unknown[]).length).toBe(commandRegistry.length);
    expect(
      (envelope.data.commands as Array<{ command: string }>).map(({ command }) => command),
    ).toEqual(commandRegistry.map(({ command }) => command));
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

  it.each([
    "urn:cellarer:cli:protocol:1.0:command:scan:input",
    "urn:cellarer:cli:protocol:1.0:command:scan:output",
    "urn:cellarer:cli:protocol:1.0:command:scan:event",
    "urn:cellarer:cli:protocol:1.0:command:discovery.summary:input",
    "urn:cellarer:cli:protocol:1.0:command:discovery.summary:output",
  ])("returns the stable unsupported-schema failure for removed schema %s", async (schemaId) => {
    const envelope = await invokeJson(["--output", "json", "schema", schemaId]);

    expect(process.exitCode).toBe(2);
    expect(envelope).toMatchObject({
      command: "schema",
      status: "error",
      error: { code: "INVALID_INPUT" },
    });
  });

  it("advertises Inventory replacements without legacy scan or discovery contracts", async () => {
    const envelope = await invokeJson(["--output", "json", "capabilities"]);
    const commands = (envelope.data.commands as Array<{ command: string }>).map(
      ({ command }) => command,
    );

    expect(commands).toEqual(
      expect.arrayContaining([
        "inventory.refresh",
        "inventory.import.plan",
        "inventory.import.apply",
        "resource.list",
        "sync.plan",
      ]),
    );
    expect(commands).not.toContain("scan");
    expect(commands).not.toContain("discovery.summary");
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

function protocolProjection(definition: (typeof commandRegistry)[number]) {
  return {
    command: definition.command,
    mutability: definition.mutability,
    streaming: definition.streaming,
    requiredFeatures: definition.requiredFeatures,
    inputSchemaId: definition.inputSchemaId,
    outputSchemaId: definition.outputSchemaId,
    eventSchemaId: definition.eventSchemaId,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    eventSchema: definition.eventSchema,
    inputBindings: definition.inputBindings,
  };
}

function commanderProjection(command: Command) {
  return {
    name: command.name(),
    description: command.description(),
    arguments: command.registeredArguments.map((argument) => ({
      name: argument.name(),
      description: argument.description,
      required: argument.required,
      variadic: argument.variadic,
    })),
    options: command.options.map((option) => ({
      flags: option.flags,
      description: option.description,
      mandatory: option.mandatory,
      variadic: option.variadic,
    })),
  };
}

function findLeaf(program: Command, path: string): Command {
  let current = program;
  for (const segment of path.split(".")) {
    const child = current.commands.find((candidate) => candidate.name() === segment);
    if (!child) throw new Error(`missing Commander path ${path}`);
    current = child;
  }
  return current;
}

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
