import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredCommand } from "../src/protocol/command-registry.js";
import type { JsonSchema } from "../src/protocol/schemas.js";

const authorityCredentials = vi.hoisted(() => new Map<string, string>());
const startServer = vi.hoisted(() =>
  vi.fn(({ port }: { port?: number }) => ({ port: port ?? 4317 })),
);

vi.mock("../src/keychain.js", () => ({
  tryKeychainStore: () => null,
  tryAuthorityCredentialStore: () => ({
    async get(service: string, account: string) {
      const value = authorityCredentials.get(`${service}\0${account}`);
      return value === undefined ? { found: false as const } : { found: true as const, value };
    },
    async set(service: string, account: string, value: string) {
      authorityCredentials.set(`${service}\0${account}`, value);
    },
    async delete(service: string, account: string) {
      return authorityCredentials.delete(`${service}\0${account}`);
    },
  }),
}));

vi.mock("@cellarer/web", () => ({ startServer }));

const [{ buildProgram }, { commandRegistry }] = await Promise.all([
  import("../src/program.js"),
  import("../src/protocol/command-registry.js"),
]);

interface TestContext {
  readonly root: string;
  readonly storeRoot: string;
  readonly project: string;
  readonly skillSource: string;
  readonly secretValuePath: string;
  readonly vaultPassphrasePath: string;
}

interface CapturedInvocation {
  readonly stdout: string;
  readonly stderr: string;
}

type CommandCase = (context: TestContext) => readonly string[] | Promise<readonly string[]>;
const protectedDescriptors: number[] = [];

const commandCases = {
  init: () => ["init"],
  add: ({ skillSource }) => ["add", skillSource, "--list"],
  agents: ({ project }) => ["agents", "--dir", project],
  ls: () => ["ls"],
  apply: ({ project }) => [
    "apply",
    "--agent",
    "claude-code",
    "--dir",
    project,
    "--rules",
    "--dry-run",
  ],
  "authority.rotate": () => ["authority", "rotate"],
  scan: ({ project }) => [
    "scan",
    "--agent",
    "claude-code",
    "--dir",
    project,
    "--rules",
    "--dry-run",
  ],
  revert: ({ project }) => ["revert", "--dir", project, "--dry-run"],
  status: ({ project }) => ["status", "--dir", project],
  "secret.add": async (context) => [
    "secret",
    "add",
    "conformance-token",
    "--fd",
    String(await protectedDescriptor(context.secretValuePath)),
    "--passphrase-fd",
    String(await protectedDescriptor(context.vaultPassphrasePath)),
  ],
  "secret.ls": async (context) => [
    "secret",
    "ls",
    "--passphrase-fd",
    String(await protectedDescriptor(context.vaultPassphrasePath)),
  ],
  "secret.rm": async (context) => [
    "secret",
    "rm",
    "missing-conformance-token",
    "--passphrase-fd",
    String(await protectedDescriptor(context.vaultPassphrasePath)),
  ],
  doctor: ({ project }) => ["doctor", "--dir", project],
  ui: async (context) => [
    "ui",
    "--port",
    "4318",
    "--token-fd",
    String(await protectedDescriptor(context.secretValuePath)),
  ],
  capabilities: () => ["capabilities"],
  schema: () => ["schema"],
} satisfies Record<RegisteredCommand, CommandCase>;

describe("CLI command registry protocol conformance", () => {
  let context: TestContext;
  let previousCellarerHome: string | undefined;
  let previousExitCode: number | undefined;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "cellarer-cli-conformance-"));
    const storeRoot = join(root, "cellarer-home");
    const project = join(root, "project");
    const skillSource = join(root, "example-skill");
    const secretValuePath = join(root, "secret-value");
    const vaultPassphrasePath = join(root, "vault-passphrase");
    await Promise.all([
      mkdir(project, { recursive: true }),
      mkdir(skillSource, { recursive: true }),
      writeFile(secretValuePath, "test-secret-value\n", { mode: 0o600 }),
      writeFile(vaultPassphrasePath, "test-vault-passphrase\n", { mode: 0o600 }),
    ]);
    await writeFile(
      join(skillSource, "SKILL.md"),
      "---\nname: example-skill\ndescription: Protocol conformance fixture.\n---\n",
      "utf8",
    );
    await chmod(root, 0o700);
    context = {
      root,
      storeRoot,
      project,
      skillSource,
      secretValuePath,
      vaultPassphrasePath,
    };
    previousCellarerHome = process.env.CELLARER_HOME;
    previousExitCode = process.exitCode;
    process.env.CELLARER_HOME = storeRoot;
    process.exitCode = undefined;
    authorityCredentials.clear();
    startServer.mockClear();
  });

  afterEach(async () => {
    while (protectedDescriptors.length > 0) {
      closeSync(protectedDescriptors.pop() as number);
    }
    if (previousCellarerHome === undefined) delete process.env.CELLARER_HOME;
    else process.env.CELLARER_HOME = previousCellarerHome;
    process.exitCode = previousExitCode;
    await rm(context.root, { recursive: true, force: true });
  });

  it("defines one invocation case for every registered command", () => {
    expect(Object.keys(commandCases)).toEqual(commandRegistry.map(({ command }) => command));
  });

  it.each([
    ["add", "vaultPassphraseFd"],
    ["apply", "vaultPassphraseFd"],
    ["apply", "snapshotPassphraseFd"],
    ["scan", "vaultPassphraseFd"],
    ["revert", "snapshotPassphraseFd"],
    ["secret.add", "fd"],
    ["secret.add", "passphraseFd"],
    ["secret.ls", "passphraseFd"],
    ["secret.rm", "passphraseFd"],
    ["ui", "tokenFd"],
  ] as const)("constrains %s.%s to the inherited descriptor range", (command, field) => {
    const definition = commandRegistry.find((candidate) => candidate.command === command);
    const descriptorSchema = definition?.inputSchema.properties?.input?.properties?.[field];

    expect(descriptorSchema).toMatchObject({
      type: "integer",
      minimum: 3,
      maximum: 2_147_483_647,
    });
    expect(validateAgainstSchema(3, descriptorSchema as JsonSchema)).toEqual([]);
    expect(validateAgainstSchema(2_147_483_647, descriptorSchema as JsonSchema)).toEqual([]);
    expect(validateAgainstSchema(2_147_483_648, descriptorSchema as JsonSchema)).toContain(
      "$: maximum",
    );
    expect(validateAgainstSchema(Number.NaN, descriptorSchema as JsonSchema)).toContain(
      "$: type integer",
    );
  });

  for (const definition of commandRegistry) {
    it(`validates ${definition.command} JSON stdout against ${definition.outputSchemaId}`, async () => {
      if (definition.command !== "init") await initializeStore();
      if (definition.command === "apply") {
        await writeFile(join(context.storeRoot, "store", "rules", "style.md"), "# style\n");
      }

      const args = await commandCases[definition.command](context);
      const captured = await invoke(["--output", "json", ...args]);
      const lines = protocolLines(captured.stdout);

      expect(
        lines,
        `${definition.command} must emit exactly one terminal JSON record`,
      ).toHaveLength(1);
      expect(captured.stderr).toBe("");
      expect(captured.stdout + captured.stderr).not.toContain("test-secret-value");
      const terminal = JSON.parse(lines[0] as string) as unknown;
      expect(
        validateAgainstSchema(terminal, definition.outputSchema),
        `${definition.command} stdout must match ${definition.outputSchemaId}`,
      ).toEqual([]);
    });
  }

  for (const definition of commandRegistry.filter(({ streaming }) => streaming)) {
    it(`validates ${definition.command} JSONL events and exactly one terminal record`, async () => {
      await initializeStore();
      if (definition.command === "apply") {
        await writeFile(join(context.storeRoot, "store", "rules", "style.md"), "# style\n");
      }

      const args = await commandCases[definition.command](context);
      const captured = await invoke(["--output", "jsonl", ...args]);
      const records = protocolLines(captured.stdout).map((line) => JSON.parse(line) as unknown);
      const terminalRecords = records.filter(isTerminalRecord);
      const eventRecords = records.filter((record) => !isTerminalRecord(record));

      expect(captured.stderr).toBe("");
      expect(captured.stdout + captured.stderr).not.toContain("test-secret-value");
      expect(eventRecords.length).toBeGreaterThan(0);
      expect(terminalRecords).toHaveLength(1);
      expect(records.at(-1)).toBe(terminalRecords[0]);
      for (const event of eventRecords) {
        expect(
          validateAgainstSchema(event, definition.eventSchema as JsonSchema),
          `${definition.command} event must match ${definition.eventSchemaId}`,
        ).toEqual([]);
      }
      expect(
        validateAgainstSchema(terminalRecords[0], definition.outputSchema),
        `${definition.command} terminal must match ${definition.outputSchemaId}`,
      ).toEqual([]);
    });
  }

  it("uses the injected UI starter without opening a real service", async () => {
    await initializeStore();

    const tokenFd = await protectedDescriptor(context.secretValuePath);
    await invoke(["--output", "json", "ui", "--port", "4318", "--token-fd", String(tokenFd)]);

    expect(startServer).toHaveBeenCalledOnce();
    expect(startServer).toHaveBeenCalledWith(
      expect.objectContaining({ token: "test-secret-value" }),
    );
    expect(startServer.mock.results[0]?.value).toEqual({ port: 4318 });
  });

  it("rejects an out-of-range UI port as typed input before starting Web", async () => {
    await initializeStore();

    const captured = await invoke(["--output", "json", "ui", "--port", "70000"]);
    const terminal = JSON.parse(captured.stdout) as {
      status: string;
      error?: { code: string };
    };

    expect(terminal).toMatchObject({ status: "error", error: { code: "INVALID_INPUT" } });
    expect(process.exitCode).toBe(2);
    expect(startServer).not.toHaveBeenCalled();
  });

  it("maps a missing mutation authority to a stable policy failure", async () => {
    await Promise.all([
      mkdir(join(context.storeRoot, "store", "rules"), { recursive: true }),
      mkdir(join(context.storeRoot, "store", "mcp"), { recursive: true }),
      mkdir(join(context.storeRoot, "store", "skills"), { recursive: true }),
    ]);

    const captured = await invoke([
      "--output",
      "json",
      "apply",
      "--agent",
      "claude-code",
      "--dir",
      context.project,
      "--rules",
      "--dry-run",
    ]);

    expect(JSON.parse(captured.stdout)).toMatchObject({
      status: "error",
      error: { code: "POLICY_VIOLATION" },
    });
    expect(process.exitCode).toBe(3);
  });

  it("maps authority rotation refusal with an active journal to recovery required", async () => {
    await initializeStore();
    await mkdir(join(context.storeRoot, "operations"), { recursive: true });
    await writeFile(join(context.storeRoot, "operations", "active.json"), "malformed\n");

    const captured = await invoke(["--output", "json", "authority", "rotate"]);

    expect(JSON.parse(captured.stdout)).toMatchObject({
      status: "error",
      error: { code: "RECOVERY_REQUIRED" },
    });
    expect(process.exitCode).toBe(6);
  });

  async function initializeStore(): Promise<void> {
    const captured = await invoke(["--output", "json", "init"]);
    const terminal = JSON.parse(captured.stdout) as { status?: string };
    expect(terminal.status).toBe("success");
  }
});

async function protectedDescriptor(path: string): Promise<number> {
  const descriptor = openSync(path, "r");
  protectedDescriptors.push(descriptor);
  return descriptor;
}

async function invoke(args: readonly string[]): Promise<CapturedInvocation> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const oldStdoutWrite = process.stdout.write;
  const oldStderrWrite = process.stderr.write;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await buildProgram().parseAsync(["node", "cellarer", ...args], { from: "node" });
  } finally {
    process.stdout.write = oldStdoutWrite;
    process.stderr.write = oldStderrWrite;
  }
  return { stdout: stdout.join(""), stderr: stderr.join("") };
}

function protocolLines(stdout: string): string[] {
  const normalized = stdout.trimEnd();
  return normalized.length === 0 ? [] : normalized.split("\n");
}

function isTerminalRecord(value: unknown): boolean {
  return isObject(value) && (value.status === "success" || value.status === "error");
}

function validateAgainstSchema(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const issues: string[] = [];
  if (schema.const !== undefined && !Object.is(value, schema.const)) issues.push(`${path}: const`);
  if (schema.enum && !schema.enum.some((candidate) => Object.is(value, candidate))) {
    issues.push(`${path}: enum`);
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    return [...issues, `${path}: type ${String(schema.type)}`];
  }

  if (isObject(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in value)) issues.push(`${path}.${required}: required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) issues.push(`${path}.${key}: additional property`);
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) {
        issues.push(...validateAgainstSchema(value[key], propertySchema, `${path}.${key}`));
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      issues.push(...validateAgainstSchema(item, schema.items as JsonSchema, `${path}[${index}]`));
    });
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push(`${path}: minLength`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) issues.push(`${path}: pattern`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    issues.push(`${path}: minimum`);
  }
  if (typeof value === "number" && schema.maximum !== undefined && value > schema.maximum) {
    issues.push(`${path}: maximum`);
  }

  for (const member of schema.allOf ?? []) {
    issues.push(...validateAgainstSchema(value, member, path));
  }
  if (schema.if && validateAgainstSchema(value, schema.if, path).length === 0 && schema.then) {
    issues.push(...validateAgainstSchema(value, schema.then, path));
  }
  if (schema.not && validateAgainstSchema(value, schema.not, path).length === 0) {
    issues.push(`${path}: not`);
  }
  return issues;
}

function matchesType(value: unknown, expected: string | readonly string[]): boolean {
  const types = typeof expected === "string" ? [expected] : expected;
  return types.some((type) => {
    if (type === "object") return isObject(value);
    if (type === "array") return Array.isArray(value);
    if (type === "integer") return Number.isSafeInteger(value);
    if (type === "string") return typeof value === "string";
    if (type === "boolean") return typeof value === "boolean";
    return false;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
