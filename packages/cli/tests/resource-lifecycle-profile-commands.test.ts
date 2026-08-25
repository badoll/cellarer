import { closeSync, promises as fs, mkdtempSync, openSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCliCommandCatalog } from "../src/commands/command-catalog.js";
import { HEADLESS_MUTATION_AUTHORITY_ENV } from "../src/mutation-authority.js";
import { buildProgram } from "../src/program.js";
import { commandRegistry } from "../src/protocol/command-registry.js";
import { handleCliBoundaryError } from "../src/protocol/execution.js";

const COMMANDS = [
  "resource.dependencies",
  "resource.check",
  "resource.update",
  "resource.rename",
  "resource.remove",
  "resource.export",
  "resource.import",
  "profile.list",
  "profile.show",
  "profile.create",
  "profile.update",
  "profile.delete",
  "sync.plan",
  "sync.apply",
  "sync.verify",
  "sync.uninstall",
] as const;

const desired = JSON.stringify({
  agentIds: ["codex"],
  scope: "project",
  resourceIds: ["rules/style"],
  collectionIds: [],
  capabilities: ["rules"],
  method: "copy",
  mergePolicy: "merge",
});

describe("resource lifecycle and sync-profile commands", () => {
  let root: string;
  let storeRoot: string;
  let previousHome: string | undefined;
  let previousAuthority: string | undefined;
  let previousExitCode: number | undefined;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-lifecycle-cli-")));
    storeRoot = join(root, "home");
    previousHome = process.env.CELLARER_HOME;
    previousAuthority = process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    previousExitCode = process.exitCode;
    process.env.CELLARER_HOME = storeRoot;
    process.env[HEADLESS_MUTATION_AUTHORITY_ENV] =
      `v1:1:${Buffer.alloc(32, 0x7d).toString("base64url")}`;
    process.exitCode = undefined;
    expect(await invoke(["init", "--agent", "codex"], "json")).toMatchObject({
      status: "success",
    });
    await fs.mkdir(join(root, "project"), { recursive: true });
    await fs.writeFile(join(storeRoot, "store", "rules", "style.md"), "# Style\n", "utf8");
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.CELLARER_HOME;
    else process.env.CELLARER_HOME = previousHome;
    if (previousAuthority === undefined) delete process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    else process.env[HEADLESS_MUTATION_AUTHORITY_ENV] = previousAuthority;
    process.exitCode = previousExitCode;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("drives every lifecycle and sync leaf from one parity-preserving domain catalog", () => {
    const catalog = createCliCommandCatalog();
    const contracts = catalog.contracts.filter(({ command }) =>
      COMMANDS.includes(command as (typeof COMMANDS)[number]),
    );

    expect(contracts.map(({ command }) => command)).toEqual(COMMANDS);
    for (const contract of contracts) {
      const definition = commandRegistry.find(({ command }) => command === contract.command);
      expect(definition).toBeDefined();
      expect(protocolProjection(contract)).toEqual(protocolProjection(definition));
      expect(commanderProjection(findLeaf(buildProgram(), contract.command))).toEqual(
        commanderProjection(contract.createCommand()),
      );
    }
  });

  it("registers every lifecycle/profile schema and executable leaf", () => {
    expect(commandRegistry.map(({ command }) => command)).toEqual(expect.arrayContaining(COMMANDS));
    const program = buildProgram();
    for (const identity of COMMANDS) {
      let current = program;
      for (const part of identity.split(".")) {
        current = current.commands.find((candidate) => candidate.name() === part) as typeof program;
        expect(current, identity).toBeDefined();
      }
    }
  });

  it("renders lifecycle DTOs in text, JSON, and JSONL", async () => {
    const json = await invoke(["resource", "check", "rules/style"], "json");
    expect(json).toMatchObject({
      command: "resource.check",
      status: "success",
      data: { status: "uncheckable", resourceId: "rules/style" },
    });
    const jsonl = await invoke(["resource", "dependencies", "rules/style"], "jsonl");
    expect(jsonl).toMatchObject({
      command: "resource.dependencies",
      status: "success",
      data: { resourceId: "rules/style", collections: [], profiles: [], ownedTargets: [] },
    });
    const text = await invokeText(["resource", "check", "rules/style"]);
    expect(text.stderr).toBe("");
    expect(text.stdout).toContain("rules/style: uncheckable");
  });

  it("runs profile CRUD and exact sync plan/apply/verify/uninstall DTOs", async () => {
    const created = await invoke(["profile", "create", "daily", "--desired", desired], "json");
    expect(created, JSON.stringify(created)).toMatchObject({
      status: "success",
      data: {
        profile: { profileId: "daily" },
        operation: { ok: true, receipt: { outcome: "committed" } },
      },
    });
    expect(await invoke(["profile", "list"], "jsonl")).toMatchObject({
      status: "success",
      data: { profiles: [{ profileId: "daily" }] },
    });
    expect((await invokeText(["profile", "show", "daily"])).stdout).toContain("daily");

    const planned = await invoke(
      ["sync", "plan", "daily", "--workspace-root", join(root, "project")],
      "json",
    );
    const plan = (planned.data as { mutationPlan: unknown }).mutationPlan;
    const target = (
      planned.data as { plan: { actions: readonly { target: string; capability?: string }[] } }
    ).plan.actions.find((action) => action.capability === "rules")?.target;
    if (!target) throw new Error("expected planned rule target");
    expect(planned).toMatchObject({
      status: "success",
      data: { profile: { profileId: "daily" }, resolvedResources: [{ resourceId: "rules/style" }] },
    });
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await invoke(
        [
          "sync",
          "apply",
          "daily",
          "--workspace-root",
          join(root, "project"),
          "--plan",
          JSON.stringify(plan),
        ],
        "jsonl",
      ),
    ).toMatchObject({
      status: "success",
      data: {
        profileId: "daily",
        operation: { ok: true, receipt: { outcome: "committed" } },
      },
    });
    await expect(fs.readFile(target, "utf8")).resolves.toContain("# Style");
    expect(
      await invoke(["sync", "verify", "daily", "--workspace-root", join(root, "project")], "json"),
    ).toMatchObject({
      status: "success",
      data: { profileId: "daily", healthy: true },
    });
    expect(
      await invoke(
        ["sync", "uninstall", "daily", "--workspace-root", join(root, "project"), "--dry-run"],
        "json",
      ),
    ).toMatchObject({
      status: "success",
      data: { profile: { profileId: "daily" }, targets: [{ blocked: false }] },
    });
  }, 30_000);

  it("reads profile replacement snapshot passphrases only from protected descriptors", async () => {
    const created = await invoke(["profile", "create", "replace", "--desired", desired], "json");
    expect(created).toMatchObject({ status: "success" });
    const initial = await invoke(
      ["sync", "plan", "replace", "--workspace-root", join(root, "project")],
      "json",
    );
    const target = (
      initial.data as { plan: { actions: readonly { target: string; capability?: string }[] } }
    ).plan.actions.find((action) => action.capability === "rules")?.target;
    if (!target) throw new Error("expected planned rule target");
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, "user-owned\n", "utf8");

    const blocked = await invoke(
      ["sync", "plan", "replace", "--workspace-root", join(root, "project")],
      "json",
    );
    const replacement = (
      blocked.data as {
        plan: { conflicts: readonly { acknowledgement?: { token?: string } }[] };
      }
    ).plan.conflicts[0]?.acknowledgement?.token;
    if (!replacement) throw new Error("expected replacement acknowledgement");

    const passphrase = "profile-cli-snapshot-passphrase";
    const passphrasePath = join(root, "profile-snapshot-passphrase");
    await fs.writeFile(passphrasePath, `${passphrase}\n`, { mode: 0o600 });
    const planFd = openSync(passphrasePath, "r");
    let acknowledged: Record<string, unknown>;
    try {
      acknowledged = await invoke(
        [
          "sync",
          "plan",
          "replace",
          "--workspace-root",
          join(root, "project"),
          "--replace-unowned",
          replacement,
          "--snapshot-passphrase-fd",
          String(planFd),
        ],
        "json",
      );
    } finally {
      closeSync(planFd);
    }
    expect(acknowledged).toMatchObject({
      status: "success",
      data: { plan: { conflicts: [] } },
    });
    expect(JSON.stringify(acknowledged)).not.toContain(passphrase);

    const mutationPlan = (acknowledged.data as { mutationPlan: unknown }).mutationPlan;
    const applyFd = openSync(passphrasePath, "r");
    let applied: Record<string, unknown>;
    try {
      applied = await invoke(
        [
          "sync",
          "apply",
          "replace",
          "--workspace-root",
          join(root, "project"),
          "--replace-unowned",
          replacement,
          "--snapshot-passphrase-fd",
          String(applyFd),
          "--plan",
          JSON.stringify(mutationPlan),
        ],
        "json",
      );
    } finally {
      closeSync(applyFd);
    }
    expect(applied).toMatchObject({ status: "success", data: { operation: { ok: true } } });
    expect(JSON.stringify(applied)).not.toContain(passphrase);
    expect(await fs.readFile(target, "utf8")).toContain("# Style");
    expect(await readTreeText(storeRoot)).not.toContain(passphrase);
    expect(await readTreeText(join(root, "project"))).not.toContain(passphrase);
  }, 30_000);

  it("maps a missing project workspace root to INPUT_REQUIRED in text, JSON, and JSONL", async () => {
    expect(
      await invoke(["profile", "create", "project", "--desired", desired], "json"),
    ).toMatchObject({ status: "success" });

    for (const output of ["json", "jsonl"] as const) {
      const result = await invoke(["sync", "plan", "project"], output);
      expect(result).toMatchObject({
        command: "sync.plan",
        status: "error",
        error: {
          code: "INPUT_REQUIRED",
          details: { coreCode: "WORKSPACE_ROOT_REQUIRED", fields: ["workspaceRoot"] },
        },
      });
      expect(process.exitCode).toBe(2);
    }

    const text = await invokeText(["sync", "plan", "project"]);
    expect(text.stdout).toBe("");
    expect(text.stderr).toContain("project-scoped profile requires an explicit workspace root");
    expect(process.exitCode).toBe(2);
  });
});

async function invoke(
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
    try {
      await buildProgram().parseAsync(["node", "cellarer", "--output", output, ...args], {
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
  const oldLog = console.log;
  const oldWarn = console.warn;
  const oldError = console.error;
  process.exitCode = undefined;
  console.log = (...data: unknown[]) => stdout.push(`${data.map(String).join(" ")}\n`);
  console.warn = (...data: unknown[]) => stderr.push(`${data.map(String).join(" ")}\n`);
  console.error = (...data: unknown[]) => stderr.push(`${data.map(String).join(" ")}\n`);
  try {
    await buildProgram().parseAsync(["node", "cellarer", ...args], { from: "node" });
  } finally {
    console.log = oldLog;
    console.warn = oldWarn;
    console.error = oldError;
  }
  return { stdout: stdout.join(""), stderr: stderr.join("") };
}

async function readTreeText(path: string): Promise<string> {
  const entries = await fs.readdir(path, { withFileTypes: true });
  const values: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) values.push(await readTreeText(child));
    else if (entry.isFile()) values.push((await fs.readFile(child)).toString("utf8"));
  }
  return values.join("\n");
}

function protocolProjection(
  definition: (typeof commandRegistry)[number] | undefined,
): Record<string, unknown> | undefined {
  if (!definition) return undefined;
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

function commanderProjection(command: ReturnType<typeof buildProgram>) {
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

function findLeaf(program: ReturnType<typeof buildProgram>, path: string) {
  let current = program;
  for (const segment of path.split(".")) {
    const child = current.commands.find((candidate) => candidate.name() === segment);
    if (!child) throw new Error(`missing Commander path ${path}`);
    current = child;
  }
  return current;
}
