import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEADLESS_MUTATION_AUTHORITY_ENV } from "../src/mutation-authority.js";
import { buildProgram } from "../src/program.js";
import { handleCliBoundaryError } from "../src/protocol/execution.js";

describe("inventory refresh command", () => {
  let root: string;
  let previousCellarerHome: string | undefined;
  let previousHome: string | undefined;
  let previousAuthority: string | undefined;
  let previousExitCode: number | undefined;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-inventory-cli-")));
    previousCellarerHome = process.env.CELLARER_HOME;
    previousHome = process.env.HOME;
    previousAuthority = process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    previousExitCode = process.exitCode;
    process.env.CELLARER_HOME = join(root, "store");
    process.env.HOME = join(root, "home");
    process.env[HEADLESS_MUTATION_AUTHORITY_ENV] =
      `v1:1:${Buffer.alloc(32, 0x41).toString("base64url")}`;
    await fs.mkdir(join(root, "home", ".codex", "skills", "inventory-demo"), {
      recursive: true,
    });
    await fs.writeFile(
      join(root, "home", ".codex", "skills", "inventory-demo", "SKILL.md"),
      "---\nname: inventory-demo\ndescription: inventory fixture\n---\n",
      "utf8",
    );
    expect(await invokeJson(["init", "--agent", "codex"])).toMatchObject({ status: "success" });
  });

  afterEach(async () => {
    restoreEnv("CELLARER_HOME", previousCellarerHome);
    restoreEnv("HOME", previousHome);
    restoreEnv(HEADLESS_MUTATION_AUTHORITY_ENV, previousAuthority);
    process.exitCode = previousExitCode;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns the shared DTO for full and exact targeted refresh", async () => {
    const full = await invokeJson(["inventory", "refresh"]);
    const targeted = await invokeJson(["inventory", "refresh", "--agent", "codex"]);
    const jsonl = await invokeJson(["inventory", "refresh", "--agent", "codex"], "jsonl");

    expect(full).toMatchObject({
      command: "inventory.refresh",
      status: "success",
      data: {
        completeness: "complete",
        counts: { ready: 1 },
        candidates: [
          {
            kind: "skills",
            name: "inventory-demo",
            state: "ready",
            defaultSelected: true,
          },
        ],
      },
    });
    expect(withoutGeneratedAt(targeted.data)).toMatchObject({
      completeness: "complete",
      candidates: [{ name: "inventory-demo", state: "ready" }],
      findings: [],
    });
    expect(jsonl).toMatchObject({
      command: "inventory.refresh",
      status: "success",
      data: { completeness: "complete", candidates: [{ name: "inventory-demo" }] },
    });
  });
});

async function invokeJson(
  args: readonly string[],
  output: "json" | "jsonl" = "json",
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
      await buildProgram().parseAsync(
        ["node", "cellarer", "--output", output, "--non-interactive", ...args],
        { from: "node" },
      );
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

function withoutGeneratedAt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutGeneratedAt);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "generatedAt")
      .map(([key, child]) => [key, withoutGeneratedAt(child)]),
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
