import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_PROTOCOL_VERSION } from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAuthorizedMutationPlan,
  createDurableMutationPlan,
} from "../../core/src/protocol/canonical.js";
import { publishOperationJournal } from "../../core/src/protocol/journal.js";
import { resolveContext } from "../src/context.js";
import { HEADLESS_MUTATION_AUTHORITY_ENV } from "../src/mutation-authority.js";
import { buildProgram } from "../src/program.js";
import { commandRegistry } from "../src/protocol/command-registry.js";

const MUTATION_COMMANDS = [
  "agent.enable",
  "agent.disable",
  "agent.configure",
  "agent.reset",
  "agent.add",
  "agent.update",
  "agent.remove",
  "collection.create",
  "collection.update",
  "collection.delete",
  "collection.members.set",
  "collection.defaults.set",
  "config.update",
  "config.reset",
  "operation.recover",
] as const;

describe("control-plane agent and config mutation commands", () => {
  let root: string;
  let storeRoot: string;
  let previousHome: string | undefined;
  let previousAuthority: string | undefined;
  let previousExitCode: number | undefined;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-control-plane-write-")));
    storeRoot = join(root, "home");
    previousHome = process.env.CELLARER_HOME;
    previousAuthority = process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    previousExitCode = process.exitCode;
    process.env.CELLARER_HOME = storeRoot;
    process.env[HEADLESS_MUTATION_AUTHORITY_ENV] =
      `v1:1:${Buffer.alloc(32, 0x6d).toString("base64url")}`;
    process.exitCode = undefined;
    expect(await invoke(["init", "--agent", "codex"])).toMatchObject({ status: "success" });
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.CELLARER_HOME;
    else process.env.CELLARER_HOME = previousHome;
    if (previousAuthority === undefined) delete process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    else process.env[HEADLESS_MUTATION_AUTHORITY_ENV] = previousAuthority;
    process.exitCode = previousExitCode;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("registers each executable group-3 leaf", () => {
    expect(commandRegistry.map(({ command }) => command)).toEqual(
      expect.arrayContaining(MUTATION_COMMANDS),
    );
    const program = buildProgram();
    for (const identity of MUTATION_COMMANDS) {
      let current = program;
      for (const part of identity.split(".")) {
        current = current.commands.find((candidate) => candidate.name() === part) as typeof program;
        expect(current, identity).toBeDefined();
      }
    }
  });

  it("dry-runs without writes, then applies built-in override operations with receipts", async () => {
    const configPath = join(storeRoot, "config.json");
    const revisionPath = join(storeRoot, "revision.json");
    const beforeConfig = await fs.readFile(configPath, "utf8");
    const beforeRevision = await fs.readFile(revisionPath, "utf8");

    expect(await invoke(["agent", "disable", "codex", "--dry-run"])).toMatchObject({
      status: "success",
      data: { plan: { operation: "settings" }, changedFields: ["adapterOverrides.codex.enabled"] },
    });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(beforeConfig);
    await expect(fs.readFile(revisionPath, "utf8")).resolves.toBe(beforeRevision);

    const disabled = await invoke(["agent", "disable", "codex"]);
    expect(disabled).toMatchObject({
      status: "success",
      data: { receipt: { outcome: "committed" } },
    });
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
      adapterOverrides: { codex: { enabled: false } },
    });

    await invoke(["agent", "configure", "codex", "--adapter", '{"displayName":"Codex Local"}']);
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
      adapterOverrides: { codex: { enabled: false, displayName: "Codex Local" } },
    });
    await invoke(["agent", "reset", "codex"]);
    expect(
      JSON.parse(await fs.readFile(configPath, "utf8")).adapterOverrides.codex,
    ).toBeUndefined();
  });

  it("applies serialized settings plans for agent, adapter, collection, and config mutations", async () => {
    const exactPlan = (result: Record<string, unknown>) =>
      (result.data as { plan: Record<string, unknown> }).plan;
    const applyPlan = (plan: Record<string, unknown>) =>
      invoke(["apply", "--plan", JSON.stringify(JSON.parse(JSON.stringify(plan)))]);

    const disablePlan = exactPlan(await invoke(["agent", "disable", "codex", "--dry-run"]));
    expect(await applyPlan(disablePlan)).toMatchObject({
      status: "success",
      data: {
        changedFields: ["adapterOverrides.codex.enabled"],
        receipt: { outcome: "committed" },
      },
    });

    const adapter = '{"displayName":"Disposable","rules":{"global":"~/.disposable/RULES.md"}}';
    await invoke(["agent", "add", "disposable", "--adapter", adapter]);
    await invoke(["agent", "disable", "disposable"]);
    const removePlan = exactPlan(await invoke(["agent", "remove", "disposable", "--dry-run"]));
    expect(await applyPlan(removePlan)).toMatchObject({
      status: "success",
      data: { changedFields: expect.arrayContaining(["customAdapters.disposable"]) },
    });

    await fs.writeFile(join(storeRoot, "store", "rules", "roundtrip.md"), "# roundtrip\n");
    const createPlan = exactPlan(
      await invoke([
        "collection",
        "create",
        "roundtrip",
        "--resource",
        "rules/roundtrip",
        "--dry-run",
      ]),
    );
    expect(await applyPlan(createPlan)).toMatchObject({ status: "success" });
    const membersPlan = exactPlan(
      await invoke(["collection", "members", "set", "roundtrip", "--resource", "", "--dry-run"]),
    );
    expect(await applyPlan(membersPlan)).toMatchObject({ status: "success" });
    const defaultsPlan = exactPlan(
      await invoke(["collection", "defaults", "set", "--collection", "roundtrip", "--dry-run"]),
    );
    expect(await applyPlan(defaultsPlan)).toMatchObject({ status: "success" });

    const configPlan = exactPlan(
      await invoke(["config", "update", "--settings", '{"method":"copy"}', "--dry-run"]),
    );
    expect(await applyPlan(configPlan)).toMatchObject({
      status: "success",
      data: { changedFields: ["defaults.method"], receipt: { outcome: "committed" } },
    });
  }, 30_000);

  it("adds and updates typed custom adapters and reports exact removal dependencies", async () => {
    const adapter = '{"displayName":"My Agent","rules":{"global":"~/.my-agent/RULES.md"}}';
    expect(await invoke(["agent", "add", "my-agent", "--adapter", adapter])).toMatchObject({
      status: "success",
      data: { receipt: { outcome: "committed" } },
    });
    const updated = '{"displayName":"My Updated Agent","rules":{"global":"~/.my-agent/RULES.md"}}';
    await invoke(["agent", "update", "my-agent", "--adapter", updated]);

    const ownedTarget = join(root, "owned", "RULES.md");
    await fs.writeFile(
      join(storeRoot, "state.json"),
      `${JSON.stringify(
        {
          version: 2,
          owners: [
            {
              agent: "my-agent",
              scope: "global",
              capability: "rules",
              target: ownedTarget,
              artifactIds: ["rules/style"],
              receipt: {
                method: "write",
                fingerprint: "sha256:owned",
                backup: null,
                generated: true,
                appliedAt: "2026-08-05T00:00:00.000Z",
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    expect(await invoke(["agent", "remove", "my-agent"])).toMatchObject({
      status: "error",
      error: {
        code: "DOMAIN_VALIDATION_FAILED",
        details: { dependencies: { ownedTargets: [ownedTarget] } },
      },
    });
  });

  it("updates/resets typed settings and rejects secret-shaped ordinary fields", async () => {
    expect(
      await invoke(["config", "update", "--settings", '{"method":"copy","secretMode":"env"}']),
    ).toMatchObject({ status: "success", data: { receipt: { outcome: "committed" } } });
    expect(JSON.parse(await fs.readFile(join(storeRoot, "config.json"), "utf8"))).toMatchObject({
      defaults: { method: "copy", secretMode: "env" },
    });

    await invoke(["config", "reset", "--field", "method"]);
    expect(
      JSON.parse(await fs.readFile(join(storeRoot, "config.json"), "utf8")).defaults.method,
    ).toBe("symlink");

    const before = await fs.readFile(join(storeRoot, "config.json"), "utf8");
    expect(
      await invoke(["config", "update", "--settings", '{"apiToken":"hunter2"}']),
    ).toMatchObject({ status: "error", error: { code: "INVALID_INPUT" } });
    await expect(fs.readFile(join(storeRoot, "config.json"), "utf8")).resolves.toBe(before);
  });

  it("rejects empty structured adapter/settings inputs before Core effects", async () => {
    const configPath = join(storeRoot, "config.json");
    const revisionPath = join(storeRoot, "revision.json");
    const beforeConfig = await fs.readFile(configPath, "utf8");
    const beforeRevision = await fs.readFile(revisionPath, "utf8");
    const receiptsPath = join(storeRoot, "operations", "receipts");
    const beforeReceipts = await fs.readdir(receiptsPath).catch(() => []);
    const cases = [
      {
        command: "agent.add",
        args: ["agent", "add"],
        input: { agentId: "empty-agent", adapter: {} },
      },
      {
        command: "config.update",
        args: ["config", "update"],
        input: { settings: {} },
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const requestPath = join(root, `empty-structured-${index}.json`);
      await fs.writeFile(
        requestPath,
        JSON.stringify({
          protocolVersion: CLI_PROTOCOL_VERSION,
          command: testCase.command,
          input: testCase.input,
        }),
      );
      await expect(invoke(["--input", requestPath, ...testCase.args])).rejects.toMatchObject({
        cliError: { code: "INVALID_INPUT" },
      });
    }

    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(beforeConfig);
    await expect(fs.readFile(revisionPath, "utf8")).resolves.toBe(beforeRevision);
    await expect(fs.readdir(receiptsPath)).resolves.toEqual(beforeReceipts);
    await expect(fs.lstat(join(storeRoot, "operations", "active.json"))).rejects.toThrow();
  });

  it.each([
    "agent id",
    "__proto__",
  ])("rejects unsafe human-mode agent id %j before dry-run or apply effects", async (agentId) => {
    const configPath = join(storeRoot, "config.json");
    const revisionPath = join(storeRoot, "revision.json");
    const receiptsPath = join(storeRoot, "operations", "receipts");
    const beforeConfig = await fs.readFile(configPath, "utf8");
    const beforeRevision = await fs.readFile(revisionPath, "utf8");
    const beforeReceipts = await fs.readdir(receiptsPath);
    const adapter = '{"rules":{"global":"~/.unsafe/RULES.md"}}';

    for (const dryRun of [true, false]) {
      const result = await invoke([
        "agent",
        "add",
        agentId,
        "--adapter",
        adapter,
        ...(dryRun ? ["--dry-run"] : []),
      ]);
      expect(result).toMatchObject({
        status: "error",
        error: { code: "DOMAIN_VALIDATION_FAILED", details: { agentId } },
      });
      await expect(fs.readFile(configPath, "utf8")).resolves.toBe(beforeConfig);
      await expect(fs.readFile(revisionPath, "utf8")).resolves.toBe(beforeRevision);
      await expect(fs.readdir(receiptsPath)).resolves.toEqual(beforeReceipts);
      await expect(fs.lstat(join(storeRoot, "operations", "active.json"))).rejects.toThrow();
    }
  });

  it("dry-runs and applies exact collection mutations with receipts", async () => {
    await fs.writeFile(join(storeRoot, "store", "rules", "style.md"), "# style\n", "utf8");
    const configPath = join(storeRoot, "config.json");
    const revisionPath = join(storeRoot, "revision.json");
    const beforeConfig = await fs.readFile(configPath, "utf8");
    const beforeRevision = await fs.readFile(revisionPath, "utf8");

    const dryRun = await invoke([
      "collection",
      "create",
      "work",
      "--description",
      "Work",
      "--resource",
      "rules/style",
      "--dry-run",
    ]);
    expect(dryRun).toMatchObject({ status: "success", data: { plan: {} } });
    expect(dryRun.data).not.toHaveProperty("receipt");
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(beforeConfig);
    await expect(fs.readFile(revisionPath, "utf8")).resolves.toBe(beforeRevision);

    expect(
      await invoke([
        "collection",
        "create",
        "work",
        "--description",
        "Work",
        "--resource",
        "rules/style",
      ]),
    ).toMatchObject({ status: "success", data: { receipt: { outcome: "committed" } } });
    expect(await invoke(["collection", "members", "set", "work", "--resource", ""])).toMatchObject({
      status: "success",
      data: { receipt: { outcome: "committed" } },
    });
    expect(
      await invoke(["collection", "update", "work", "--description", "Updated"]),
    ).toMatchObject({ status: "success", data: { receipt: { outcome: "committed" } } });
    expect(await invoke(["collection", "defaults", "set", "--collection", "work"])).toMatchObject({
      status: "success",
      data: { receipt: { outcome: "committed" } },
    });
    expect(await invoke(["collection", "delete", "work"])).toMatchObject({
      status: "error",
      error: { code: "DOMAIN_VALIDATION_FAILED" },
    });
  });

  it("requires exact non-interactive init targets and returns inventory without writing", async () => {
    const missingTargetStore = join(root, "missing-target-store");
    process.env.CELLARER_HOME = missingTargetStore;

    expect(await invoke(["init"])).toMatchObject({
      status: "error",
      error: {
        code: "INPUT_REQUIRED",
        details: { fields: ["agents"], inventory: { agents: expect.any(Array) } },
      },
    });
    await expect(fs.stat(join(missingTargetStore, "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("previews and invokes evidence-based recovery through a typed protocol result", async () => {
    expect(await invoke(["operation", "recover", "missing-operation", "--dry-run"])).toMatchObject({
      status: "error",
      error: {
        code: "DOMAIN_VALIDATION_FAILED",
        details: { operationId: "missing-operation", reason: "not-found" },
      },
    });

    expect(await invoke(["operation", "recover", "missing-operation"])).toMatchObject({
      status: "error",
      error: { code: "RECOVERY_REQUIRED" },
      data: {
        operation: {
          ok: false,
          conflict: { code: "MANUAL_RECOVERY_REQUIRED" },
        },
      },
    });

    const ctx = await resolveContext({}, "required");
    const plan = createAuthorizedMutationPlan(ctx.env, ctx.storeRoot, {
      schemaVersion: 1,
      planId: "plan-active-recovery",
      operation: "apply",
      baseRevision: 1,
      normalizedInputs: {},
      actions: [],
      targetPreconditions: [],
      expires: { policy: "none" },
    });
    const timestamp = ctx.env.now().toISOString();
    await publishOperationJournal(ctx.env, ctx.storeRoot, {
      schemaVersion: 1,
      operationId: "operation-active",
      plan: createDurableMutationPlan(ctx.env, ctx.storeRoot, plan),
      nextRevision: 2,
      status: "executing",
      startedAt: timestamp,
      updatedAt: timestamp,
      actions: [],
    });

    expect(await invoke(["operation", "recover", "operation-other", "--dry-run"])).toMatchObject({
      status: "error",
      error: {
        code: "DOMAIN_VALIDATION_FAILED",
        details: { operationId: "operation-other", reason: "not-found" },
      },
    });
    expect(await invoke(["operation", "recover", "operation-other"])).toMatchObject({
      status: "error",
      data: {
        operation: {
          conflict: { operationId: "operation-other", targets: [] },
        },
      },
    });
    expect(await invoke(["operation", "recover", "operation-active", "--dry-run"])).toMatchObject({
      status: "success",
      data: {
        diagnosis: {
          status: "manual-recovery-required",
          operationId: "operation-active",
        },
      },
    });
    await expect(
      fs.readFile(join(storeRoot, "operations", "active.json"), "utf8"),
    ).resolves.toContain('"operationId": "operation-active"');
  });
});

async function invoke(args: readonly string[]): Promise<Record<string, unknown>> {
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
    await buildProgram().parseAsync(["node", "cellarer", "--output", "json", ...args], {
      from: "node",
    });
  } finally {
    process.stdout.write = oldStdoutWrite;
    process.stderr.write = oldStderrWrite;
  }
  expect(stderr).toEqual([]);
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0] as string) as Record<string, unknown>;
}
