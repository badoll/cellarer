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
    await buildProgram().parseAsync(["node", "cellarer", "init"], { from: "node" });

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
    await buildProgram().parseAsync(["node", "cellarer", "init"], { from: "node" });
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
        .filter((name) => name.endsWith(".ts"))
        .map(async (name) => [name, await fs.readFile(new URL(name, commandDir), "utf8")] as const),
    );

    for (const [name, source] of sources) {
      expect(source, name).toContain("executeCliCommand");
      expect(source, name).not.toContain("process.exitCode");
      expect(source, name).not.toMatch(/console\.(?:log|warn|error)\(JSON\.stringify\(/);
    }
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
