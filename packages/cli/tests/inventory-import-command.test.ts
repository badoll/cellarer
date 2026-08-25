import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEADLESS_MUTATION_AUTHORITY_ENV } from "../src/mutation-authority.js";
import { buildProgram } from "../src/program.js";
import { handleCliBoundaryError } from "../src/protocol/execution.js";

describe("inventory import plan/apply commands", () => {
  let root: string;
  let previousCellarerHome: string | undefined;
  let previousHome: string | undefined;
  let previousAuthority: string | undefined;
  let previousExitCode: number | undefined;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-inventory-import-cli-")));
    previousCellarerHome = process.env.CELLARER_HOME;
    previousHome = process.env.HOME;
    previousAuthority = process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    previousExitCode = process.exitCode;
    process.env.CELLARER_HOME = join(root, "store");
    process.env.HOME = join(root, "home");
    process.env[HEADLESS_MUTATION_AUTHORITY_ENV] =
      `v1:1:${Buffer.alloc(32, 0x42).toString("base64url")}`;
    await fs.mkdir(join(root, "home", ".codex", "skills", "inventory-demo"), {
      recursive: true,
    });
    await fs.writeFile(
      join(root, "home", ".codex", "skills", "inventory-demo", "SKILL.md"),
      "---\nname: inventory-demo\ndescription: inventory fixture\n---\n",
      "utf8",
    );
    expect(await invokeJson(["init"])).toMatchObject({ status: "success" });
  });

  afterEach(async () => {
    restoreEnv("CELLARER_HOME", previousCellarerHome);
    restoreEnv("HOME", previousHome);
    restoreEnv(HEADLESS_MUTATION_AUTHORITY_ENV, previousAuthority);
    process.exitCode = previousExitCode;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("requires exact candidates and applies the unchanged serializable receipt", async () => {
    const missing = await invokeJson(["inventory", "import", "plan"]);
    expect(missing).toMatchObject({ status: "error", error: { code: "INPUT_REQUIRED" } });
    const invalidApply = await invokeJson(["inventory", "import", "apply", "--plan", "{}"]);
    expect(invalidApply).toMatchObject({
      status: "error",
      error: { code: "DOMAIN_VALIDATION_FAILED" },
    });

    const refreshed = await invokeJson(["inventory", "refresh", "--agent", "codex"]);
    const candidateId = (
      (refreshed.data as { candidates: { id: string }[] }).candidates[0] as {
        id: string;
      }
    ).id;
    const planned = await invokeJson([
      "inventory",
      "import",
      "plan",
      "--candidate",
      candidateId,
      "--agent",
      "codex",
    ]);
    expect(planned).toMatchObject({
      command: "inventory.import.plan",
      status: "success",
      data: { candidateIds: [candidateId], mutationPlan: { operation: "store-import" } },
    });

    const mutationPlan = (planned.data as { mutationPlan: unknown }).mutationPlan;
    const applied = await invokeJson([
      "inventory",
      "import",
      "apply",
      "--plan",
      JSON.stringify(mutationPlan),
    ]);
    expect(applied).toMatchObject({
      command: "inventory.import.apply",
      status: "success",
      data: {
        candidateIds: [candidateId],
        resourceIds: ["skills/inventory-demo"],
        operation: { ok: true, receipt: { outcome: "committed", resultingRevision: 2 } },
      },
    });
    await expect(
      fs.readFile(join(root, "store", "store", "skills", "inventory-demo", "SKILL.md"), "utf8"),
    ).resolves.toContain("name: inventory-demo");
  });
});

async function invokeJson(args: readonly string[]): Promise<Record<string, unknown>> {
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
        ["node", "cellarer", "--output", "json", "--non-interactive", ...args],
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
