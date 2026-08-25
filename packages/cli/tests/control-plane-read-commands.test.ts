import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealEnv } from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEADLESS_MUTATION_AUTHORITY_ENV } from "../src/mutation-authority.js";
import { buildProgram } from "../src/program.js";
import { commandRegistry } from "../src/protocol/command-registry.js";
import { handleCliBoundaryError } from "../src/protocol/execution.js";
import { validateJsonSchema } from "../src/protocol/input.js";

const READ_ONLY_COMMANDS = [
  "resource.list",
  "resource.show",
  "agent.list",
  "agent.show",
  "collection.list",
  "collection.show",
  "config.show",
  "config.validate",
  "diff",
  "verify",
  "summary",
  "plan",
  "discovery.summary",
  "operation.list",
  "operation.show",
] as const;

describe("control-plane read commands", () => {
  let root: string;
  let storeRoot: string;
  let project: string;
  let previousHome: string | undefined;
  let previousAuthority: string | undefined;
  let previousExitCode: number | undefined;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-control-plane-read-")));
    storeRoot = join(root, "home");
    project = join(root, "project");
    await fs.mkdir(project, { recursive: true });
    previousHome = process.env.CELLARER_HOME;
    previousAuthority = process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    previousExitCode = process.exitCode;
    process.env.CELLARER_HOME = storeRoot;
    process.env[HEADLESS_MUTATION_AUTHORITY_ENV] =
      `v1:1:${Buffer.alloc(32, 0x4d).toString("base64url")}`;
    process.exitCode = undefined;

    expect(await invoke(["init"])).toMatchObject({ status: "success" });
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.CELLARER_HOME;
    else process.env.CELLARER_HOME = previousHome;
    if (previousAuthority === undefined) delete process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    else process.env[HEADLESS_MUTATION_AUTHORITY_ENV] = previousAuthority;
    process.exitCode = previousExitCode;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("publishes every implemented read command through the executable registry and tree", () => {
    const registered = commandRegistry.map(({ command }) => command);
    expect(registered).toEqual(expect.arrayContaining(READ_ONLY_COMMANDS));

    const program = buildProgram();
    for (const identity of READ_ONLY_COMMANDS) {
      const parts = identity.split(".");
      let current = program;
      for (const part of parts) {
        const child = current.commands.find((candidate) => candidate.name() === part);
        expect(child, identity).toBeDefined();
        current = child as typeof program;
      }
    }
  });

  it("filters and shows resources with provenance-oriented source, membership, and usage", async () => {
    const env = createRealEnv();
    const source = join(storeRoot, "store", "rules", "style.md");
    await env.fs.writeFile(source, "# style\n");
    const configPath = join(storeRoot, "config.json");
    const config = JSON.parse(await env.fs.readFile(configPath)) as {
      artifacts: Record<string, { collections: string[] }>;
    };
    config.artifacts["rules/style"] = { collections: ["default"] };
    await env.fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const list = await invoke([
      "resource",
      "list",
      "--kind",
      "rules",
      "--state",
      "managed",
      "--source",
      source,
      "--no-include-discovered",
    ]);
    expect(list).toMatchObject({
      status: "success",
      data: {
        resources: [
          {
            id: "rules/style",
            source,
            membership: { collections: ["default"] },
            selection: { desired: true, collections: ["default"] },
            usage: { desired: [{ collection: "default" }], applied: [] },
          },
        ],
      },
    });

    const show = await invoke(["resource", "show", "rules/style", "--no-include-discovered"]);
    expect(show).toMatchObject({ status: "success", data: { resource: { id: "rules/style" } } });
  });

  it("matches resources by applied target sync state and keeps filtered counts consistent", async () => {
    const source = join(storeRoot, "store", "rules", "style.md");
    await fs.writeFile(source, "# style\n", "utf8");
    const configPath = join(storeRoot, "config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      artifacts: Record<string, { collections: string[] }>;
    };
    config.artifacts["rules/style"] = { collections: ["default"] };
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    expect(await invoke(["apply", "--agent", "codex", "--dir", project, "--rules"])).toMatchObject({
      status: "success",
    });
    expect(
      await invoke([
        "resource",
        "list",
        "--state",
        "synced",
        "--destination",
        "project",
        "--dir",
        project,
        "--agent",
        "codex",
        "--no-include-discovered",
      ]),
    ).toMatchObject({
      status: "success",
      data: {
        resources: [{ id: "rules/style", usage: { applied: [{ state: "synced" }] } }],
        counts: { managed: 1, synced: 1, drifted: 0, missing: 0, blocked: 0 },
      },
    });

    await fs.writeFile(join(project, "AGENTS.md"), "# drifted\n", "utf8");
    expect(
      await invoke([
        "resource",
        "list",
        "--state",
        "drifted",
        "--destination",
        "project",
        "--dir",
        project,
        "--agent",
        "codex",
        "--no-include-discovered",
      ]),
    ).toMatchObject({
      status: "success",
      data: {
        resources: [{ id: "rules/style", usage: { applied: [{ state: "drifted" }] } }],
        counts: { managed: 1, synced: 0, drifted: 1, missing: 0, blocked: 0 },
      },
    });
  });

  it("shows agent, collection, config, diff, discovery, verification, and operation DTOs", async () => {
    const cases = [
      ["agent", "list", "--scope", "project", "--dir", project, "--agent", "claude-code"],
      ["agent", "show", "claude-code", "--scope", "project", "--dir", project],
      ["collection", "list"],
      ["collection", "show", "default"],
      ["config", "show"],
      ["diff", "--scope", "project", "--dir", project, "--agent", "claude-code"],
      ["verify", "--scope", "project", "--dir", project, "--agent", "claude-code"],
      ["summary", "--scope", "project", "--dir", project, "--agent", "claude-code"],
      [
        "discovery",
        "summary",
        "--destination",
        "project",
        "--dir",
        project,
        "--agent",
        "claude-code",
      ],
      ["operation", "list"],
    ] as const;

    for (const args of cases) {
      expect(await invoke(args), args.join(" ")).toMatchObject({ status: "success" });
    }

    const invalidConfig = await invoke([
      "config",
      "validate",
      "--config",
      '{"version":1,"unknown":true}',
    ]);
    expect(invalidConfig).toMatchObject({
      status: "success",
      data: { valid: false, issues: [{ path: "unknown" }] },
    });

    const requestPath = join(root, "config-validate-request.json");
    await fs.writeFile(
      requestPath,
      JSON.stringify({
        protocolVersion: "1.0",
        command: "config.validate",
        input: { config: { version: 1, unknown: true } },
      }),
      "utf8",
    );
    expect(await invoke(["--input", requestPath, "config", "validate"])).toMatchObject({
      status: "error",
      error: {
        code: "INVALID_INPUT",
        details: { issues: expect.arrayContaining([expect.stringContaining("unknown")]) },
      },
    });

    const operationList = await invoke(["operation", "list"]);
    const operationId = (operationList as { data: { operations: Array<{ operationId: string }> } })
      .data.operations[0]?.operationId;
    expect(operationId).toBeDefined();
    expect(await invoke(["operation", "show", operationId as string])).toMatchObject({
      status: "success",
      data: { operation: { operationId, recoveryStatus: "clean" } },
    });
    expect(await invoke(["operation", "list", "--limit", "-1"])).toMatchObject({
      status: "error",
      error: { code: "INVALID_INPUT" },
    });
  });

  it("validates defaultable config identically in human, JSON, JSONL, and structured modes", async () => {
    const before = await fs.readFile(join(storeRoot, "config.json"), "utf8");
    const normalized = {
      version: 1,
      defaults: { method: "symlink", collections: ["default"], secretMode: "env" },
      collections: {},
      artifacts: {},
      adapterOverrides: {},
      customAdapters: {},
    };
    const request = {
      protocolVersion: "1.0",
      command: "config.validate",
      input: { config: { version: 1 } },
    };
    const requestPath = join(root, "config-validate-minimal.json");
    await fs.writeFile(requestPath, JSON.stringify(request), "utf8");

    const fromJson = await invoke(["config", "validate", "--config", '{"version":1}']);
    const fromJsonl = await invokeWithOutput(
      ["config", "validate", "--config", '{"version":1}'],
      "jsonl",
    );
    const fromStructured = await invoke(["--input", requestPath, "config", "validate"]);
    const human = await invokeText(["config", "validate", "--config", '{"version":1}']);

    for (const result of [fromJson, fromJsonl, fromStructured]) {
      expect(result).toMatchObject({
        status: "success",
        data: { valid: true, config: normalized, issues: [] },
      });
    }
    expect(withoutVolatile(fromJsonl)).toEqual(withoutVolatile(fromJson));
    expect(withoutVolatile(fromStructured)).toEqual(withoutVolatile(fromJson));
    expect(human).toEqual({ stdout: "配置有效。\n", stderr: "" });
    expect(await fs.readFile(join(storeRoot, "config.json"), "utf8")).toBe(before);
  });

  it("rejects empty canonical config fields in every validation transport without effects", async () => {
    const configPath = join(storeRoot, "config.json");
    const before = await fs.readFile(configPath, "utf8");
    const config = { customAdapters: { custom: { rules: { global: "" } } } };
    const request = { protocolVersion: "1.0", command: "config.validate", input: { config } };

    const fromJson = await invoke(["config", "validate", "--config", JSON.stringify(config)]);
    const fromJsonl = await invokeWithOutput(
      ["config", "validate", "--config", JSON.stringify(config)],
      "jsonl",
    );
    const fromStructured = await invoke(["--input", "-", "config", "validate"], {
      stdinIsTTY: false,
      readInput: async () => JSON.stringify(request),
    });
    const human = await invokeText(["config", "validate", "--config", JSON.stringify(config)]);

    for (const result of [fromJson, fromJsonl]) {
      expect(result).toMatchObject({ status: "success", data: { valid: false } });
      expect(result).not.toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    }
    expect(fromStructured).toMatchObject({
      status: "error",
      error: { code: "INVALID_INPUT" },
    });
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("配置无效");
    expect(await fs.readFile(configPath, "utf8")).toBe(before);
  });

  it("classifies an invalid persisted config for show without mutating it", async () => {
    const configPath = join(storeRoot, "config.json");
    const invalid = '{"defaults":{"collections":[""]}}\n';
    await fs.writeFile(configPath, invalid, "utf8");

    const requestPath = join(root, "config-show.json");
    await fs.writeFile(
      requestPath,
      JSON.stringify({ protocolVersion: "1.0", command: "config.show", input: {} }),
      "utf8",
    );

    for (const output of ["json", "jsonl"] as const) {
      expect(await invokeWithOutput(["config", "show"], output)).toMatchObject({
        status: "error",
        error: { code: "DOMAIN_VALIDATION_FAILED" },
      });
    }
    expect(await invoke(["--input", requestPath, "config", "show"])).toMatchObject({
      status: "error",
      error: { code: "DOMAIN_VALIDATION_FAILED" },
    });
    const human = await invokeText(["config", "show"]);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("invalid config");
    expect(await fs.readFile(configPath, "utf8")).toBe(invalid);
  });

  it("preserves full public config metadata across human, JSON, JSONL, structured, and show output", async () => {
    const config = {
      version: 1,
      defaults: { method: "copy", collections: ["default"], secretMode: "env" },
      collections: { default: { description: "Default" } },
      artifacts: {
        "rules/style": {
          collections: ["default"],
          secretPatternSuppressions: [
            { source: "rules/style.md", rule: "github-pat", patternVersion: 1 },
          ],
        },
      },
      adapterOverrides: {},
      customAdapters: {
        custom: {
          mcp: {
            global: "~/.custom/mcp.json",
            format: "json",
            supportedSecretReferences: ["environment", "cellarer"],
          },
        },
      },
    };
    const requestPath = join(root, "config-validate-full.json");
    await fs.writeFile(
      requestPath,
      JSON.stringify({
        protocolVersion: "1.0",
        command: "config.validate",
        input: { config },
      }),
      "utf8",
    );

    const fromJson = await invoke(["config", "validate", "--config", JSON.stringify(config)]);
    const fromJsonl = await invokeWithOutput(
      ["config", "validate", "--config", JSON.stringify(config)],
      "jsonl",
    );
    const fromStructured = await invoke(["--input", requestPath, "config", "validate"]);
    const human = await invokeText(["config", "validate", "--config", JSON.stringify(config)]);

    for (const result of [fromJson, fromJsonl, fromStructured]) {
      const schema = commandRegistry.find(
        ({ command }) => command === "config.validate",
      )?.outputSchema;
      expect(schema ? validateJsonSchema(result, schema) : ["missing schema"]).toEqual([]);
      expect(result).toMatchObject({
        status: "success",
        data: {
          valid: true,
          config: {
            artifacts: {
              "rules/style": {
                secretPatternSuppressions: [
                  { source: "rules/style.md", rule: "github-pat", patternVersion: 1 },
                ],
              },
            },
            customAdapters: {
              custom: { mcp: { supportedSecretReferences: ["environment", "cellarer"] } },
            },
          },
        },
      });
    }
    expect(withoutVolatile(fromJsonl)).toEqual(withoutVolatile(fromJson));
    expect(withoutVolatile(fromStructured)).toEqual(withoutVolatile(fromJson));
    expect(human).toEqual({ stdout: "配置有效。\n", stderr: "" });

    await fs.writeFile(
      join(storeRoot, "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );
    for (const output of ["json", "jsonl"] as const) {
      const shown = await invokeWithOutput(["config", "show"], output);
      const schema = commandRegistry.find(({ command }) => command === "config.show")?.outputSchema;
      expect(schema ? validateJsonSchema(shown, schema) : ["missing schema"]).toEqual([]);
      expect(shown).toMatchObject({
        status: "success",
        data: {
          config: {
            artifacts: {
              "rules/style": {
                secretPatternSuppressions: [
                  { source: "rules/style.md", rule: "github-pat", patternVersion: 1 },
                ],
              },
            },
            customAdapters: {
              custom: { mcp: { supportedSecretReferences: ["environment", "cellarer"] } },
            },
          },
        },
      });
    }
  });

  it.each([
    "../x",
    "/x",
    "C:/x",
    "C:x",
    "c:/x",
    "//server/share",
    "\\\\server\\share",
    "\\\\?\\C:\\x",
    "rules:style.md",
    "rules/%2e%2e/style.md",
    "rules/%2Fstyle.md",
  ])("rejects structured suppression source %s before command execution", async (source) => {
    const configPath = join(storeRoot, "config.json");
    const before = await fs.readFile(configPath, "utf8");
    const request = {
      protocolVersion: "1.0",
      command: "config.validate",
      input: {
        config: {
          artifacts: {
            "rules/style": {
              secretPatternSuppressions: [{ source, rule: "github-pat", patternVersion: 1 }],
            },
          },
        },
      },
    };

    const result = await invoke(["--input", "-", "config", "validate"], {
      stdinIsTTY: false,
      readInput: async () => JSON.stringify(request),
    });

    expect(result).toMatchObject({
      status: "error",
      error: {
        code: "INVALID_INPUT",
        details: { issues: expect.arrayContaining([expect.stringContaining("source")]) },
      },
    });
    expect(await fs.readFile(configPath, "utf8")).toBe(before);
  });

  it("returns an authority-sealed read-only apply plan without mutating targets", async () => {
    await fs.writeFile(join(storeRoot, "store", "rules", "plan-style.md"), "# plan\n", "utf8");
    const target = join(project, "AGENTS.md");

    expect(
      await invoke(["plan", "--agent", "codex", "--scope", "project", "--dir", project, "--rules"]),
    ).toMatchObject({
      status: "success",
      data: {
        plan: {
          operation: "apply",
          baseRevision: expect.any(Number),
          targetPreconditions: expect.any(Array),
          authorization: {
            domain: "executable-plan-v1",
            algorithm: "HMAC-SHA-256",
          },
        },
        preview: { actions: expect.any(Array) },
      },
    });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "json",
    "jsonl",
  ] as const)("preserves schema-valid reference names in real resource DTO %s output", async (output) => {
    await fs.writeFile(
      join(storeRoot, "store", "mcp", "context.json"),
      '{"command":"context","env":{"TOKEN":"${CTX_TOKEN}"}}\n',
      "utf8",
    );
    await fs.writeFile(
      join(storeRoot, "state.json"),
      `${JSON.stringify({
        version: 2,
        owners: [
          {
            agent: "claude-code",
            scope: "global",
            capability: "mcp",
            target: join(root, "home", ".claude", "mcp.json"),
            artifactIds: ["mcp/context"],
            receipt: {
              method: "write",
              fingerprint: `sha256:${"a".repeat(64)}`,
              backup: null,
              generated: false,
              appliedAt: "2026-06-30T08:00:00.000Z",
            },
            secretRefs: ["CTX_TOKEN"],
          },
        ],
      })}\n`,
      "utf8",
    );

    const result = await invokeWithOutput(
      ["resource", "list", "--kind", "mcp", "--no-include-discovered"],
      output,
    );
    const schema = commandRegistry.find(({ command }) => command === "resource.list")?.outputSchema;
    expect(schema).toBeDefined();
    expect(schema ? validateJsonSchema(result, schema) : ["missing schema"]).toEqual([]);

    expect(result).toMatchObject({
      status: "success",
      data: {
        resources: [
          expect.objectContaining({
            id: "mcp/context",
            secretReferenceNames: ["CTX_TOKEN"],
          }),
        ],
      },
    });
  });

  it("derives bare argv, structured-file, and structured-stdin read defaults identically", async () => {
    for (const command of ["agent.list", "diff", "verify"] as const) {
      const request = { protocolVersion: "1.0", command, input: {} };
      const requestPath = join(root, `${command.replace(".", "-")}-defaults.json`);
      await fs.writeFile(requestPath, JSON.stringify(request), "utf8");
      const argv = command.split(".");
      const fromBareArgv = await invoke(argv);
      const fromFile = await invoke(["--input", requestPath, ...argv]);
      const fromStdin = await invoke(["--input", "-", ...argv], {
        stdinIsTTY: false,
        readInput: async () => JSON.stringify(request),
      });

      expect(fromBareArgv, command).toMatchObject({ status: "success" });
      expect(fromFile, command).toMatchObject({ status: "success" });
      expect(fromStdin, command).toMatchObject({ status: "success" });
      expect(withoutVolatile(fromBareArgv)).toEqual(withoutVolatile(fromFile));
      expect(withoutVolatile(fromStdin)).toEqual(withoutVolatile(fromFile));
    }
  });
});

async function invoke(
  args: readonly string[],
  inputIo?: {
    readonly stdinIsTTY: boolean;
    readonly readInput: (source: string) => Promise<string>;
  },
): Promise<Record<string, unknown>> {
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
    try {
      await buildProgram(inputIo).parseAsync(["node", "cellarer", "--output", "json", ...args], {
        from: "node",
      });
    } catch (error) {
      handleCliBoundaryError(error);
    }
  } finally {
    process.stdout.write = oldStdoutWrite;
    process.stderr.write = oldStderrWrite;
  }
  expect(stderr).toEqual([]);
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0] as string) as Record<string, unknown>;
}

async function invokeWithOutput(
  args: readonly string[],
  output: "json" | "jsonl",
): Promise<Record<string, unknown>> {
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
    await buildProgram().parseAsync(["node", "cellarer", "--output", output, ...args], {
      from: "node",
    });
  } finally {
    process.stdout.write = oldStdoutWrite;
    process.stderr.write = oldStderrWrite;
  }
  expect(stderr).toEqual([]);
  const records = stdout
    .join("")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  return records.at(-1) as Record<string, unknown>;
}

async function invokeText(
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const oldStdoutWrite = process.stdout.write;
  const oldStderrWrite = process.stderr.write;
  const oldConsoleLog = globalThis.console.log;
  const oldConsoleWarn = globalThis.console.warn;
  const oldConsoleError = globalThis.console.error;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  globalThis.console.log = (...data: unknown[]) => stdout.push(`${data.map(String).join(" ")}\n`);
  globalThis.console.warn = (...data: unknown[]) => stderr.push(`${data.map(String).join(" ")}\n`);
  globalThis.console.error = (...data: unknown[]) => stderr.push(`${data.map(String).join(" ")}\n`);
  try {
    await buildProgram().parseAsync(["node", "cellarer", ...args], { from: "node" });
  } finally {
    process.stdout.write = oldStdoutWrite;
    process.stderr.write = oldStderrWrite;
    globalThis.console.log = oldConsoleLog;
    globalThis.console.warn = oldConsoleWarn;
    globalThis.console.error = oldConsoleError;
  }
  return { stdout: stdout.join(""), stderr: stderr.join("") };
}

function withoutVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutVolatile);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["generatedAt", "verifiedAt", "requestId"].includes(key))
      .map(([key, child]) => [key, withoutVolatile(child)]),
  );
}
