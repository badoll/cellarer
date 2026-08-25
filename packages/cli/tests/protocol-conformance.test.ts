import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateControlPlaneConfig } from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredCommand } from "../src/protocol/command-registry.js";
import { validateJsonSchema } from "../src/protocol/input.js";
import { assertClosedJsonSchema, type JsonSchema } from "../src/protocol/schemas.js";

const authorityCredentials = vi.hoisted(() => new Map<string, string>());
const startServer = vi.hoisted(() =>
  vi.fn(async ({ port }: { port?: number }) => {
    const actualPort = port && port > 0 ? port : 4317;
    return {
      port: actualPort,
      ready: {
        schemaVersion: 1,
        apiVersion: "1.0",
        contractId: "cellarer-local-client-api-v1",
        lifecycle: "owned-v1",
        authMode: "bearer",
        pid: process.pid,
        baseUrl: `http://127.0.0.1:${actualPort}`,
      },
      closed: new Promise<void>(() => undefined),
      close: vi.fn(async () => undefined),
    };
  }),
);

vi.mock("../src/keychain.js", () => ({
  loadKeychainStore: () => ({ available: false as const, reason: "module-unavailable" as const }),
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

vi.mock("@cellarer/web", () => ({
  startServer,
  WEB_CLIENT_ASSET_ROOT: "/tmp/cellarer-test-web-assets",
}));

const [{ buildProgram }, { createCliCommandCatalog }, { commandRegistry }] = await Promise.all([
  import("../src/program.js"),
  import("../src/commands/command-catalog.js"),
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
  "resource.list": ({ project }) => [
    "resource",
    "list",
    "--destination",
    "project",
    "--dir",
    project,
    "--agent",
    "claude-code",
    "--no-include-discovered",
  ],
  "resource.show": ({ project }) => [
    "resource",
    "show",
    "rules/missing",
    "--destination",
    "project",
    "--dir",
    project,
    "--agent",
    "claude-code",
    "--no-include-discovered",
  ],
  "agent.list": ({ project }) => [
    "agent",
    "list",
    "--scope",
    "project",
    "--dir",
    project,
    "--agent",
    "claude-code",
  ],
  "agent.show": ({ project }) => [
    "agent",
    "show",
    "claude-code",
    "--scope",
    "project",
    "--dir",
    project,
  ],
  "agent.enable": () => ["agent", "enable", "codex", "--dry-run"],
  "agent.disable": () => ["agent", "disable", "codex", "--dry-run"],
  "agent.configure": () => [
    "agent",
    "configure",
    "codex",
    "--adapter",
    '{"displayName":"Codex Conformance"}',
    "--dry-run",
  ],
  "agent.reset": () => ["agent", "reset", "codex", "--dry-run"],
  "agent.add": () => [
    "agent",
    "add",
    "conformance-agent",
    "--adapter",
    '{"rules":{"global":"~/.conformance/RULES.md"}}',
    "--dry-run",
  ],
  "agent.update": () => [
    "agent",
    "update",
    "missing-conformance-agent",
    "--adapter",
    '{"rules":{"global":"~/.conformance/RULES.md"}}',
    "--dry-run",
  ],
  "agent.remove": () => ["agent", "remove", "missing-conformance-agent", "--dry-run"],
  "collection.list": () => ["collection", "list"],
  "collection.show": () => ["collection", "show", "default"],
  "collection.create": () => ["collection", "create", "conformance", "--resource", "", "--dry-run"],
  "collection.update": () => [
    "collection",
    "update",
    "default",
    "--description",
    "Conformance",
    "--dry-run",
  ],
  "collection.delete": () => ["collection", "delete", "default", "--dry-run"],
  "collection.members.set": () => [
    "collection",
    "members",
    "set",
    "default",
    "--resource",
    "",
    "--dry-run",
  ],
  "collection.defaults.set": () => [
    "collection",
    "defaults",
    "set",
    "--collection",
    "default",
    "--dry-run",
  ],
  "config.show": () => ["config", "show"],
  "config.validate": () => ["config", "validate", "--config", '{"version":1}'],
  "config.update": () => ["config", "update", "--settings", '{"method":"copy"}', "--dry-run"],
  "config.reset": () => ["config", "reset", "--field", "method", "--dry-run"],
  diff: ({ project }) => ["diff", "--scope", "project", "--dir", project, "--agent", "claude-code"],
  verify: ({ project }) => [
    "verify",
    "--scope",
    "project",
    "--dir",
    project,
    "--agent",
    "claude-code",
  ],
  summary: () => ["summary", "--no-include-plan-coverage"],
  "discovery.summary": ({ project }) => [
    "discovery",
    "summary",
    "--destination",
    "project",
    "--dir",
    project,
    "--agent",
    "claude-code",
  ],
  "operation.list": () => ["operation", "list"],
  "operation.show": () => ["operation", "show", "missing-operation"],
  "operation.recover": () => ["operation", "recover", "missing-operation", "--dry-run"],
  plan: () => ["plan", "--agent", "codex", "--rules"],
  "resource.dependencies": () => ["resource", "dependencies", "rules/missing"],
  "resource.check": () => ["resource", "check", "rules/missing"],
  "resource.update": () => ["resource", "update", "rules/missing", "--dry-run"],
  "resource.rename": () => ["resource", "rename", "rules/missing", "renamed", "--dry-run"],
  "resource.remove": () => ["resource", "remove", "rules/missing", "--dry-run"],
  "resource.export": ({ root }) => [
    "resource",
    "export",
    "rules/missing",
    join(root, "missing.bundle.json"),
    "--dry-run",
  ],
  "resource.import": ({ root }) => [
    "resource",
    "import",
    join(root, "missing.bundle.json"),
    "--dry-run",
  ],
  "profile.list": () => ["profile", "list"],
  "profile.show": () => ["profile", "show", "missing"],
  "profile.create": () => [
    "profile",
    "create",
    "conformance",
    "--desired",
    profileDesired(),
    "--dry-run",
  ],
  "profile.update": () => [
    "profile",
    "update",
    "missing",
    "--desired",
    profileDesired(),
    "--dry-run",
  ],
  "profile.delete": () => ["profile", "delete", "missing", "--dry-run"],
  "sync.plan": ({ project }) => ["sync", "plan", "missing", "--workspace-root", project],
  "sync.apply": ({ project }) => [
    "sync",
    "apply",
    "missing",
    "--workspace-root",
    project,
    "--plan",
    "{}",
  ],
  "sync.verify": ({ project }) => ["sync", "verify", "missing", "--workspace-root", project],
  "sync.uninstall": ({ project }) => [
    "sync",
    "uninstall",
    "missing",
    "--workspace-root",
    project,
    "--dry-run",
  ],
  "inventory.refresh": ({ project }) => ["inventory", "refresh", "--dir", project],
  "inventory.import.plan": () => [
    "inventory",
    "import",
    "plan",
    "--candidate",
    "inventory-candidate:v1:rules:missing",
    "--agent",
    "codex",
  ],
  "inventory.import.apply": () => ["inventory", "import", "apply", "--plan", "{}"],
} satisfies Record<RegisteredCommand, CommandCase>;

function profileDesired(): string {
  return JSON.stringify({
    agentIds: ["codex"],
    scope: "project",
    resourceIds: ["rules/missing"],
    collectionIds: [],
    capabilities: ["rules"],
    method: "copy",
    mergePolicy: "merge",
  });
}

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

  it("derives every protocol projection from one closed aggregate catalog", () => {
    const catalog = createCliCommandCatalog();
    const definitions = catalog.definitions;
    const schemaIds = definitions.flatMap((definition) => [
      definition.inputSchemaId,
      definition.outputSchemaId,
      ...(definition.eventSchemaId ? [definition.eventSchemaId] : []),
    ]);
    const publishedSchemas = catalog.getSchemaBundle()?.schemas ?? [];
    const publishedSchemaById = new Map(
      publishedSchemas.map(({ schemaId, schema }) => [schemaId, schema]),
    );
    const publishedSchemaIds = publishedSchemas.map(({ schemaId }) => schemaId);

    expect(catalog.definitions).toBe(catalog.contracts);
    expect(definitions.map(({ command }) => command)).toEqual(
      commandRegistry.map(({ command }) => command),
    );
    expect(catalog.contracts.map(({ catalogOrder }) => catalogOrder)).toEqual(
      catalog.contracts.map((_, index) => index),
    );
    expect(new Set(schemaIds).size).toBe(schemaIds.length);
    expect(publishedSchemaIds).toEqual(
      expect.arrayContaining([
        ...schemaIds,
        "urn:cellarer:cli:protocol:1.0:warning",
        "urn:cellarer:cli:protocol:1.0:error",
      ]),
    );
    expect(publishedSchemaIds).toHaveLength(schemaIds.length + 2);

    for (const definition of definitions) {
      const inputFields = Object.keys(
        definition.inputSchema.properties?.input?.properties ?? {},
      ).sort();
      const boundFields = [...new Set(definition.inputBindings.map(({ field }) => field))].sort();
      const bindingSources = definition.inputBindings.map(({ option, positional }) =>
        option === undefined ? `positional:${positional}` : `option:${option}`,
      );

      expect(boundFields, definition.command).toEqual(inputFields);
      expect(new Set(bindingSources).size, definition.command).toBe(bindingSources.length);
      expect(publishedSchemaById.get(definition.inputSchemaId), definition.command).toBe(
        definition.inputSchema,
      );
      expect(publishedSchemaById.get(definition.outputSchemaId), definition.command).toBe(
        definition.outputSchema,
      );
      if (definition.eventSchemaId) {
        expect(publishedSchemaById.get(definition.eventSchemaId), definition.command).toBe(
          definition.eventSchema,
        );
      }
    }
  });

  it("publishes a closed post-commit Inventory union only on relevant mutation results", () => {
    const definitions = Object.fromEntries(
      ["agent.add", "agent.update", "agent.remove", "agent.enable", "apply"].map((command) => [
        command,
        commandRegistry.find((candidate) => candidate.command === command),
      ]),
    );
    for (const definition of Object.values(definitions)) {
      if (!definition) throw new Error("expected mutation command definition");
      expect(() => assertClosedJsonSchema(definition.outputSchema)).not.toThrow();
    }

    const addRefresh =
      definitions["agent.add"]?.outputSchema.properties?.data?.properties
        ?.postCommitInventoryRefresh;
    const updateRefresh =
      definitions["agent.update"]?.outputSchema.properties?.data?.properties
        ?.postCommitInventoryRefresh;
    expect(addRefresh).toEqual(updateRefresh);
    expect(addRefresh?.oneOf).toHaveLength(3);
    expect(addRefresh?.oneOf?.map((variant) => variant.additionalProperties)).toEqual([
      false,
      false,
      false,
    ]);
    expect(addRefresh?.oneOf?.map((variant) => variant.properties?.status?.const)).toEqual([
      "complete",
      "partial",
      "failed",
    ]);
    expect(addRefresh?.oneOf?.slice(1).map((variant) => variant.required)).toEqual([
      ["agentId", "status", "inventory", "retryCommand"],
      ["agentId", "status", "inventory", "retryCommand"],
    ]);
    expect(addRefresh?.oneOf?.[1]?.properties?.retryCommand).toMatchObject({
      type: "string",
      pattern: expect.stringMatching(/^\^cellarer inventory refresh --agent /),
    });

    expect(
      definitions["agent.remove"]?.outputSchema.properties?.data?.properties,
    ).not.toHaveProperty("postCommitInventoryRefresh");
    expect(
      definitions["agent.enable"]?.outputSchema.properties?.data?.properties,
    ).not.toHaveProperty("postCommitInventoryRefresh");
    const applyBranches = definitions.apply?.outputSchema.properties?.data?.oneOf ?? [];
    expect(
      applyBranches.some((branch) =>
        Object.hasOwn(branch.properties ?? {}, "postCommitInventoryRefresh"),
      ),
    ).toBe(true);
  });

  it.each([
    ["minimal", { version: 1 }],
    ["partial defaults", { defaults: { method: "copy" } }],
    ["empty default collection name", { defaults: { collections: [""] } }],
    ["empty adapter path", { customAdapters: { custom: { rules: { global: "" } } } }],
    [
      "normalized suppression source",
      {
        artifacts: {
          "rules/style": {
            secretPatternSuppressions: [
              { source: "rules/nested/style.md", rule: "github-pat", patternVersion: 1 },
            ],
          },
        },
      },
    ],
    [
      "parent-traversing suppression source",
      {
        artifacts: {
          "rules/style": {
            secretPatternSuppressions: [{ source: "../x", rule: "github-pat", patternVersion: 1 }],
          },
        },
      },
    ],
    [
      "absolute suppression source",
      {
        artifacts: {
          "rules/style": {
            secretPatternSuppressions: [{ source: "/x", rule: "github-pat", patternVersion: 1 }],
          },
        },
      },
    ],
    [
      "nested parent-traversing suppression source",
      {
        artifacts: {
          "rules/style": {
            secretPatternSuppressions: [
              { source: "rules/../x", rule: "github-pat", patternVersion: 1 },
            ],
          },
        },
      },
    ],
    [
      "backslash suppression source",
      {
        artifacts: {
          "rules/style": {
            secretPatternSuppressions: [
              { source: "rules\\x", rule: "github-pat", patternVersion: 1 },
            ],
          },
        },
      },
    ],
    [
      "empty MCP metadata strings",
      {
        customAdapters: {
          custom: {
            mcp: {
              global: "",
              serversKey: "",
              supportedSecretReferences: [],
              dialect: { envKey: "" },
            },
          },
        },
      },
    ],
    [
      "full",
      {
        version: 1,
        defaults: {
          method: "copy",
          collections: ["default"],
          secretMode: "env",
          os: { darwin: { method: "symlink" } },
        },
        collections: { default: { description: "Default" } },
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
            enabled: true,
            detect: { global: ["~/.codex"], project: [".codex"] },
            rules: { global: "~/.codex/AGENTS.md", format: "markdown" },
          },
        },
        customAdapters: {
          custom: {
            displayName: "Custom",
            mcp: {
              global: "~/.custom/mcp.json",
              format: "json",
              supportedSecretReferences: ["environment"],
              dialect: { commandStyle: "array" },
            },
          },
        },
      },
    ],
    ["unknown field", { version: 1, unknown: true }],
    ["invalid defaults", { defaults: { method: "hardlink" } }],
    ["invalid nested field", { defaults: { os: { darwin: { method: "copy", extra: true } } } }],
    ["invalid adapter", { customAdapters: { empty: {} } }],
    [
      "plaintext secret-shaped adapter field",
      {
        customAdapters: {
          leaky: {
            mcp: {
              supportedSecretReferences: ["environment"],
              env: { TOKEN: "plaintext-secret" },
            },
          },
        },
      },
    ],
  ] as const)("matches Core config validation for %s input", (_name, config) => {
    const schema = commandRegistry.find(({ command }) => command === "config.validate")?.inputSchema
      .properties?.input?.properties?.config;
    if (!schema) throw new Error("expected config.validate input schema");

    expect(validateJsonSchema(config, schema).length === 0).toBe(
      validateControlPlaneConfig(config).valid,
    );
  });

  it.each([
    ["defaults collection", { defaults: { collections: [""] } }],
    ["artifact collection", { artifacts: { "rules/style": { collections: [""] } } }],
    ["adapter display name", { adapterOverrides: { custom: { displayName: "" } } }],
    ["global detection path", { adapterOverrides: { custom: { detect: { global: [""] } } } }],
    ["project detection path", { adapterOverrides: { custom: { detect: { project: [""] } } } }],
    ["global rules path", { customAdapters: { custom: { rules: { global: "" } } } }],
    ["project rules path", { customAdapters: { custom: { rules: { project: "" } } } }],
    ["global MCP path", { adapterOverrides: { custom: { mcp: { global: "" } } } }],
    ["project MCP path", { adapterOverrides: { custom: { mcp: { project: "" } } } }],
    ["MCP servers key", { adapterOverrides: { custom: { mcp: { serversKey: "" } } } }],
    ["MCP dialect env key", { adapterOverrides: { custom: { mcp: { dialect: { envKey: "" } } } } }],
    ["MCP dialect URL key", { adapterOverrides: { custom: { mcp: { dialect: { urlKey: "" } } } } }],
    [
      "MCP dialect type field",
      { adapterOverrides: { custom: { mcp: { dialect: { typeField: "" } } } } },
    ],
    [
      "MCP dialect stdio type",
      { adapterOverrides: { custom: { mcp: { dialect: { stdioType: "" } } } } },
    ],
    [
      "MCP dialect remote type",
      { adapterOverrides: { custom: { mcp: { dialect: { remoteType: "" } } } } },
    ],
    ["global skills path", { customAdapters: { custom: { skills: { global: "" } } } }],
    ["project skills path", { customAdapters: { custom: { skills: { project: "" } } } }],
    ["collection name", { collections: { "": {} } }],
    ["artifact ID", { artifacts: { "": {} } }],
    ["adapter override ID", { adapterOverrides: { "": { enabled: true } } }],
    ["custom adapter ID", { customAdapters: { "": { rules: { global: "RULES.md" } } } }],
  ] as const)("closes canonical config output against empty %s input", (_field, config) => {
    const definition = commandRegistry.find(({ command }) => command === "config.validate");
    const inputSchema = definition?.inputSchema.properties?.input?.properties?.config;
    const outputSchema = definition?.outputSchema.properties?.data?.properties?.config;
    if (!inputSchema || !outputSchema) throw new Error("expected config.validate schemas");

    expect(validateJsonSchema(config, inputSchema)).not.toEqual([]);
    expect(validateControlPlaneConfig(config).valid).toBe(false);
  });

  it.each([
    { version: 1 },
    { defaults: { method: "copy", collections: ["default"] } },
    {
      artifacts: {
        "rules/style": {
          collections: ["default"],
          secretPatternSuppressions: [
            { source: "rules/style.v2-guide.md", rule: "github-pat", patternVersion: 1 },
          ],
        },
      },
    },
    {
      customAdapters: {
        custom: {
          detect: { global: ["~/.custom"], project: [".custom"] },
          rules: { global: "~/.custom/RULES.md", project: ".custom/RULES.md" },
          mcp: {
            global: "~/.custom/mcp.json",
            project: ".custom/mcp.json",
            serversKey: "mcpServers",
            supportedSecretReferences: ["environment"],
            dialect: {
              envKey: "env",
              urlKey: "url",
              typeField: "type",
              stdioType: "stdio",
              remoteType: "remote",
            },
          },
          skills: { global: "~/.custom/skills", project: ".custom/skills" },
        },
      },
    },
  ] as const)("roundtrips every accepted config input to canonical schema-valid output", (config) => {
    const definition = commandRegistry.find(({ command }) => command === "config.validate");
    const inputSchema = definition?.inputSchema.properties?.input?.properties?.config;
    const outputSchema = definition?.outputSchema.properties?.data?.properties?.config;
    if (!inputSchema || !outputSchema) throw new Error("expected config.validate schemas");

    expect(validateJsonSchema(config, inputSchema)).toEqual([]);
    const validated = validateControlPlaneConfig(config);
    expect(validated.valid).toBe(true);
    if (!validated.valid) throw new Error("expected valid config fixture");
    expect(validateJsonSchema(validated.config, outputSchema)).toEqual([]);
  });

  it.each([
    "rules/style.md",
    "rules/nested/style.v2-guide.md",
    ".hidden/style-file.md",
    "rules/100%-style.md",
    "rules/style%zz.md",
  ] as const)("accepts normalized suppression source %s consistently", (source) => {
    const config = {
      artifacts: {
        "rules/style": {
          secretPatternSuppressions: [{ source, rule: "github-pat", patternVersion: 1 }],
        },
      },
    };
    const definition = commandRegistry.find(({ command }) => command === "config.validate");
    const inputSchema = definition?.inputSchema.properties?.input?.properties?.config;
    const outputSchema = definition?.outputSchema.properties?.data?.properties?.config;
    if (!inputSchema || !outputSchema) throw new Error("expected config.validate schemas");

    expect(validateJsonSchema(config, inputSchema)).toEqual([]);
    const validated = validateControlPlaneConfig(config);
    expect(validated.valid).toBe(true);
    if (!validated.valid) throw new Error("expected valid suppression source");
    expect(validateJsonSchema(validated.config, outputSchema)).toEqual([]);
  });

  it.each([
    ["drive absolute", "C:/x"],
    ["drive relative", "C:x"],
    ["lowercase drive", "c:/x"],
    ["UNC forward slash", "//server/share"],
    ["UNC backslash", "\\\\server\\share"],
    ["device path", "\\\\?\\C:\\x"],
    ["colon edge", "rules:style.md"],
    ["encoded parent", "rules/%2e%2e/style.md"],
    ["encoded slash", "rules/%2Fstyle.md"],
  ] as const)("rejects non-portable suppression source %s consistently", (_name, source) => {
    const config = {
      artifacts: {
        "rules/style": {
          secretPatternSuppressions: [{ source, rule: "github-pat", patternVersion: 1 }],
        },
      },
    };
    const schema = commandRegistry.find(({ command }) => command === "config.validate")?.inputSchema
      .properties?.input?.properties?.config;
    if (!schema) throw new Error("expected config.validate input schema");

    expect(validateJsonSchema(config, schema)).not.toEqual([]);
    expect(validateControlPlaneConfig(config).valid).toBe(false);
  });

  it.each([
    ["add", "vaultPassphraseFd"],
    ["apply", "vaultPassphraseFd"],
    ["apply", "snapshotPassphraseFd"],
    ["scan", "vaultPassphraseFd"],
    ["revert", "snapshotPassphraseFd"],
    ["operation.recover", "snapshotPassphraseFd"],
    ["sync.plan", "snapshotPassphraseFd"],
    ["sync.apply", "snapshotPassphraseFd"],
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

  it("defines mutually exclusive init location preview and phased Inventory output data", async () => {
    const definition = commandRegistry.find(({ command }) => command === "init");
    const dataSchema = definition?.outputSchema.properties?.data;
    if (!dataSchema) throw new Error("expected init output data schema");

    const dryRun = JSON.parse((await invoke(["--output", "json", "init", "--dry-run"])).stdout) as {
      data: Record<string, unknown>;
    };
    expect(validateAgainstSchema(dryRun.data, dataSchema)).toEqual([]);

    const committed = JSON.parse((await invoke(["--output", "json", "init"])).stdout) as {
      data: Record<string, unknown>;
    };
    expect(validateAgainstSchema(committed.data, dataSchema)).toEqual([]);

    expect(validateAgainstSchema({ ...committed.data, dryRun: true }, dataSchema)).toContain(
      "$: oneOf",
    );
    const { store: _store, ...missingCommittedField } = committed.data;
    expect(validateAgainstSchema(missingCommittedField, dataSchema)).toContain("$: oneOf");
    const { storeRoot: _storeRoot, ...missingDryRunField } = dryRun.data;
    expect(validateAgainstSchema(missingDryRunField, dataSchema)).toContain("$: oneOf");
  });

  it("rejects unknown nested fields in public operation receipts and distribution plans", async () => {
    const initialized = JSON.parse((await invoke(["--output", "json", "init"])).stdout) as {
      data: { store: { operation: { receipt: Record<string, unknown> } } };
    };
    initialized.data.store.operation.receipt.unexpectedReceiptField = true;
    const initDefinition = commandRegistry.find(({ command }) => command === "init");
    expect(
      validateAgainstSchema(initialized, initDefinition?.outputSchema as JsonSchema),
    ).toContain("$.data: oneOf");

    const planned = JSON.parse(
      (await invoke(["--output", "json", "plan", "--agent", "codex"])).stdout,
    ) as { data: { plan: { normalizedInputs: Record<string, unknown> } } };
    planned.data.plan.normalizedInputs.unexpectedPlanField = true;
    const planDefinition = commandRegistry.find(({ command }) => command === "plan");
    expect(validateAgainstSchema(planned, planDefinition?.outputSchema as JsonSchema)).toContain(
      "$.data.plan.normalizedInputs.unexpectedPlanField: additional property",
    );
  });

  it("uses the injected UI starter without opening a real service", async () => {
    await initializeStore();

    const tokenFd = await protectedDescriptor(context.secretValuePath);
    const lifetimeFd = await protectedDescriptor(context.secretValuePath);
    const captured = await invoke([
      "--output",
      "json",
      "ui",
      "--port",
      "4318",
      "--token-fd",
      String(tokenFd),
      "--lifetime-fd",
      String(lifetimeFd),
    ]);

    expect(startServer).toHaveBeenCalledOnce();
    expect(startServer).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { mode: "bearer", token: "test-secret-value" },
        lifetime: expect.anything(),
      }),
    );
    expect(captured.stderr).toBe("");
    expect(`${captured.stdout}${captured.stderr}`).not.toContain("test-secret-value");
    expect(captured.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(captured.stdout)).toMatchObject({
      status: "success",
      data: { baseUrl: "http://127.0.0.1:4318", authMode: "bearer" },
    });
  });

  it("returns a typed non-disclosing failure when UI startup fails before readiness", async () => {
    await initializeStore();
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    startServer.mockRejectedValueOnce(
      new Error(`sidecar startup failed at ${context.storeRoot} with ${canary}`),
    );

    const captured = await invoke(["--output", "json", "ui", "--port", "0"]);
    const observable = `${captured.stdout}${captured.stderr}`;
    const terminal = JSON.parse(captured.stdout) as {
      status?: string;
      error?: { code?: string };
    };

    expect(terminal).toMatchObject({ status: "error", error: { code: "INTERNAL_ERROR" } });
    expect(observable).not.toContain(canary);
    expect(observable).not.toContain(context.storeRoot);
    expect(observable).not.toContain('"status":"success"');
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

  it("rejects secret mutation authority before reading protected input", async () => {
    await initializeStore();
    authorityCredentials.clear();

    const captured = await invoke([
      "--output",
      "json",
      "secret",
      "add",
      "authority-first-token",
      "--fd",
      "2",
      "--passphrase-fd",
      "2",
    ]);

    expect(JSON.parse(captured.stdout)).toMatchObject({
      status: "error",
      error: { code: "POLICY_VIOLATION" },
    });
    expect(`${captured.stdout}${captured.stderr}`).not.toContain("inherited descriptor");
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
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(
      (member) => validateAgainstSchema(value, member, path).length === 0,
    ).length;
    if (matches !== 1) return [...issues, `${path}: oneOf`];
  }
  if (schema.anyOf) {
    const matches = schema.anyOf.filter(
      (member) => validateAgainstSchema(value, member, path).length === 0,
    ).length;
    if (matches === 0) issues.push(`${path}: anyOf`);
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    return [...issues, `${path}: type ${String(schema.type)}`];
  }

  if (isObject(value)) {
    const properties = schema.properties ?? {};
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      issues.push(`${path}: minProperties`);
    }
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
    if (type === "null") return value === null;
    return false;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
