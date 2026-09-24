import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCliCommandCatalog } from "../src/commands/command-catalog.js";
import { HEADLESS_MUTATION_AUTHORITY_ENV } from "../src/mutation-authority.js";
import { buildProgram } from "../src/program.js";
import { handleCliBoundaryError } from "../src/protocol/execution.js";
import { validateJsonSchema } from "../src/protocol/input.js";

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
    await fs.mkdir(join(root, "home", ".agents", "skills", "inventory-demo"), {
      recursive: true,
    });
    await fs.writeFile(
      join(root, "home", ".agents", "skills", "inventory-demo", "SKILL.md"),
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

  it("keeps an alias-only Skill plan valid across JSON and JSONL while rejecting unknown link evidence", async () => {
    const alias = join(root, "home", ".agents", "skills", "inventory-demo");
    const target = join(root, "home", "shared", "inventory-demo");
    await fs.mkdir(target, { recursive: true });
    await fs.copyFile(join(alias, "SKILL.md"), join(target, "SKILL.md"));
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await fs.writeFile(join(target, "image.png"), imageBytes);
    await fs.rm(alias, { recursive: true });
    await fs.symlink(target, alias, "dir");

    const refreshed = await invokeJson(["inventory", "refresh", "--agent", "agents-md"]);
    const candidateId = (refreshed.data as { candidates: { id: string }[] }).candidates[0]?.id;
    expect(candidateId).toBeDefined();
    const args = [
      "inventory",
      "import",
      "plan",
      "--candidate",
      candidateId ?? "",
      "--agent",
      "agents-md",
    ];
    const json = await invokeJson(args);
    const jsonl = await invokeJson(args, "jsonl");
    expect(json).toMatchObject({ status: "success", data: { candidateIds: [candidateId] } });
    expect(jsonl).toMatchObject({ status: "success", data: { candidateIds: [candidateId] } });
    const jsonPlan = (
      json.data as { mutationPlan: { actions: { kind: string; payload: unknown }[] } }
    ).mutationPlan;
    const jsonlPlan = (
      jsonl.data as { mutationPlan: { actions: { kind: string; payload: unknown }[] } }
    ).mutationPlan;
    const contentPayload = (plan: typeof jsonPlan) =>
      plan.actions.find(({ kind }) => kind === "inventory-resource-content")?.payload;
    expect(contentPayload(jsonlPlan)).toEqual(contentPayload(jsonPlan));

    const contract = createCliCommandCatalog().requireContract("inventory.import.plan");
    const dataSchema = contract.outputSchema.properties?.data;
    if (!dataSchema) throw new Error("missing Inventory import plan data schema");
    expect(validateJsonSchema(json.data, dataSchema)).toEqual([]);
    const invalid = structuredClone(json.data) as {
      mutationPlan: { actions: { kind: string; payload: { source?: { link?: object } } }[] };
    };
    const content = invalid.mutationPlan.actions.find(
      ({ kind }) => kind === "inventory-resource-content",
    );
    if (!content?.payload.source?.link) throw new Error("missing linked-source evidence");
    content.payload.source.link = { ...content.payload.source.link, unexpected: true };
    expect(validateJsonSchema(invalid, dataSchema)).not.toEqual([]);

    const applied = await invokeJson([
      "inventory",
      "import",
      "apply",
      "--plan",
      JSON.stringify(jsonPlan),
    ]);
    expect(applied).toMatchObject({ status: "success", data: { operation: { ok: true } } });
    expect(
      await fs.readFile(join(root, "store", "store", "skills", "inventory-demo", "image.png")),
    ).toEqual(imageBytes);
    const metadata = await fs.readFile(
      join(root, "store", "store", "metadata", "skills", "inventory-demo.json"),
      "utf8",
    );
    expect(metadata).toContain("~/.agents/skills/inventory-demo");
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
