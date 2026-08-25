import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCliCommandCatalog } from "../src/commands/command-catalog.js";
import { buildProgram } from "../src/program.js";
import { runCli } from "../src/runner.js";

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;
const originalExitCode = process.exitCode;
const originalCellarerHome = process.env.CELLARER_HOME;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  process.exitCode = originalExitCode;
  if (originalCellarerHome === undefined) delete process.env.CELLARER_HOME;
  else process.env.CELLARER_HOME = originalCellarerHome;
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("removed CLI discovery and scan surfaces", () => {
  it("does not register executable leaves, aliases, capabilities, or schemas", () => {
    const catalog = createCliCommandCatalog();
    const program = buildProgram();
    const commands = catalog.definitions.map(({ command }) => command);
    const roots = program.commands.map((command) => command.name());

    expect(commands).not.toContain("scan");
    expect(commands).not.toContain("discovery.summary");
    expect(roots).not.toContain("scan");
    expect(roots).not.toContain("discovery");
    for (const schemaId of [
      "urn:cellarer:cli:protocol:1.0:command:scan:input",
      "urn:cellarer:cli:protocol:1.0:command:scan:output",
      "urn:cellarer:cli:protocol:1.0:command:scan:event",
      "urn:cellarer:cli:protocol:1.0:command:discovery.summary:input",
      "urn:cellarer:cli:protocol:1.0:command:discovery.summary:output",
    ]) {
      expect(catalog.getSchemaBundle(schemaId)).toBeUndefined();
    }
  });

  it.each([
    ["scan", ["scan", "--agent", "codex", "--rules", "--dry-run"]],
    ["discovery", ["discovery", "summary", "--destination", "user"]],
  ] as const)("rejects removed %s input before Store or authority effects", async (command, args) => {
    const root = await mkdtemp(join(tmpdir(), "cellarer-removed-cli-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const storeRoot = join(root, "store-that-must-not-exist");
    process.env.CELLARER_HOME = storeRoot;

    const captured = await invoke(["--output", "json", ...args]);

    expect(captured.stderr).toBe("");
    expect(JSON.parse(captured.stdout)).toMatchObject({
      command,
      status: "error",
      error: { code: "INVALID_USAGE" },
    });
    expect(process.exitCode).toBe(2);
    await expect(access(storeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function invoke(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  await runCli(["node", "cellarer", ...args]);
  return { stdout: stdout.join(""), stderr: stderr.join("") };
}
