import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEADLESS_MUTATION_AUTHORITY_ENV } from "../src/mutation-authority.js";
import { buildProgram } from "../src/program.js";

const TEST_MUTATION_AUTHORITY = `v1:1:${Buffer.alloc(32, 0x2b).toString("base64url")}`;

describe("CLI command protocol migration", () => {
  const cleanups: Array<() => Promise<void>> = [];
  let previousHome: string | undefined;
  let previousAuthority: string | undefined;
  let previousExitCode: number | undefined;

  beforeEach(() => {
    previousHome = process.env.CELLARER_HOME;
    previousAuthority = process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    process.env[HEADLESS_MUTATION_AUTHORITY_ENV] = TEST_MUTATION_AUTHORITY;
  });

  afterEach(async () => {
    process.exitCode = previousExitCode;
    if (previousHome === undefined) delete process.env.CELLARER_HOME;
    else process.env.CELLARER_HOME = previousHome;
    if (previousAuthority === undefined) {
      delete process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    } else {
      process.env[HEADLESS_MUTATION_AUTHORITY_ENV] = previousAuthority;
    }
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  it("renders read-only command DTOs through one JSON terminal envelope", async () => {
    const root = testRoot("cellarer-cli-read-protocol-");
    process.env.CELLARER_HOME = join(root, "home");
    await buildProgram().parseAsync(["node", "cellarer", "init", "--agent", "codex"], {
      from: "node",
    });

    const capture = captureProtocolStreams();
    try {
      await buildProgram().parseAsync(["node", "cellarer", "status", "--output", "json"], {
        from: "node",
      });
    } finally {
      capture.restore();
    }

    expect(capture.incidentalStdout).toEqual([]);
    expect(capture.stderr).toEqual([]);
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({
      protocolVersion: "1.0",
      command: "status",
      status: "success",
      data: { items: [] },
      warnings: [],
    });
  });

  it("renders mutation progress as JSONL events plus exactly one terminal result", async () => {
    const root = testRoot("cellarer-cli-jsonl-protocol-");
    const storeRoot = join(root, "home");
    const project = join(root, "project");
    process.env.CELLARER_HOME = storeRoot;
    await buildProgram().parseAsync(["node", "cellarer", "init", "--agent", "codex"], {
      from: "node",
    });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(join(storeRoot, "store", "rules", "style.md"), "# style\n", "utf8");

    const capture = captureProtocolStreams();
    try {
      await buildProgram().parseAsync(
        [
          "node",
          "cellarer",
          "apply",
          "--agent",
          "claude-code",
          "--dir",
          project,
          "--rules",
          "--dry-run",
          "--output",
          "jsonl",
        ],
        { from: "node" },
      );
    } finally {
      capture.restore();
    }

    expect(capture.incidentalStdout).toEqual([]);
    const records = capture.stdout
      .join("")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.length).toBeGreaterThan(1);
    expect(records.slice(0, -1).every((record) => "event" in record)).toBe(true);
    expect(records.filter((record) => "status" in record)).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({ command: "apply", status: "success" });
  });

  it("maps handled command validation through the shared error boundary", async () => {
    const root = testRoot("cellarer-cli-error-protocol-");
    process.env.CELLARER_HOME = join(root, "home");
    const capture = captureProtocolStreams();
    try {
      await buildProgram().parseAsync(
        [
          "node",
          "cellarer",
          "apply",
          "--agent",
          "claude-code",
          "--rules",
          "--secret-mode",
          "unsupported",
          "--output",
          "json",
        ],
        { from: "node" },
      );
    } finally {
      capture.restore();
    }

    expect(capture.incidentalStdout).toEqual([]);
    expect(capture.stderr).toEqual([]);
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({
      command: "apply",
      status: "error",
      error: { code: "INVALID_INPUT" },
    });
  });

  it("leaves no ad hoc JSON or exit-code mapping in leaf command modules", async () => {
    const commandDir = new URL("../src/commands/", import.meta.url);
    const sources = await Promise.all(
      (await fs.readdir(commandDir))
        .filter(
          (name) =>
            name.endsWith(".ts") && name !== "command-catalog.ts" && !name.endsWith("-catalog.ts"),
        )
        .map(async (name) => [name, await fs.readFile(new URL(name, commandDir), "utf8")] as const),
    );

    for (const [name, source] of sources) {
      expect(source, name).toMatch(/executeCliCommand|defineCommandContract/);
      expect(source, name).not.toContain("process.exitCode");
      expect(source, name).not.toMatch(/console\.(?:log|warn|error)\(JSON\.stringify\(/);
    }
  });

  it("keeps the aggregate contracts as the only command-definition authority", async () => {
    const sourceRoot = new URL("../src/", import.meta.url);
    const sourceFiles = [
      "commands/command-catalog.ts",
      "protocol/command-contract.ts",
      "protocol/command-schema-fragments.ts",
      "protocol/input.ts",
      "protocol/renderer.ts",
    ];
    const sources = await Promise.all(
      sourceFiles.map(
        async (name) => [name, await fs.readFile(new URL(name, sourceRoot), "utf8")] as const,
      ),
    );

    for (const [name, source] of sources) {
      expect(source, name).not.toMatch(/commandDefinitionSeeds|getCommandDefinitionSeed/);
      expect(source, name).not.toContain("defineCommandContractFromDefinition");
    }
    expect(sources.find(([name]) => name === "commands/command-catalog.ts")?.[1]).not.toMatch(
      /createCommandCatalog\([\s\S]*?,\s*[^)]*COMMANDS/,
    );
    expect(
      sources.find(([name]) => name === "protocol/command-schema-fragments.ts")?.[1],
    ).not.toMatch(/command:\s*["`]/);
  });

  it("guards against partial catalogs, optional definitions, and replaceable renderer authority", async () => {
    const sourceRoot = new URL("../src/", import.meta.url);
    const commandDirectory = new URL("commands/", sourceRoot);
    const domainCatalogNames = (await fs.readdir(commandDirectory)).filter(
      (name) => name.endsWith("-catalog.ts") && name !== "command-catalog.ts",
    );
    const domainCatalogs = await Promise.all(
      domainCatalogNames.map(
        async (name) => [name, await fs.readFile(new URL(name, commandDirectory), "utf8")] as const,
      ),
    );
    for (const [name, source] of domainCatalogs) {
      expect(source, name).not.toMatch(/\bCommandCatalog\b|\bcreateCommandCatalog\b/);
    }

    const [commandContract, input, execution, renderer] = await Promise.all(
      [
        "protocol/command-contract.ts",
        "protocol/input.ts",
        "protocol/execution.ts",
        "protocol/renderer.ts",
      ].map((name) => fs.readFile(new URL(name, sourceRoot), "utf8")),
    );
    expect(commandContract).not.toMatch(/\bgetDefinition\b|\bcommandFromContract\b/);
    expect(input).not.toMatch(/definitionLookup|CommandDefinitionLookup/);
    expect(renderer).not.toMatch(/readonly authority|readonly definition\?|readonly allowUnknown/);
    expect(commandContract).toContain(
      "catalog.resolveExecutableMatch(catalog.matchExecutable(command))",
    );
    expect(commandContract).toContain('"definition" in options');
    expect(execution).not.toContain("definitionForBoundaryInvocation");
    expect(execution).not.toMatch(/allowUnknownCommand|authority:/);
    expect(execution).toMatch(/createProtocolRenderer\(\{[\s\S]{0,120}command:/);
  });

  function testRoot(prefix: string): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    return root;
  }
});

function captureProtocolStreams(): {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly incidentalStdout: string[];
  restore(): void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const incidentalStdout: string[] = [];
  const oldStdoutWrite = process.stdout.write;
  const oldStderrWrite = process.stderr.write;
  const oldLog = console.log;
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  console.log = (message?: unknown) => incidentalStdout.push(String(message));
  return {
    stdout,
    stderr,
    incidentalStdout,
    restore() {
      process.stdout.write = oldStdoutWrite;
      process.stderr.write = oldStderrWrite;
      console.log = oldLog;
    },
  };
}
