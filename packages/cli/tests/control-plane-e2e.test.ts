import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealEnv } from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../web/src/app.js";
import { deterministicMutationAuthority } from "../../web/tests/helpers/mutation-authority.js";
import { HEADLESS_MUTATION_AUTHORITY_ENV } from "../src/mutation-authority.js";
import { buildProgram } from "../src/program.js";

interface CapturedInvocation {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
}

interface ProtocolEnvelope<T = Record<string, unknown>> {
  readonly command: string;
  readonly status: "success" | "error";
  readonly data: T;
  readonly error?: { readonly code: string };
}

describe("complete CLI control-plane journey", () => {
  let root: string;
  let home: string;
  let storeRoot: string;
  let importProject: string;
  let targetProject: string;
  let previousCellarerHome: string | undefined;
  let previousHome: string | undefined;
  let previousAuthority: string | undefined;
  let previousExitCode: number | undefined;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-control-plane-e2e-")));
    home = join(root, "home");
    storeRoot = join(root, "store");
    importProject = join(root, "import-project");
    targetProject = join(root, "target-project");
    await Promise.all([
      fs.mkdir(home, { recursive: true }),
      fs.mkdir(importProject, { recursive: true }),
      fs.mkdir(targetProject, { recursive: true }),
    ]);
    previousCellarerHome = process.env.CELLARER_HOME;
    previousHome = process.env.HOME;
    previousAuthority = process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    previousExitCode = process.exitCode;
    process.env.CELLARER_HOME = storeRoot;
    process.env.HOME = home;
    process.env[HEADLESS_MUTATION_AUTHORITY_ENV] =
      `v1:1:${Buffer.alloc(32, 0x35).toString("base64url")}`;
    process.exitCode = undefined;
  });

  afterEach(async () => {
    restoreEnv("CELLARER_HOME", previousCellarerHome);
    restoreEnv("HOME", previousHome);
    restoreEnv(HEADLESS_MUTATION_AUTHORITY_ENV, previousAuthority);
    process.exitCode = previousExitCode;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("manages three agents end to end through human, JSON, JSONL, and structured input", async () => {
    const initialized = await invoke(["init", "--agent", "codex,claude-code"]);
    expect(initialized).toMatchObject({ stderr: "", exitCode: undefined });
    expect(initialized.stdout).toContain("库房已初始化:");
    expect(initialized.stdout).toContain("codex:");
    expect(initialized.stdout).toContain("claude-code:");

    const customAdapter = JSON.stringify({
      displayName: "Journey Agent",
      detect: { project: [".journey"] },
      rules: { project: "{dir}/.journey/RULES.md", format: "markdown" },
      capabilities: { rules: ["project"] },
    });
    expect(
      await invoke(["agent", "add", "journey-agent", "--adapter", customAdapter]),
    ).toMatchObject({ stderr: "", exitCode: undefined });
    expect(
      await invoke([
        "agent",
        "configure",
        "codex",
        "--adapter",
        JSON.stringify({ displayName: "Codex Journey" }),
      ]),
    ).toMatchObject({ stderr: "", exitCode: undefined });
    expect(
      await invoke(["config", "update", "--settings", JSON.stringify({ method: "copy" })]),
    ).toMatchObject({ stderr: "", exitCode: undefined });

    const nativeRule = join(importProject, "CLAUDE.md");
    await fs.writeFile(nativeRule, "# Shared team rules\n", "utf8");
    const scanRequestPath = join(root, "scan-request.json");
    await fs.writeFile(
      scanRequestPath,
      JSON.stringify({
        protocolVersion: "1.0",
        command: "scan",
        requestId: "journey:scan:1",
        input: {
          agent: "claude-code",
          dir: importProject,
          capabilities: ["rules"],
          intoCollection: "default",
          select: [{ kind: "rules", name: "claude-code", source: nativeRule }],
        },
      }),
      "utf8",
    );
    const scanned = protocolTerminal(
      await invoke(["--output", "json", "--input", scanRequestPath, "scan"]),
    );
    expect(scanned).toMatchObject({
      command: "scan",
      status: "success",
      data: {
        imported: [
          expect.objectContaining({
            kind: "rules",
            name: "claude-code",
            source: nativeRule,
          }),
        ],
      },
    });

    const resource = await invoke(["resource", "show", "rules/claude-code"]);
    expect(resource).toMatchObject({ stderr: "", exitCode: undefined });
    expect(resource.stdout).toContain("rules/claude-code");

    const collectionRequest = {
      protocolVersion: "1.0",
      command: "collection.create",
      requestId: "journey:collection:1",
      input: {
        collectionName: "journey",
        description: "Journey resources",
        resourceIds: ["rules/claude-code"],
      },
    };
    const createdCollection = protocolTerminal(
      await invoke(["--output", "json", "--input", "-", "collection", "create"], {
        stdinIsTTY: false,
        readInput: async () => JSON.stringify(collectionRequest),
      }),
    );
    expect(createdCollection).toMatchObject({
      command: "collection.create",
      status: "success",
      data: { receipt: { outcome: "committed" } },
    });
    expect(await invoke(["collection", "show", "journey"])).toMatchObject({
      stderr: "",
      exitCode: undefined,
      stdout: expect.stringContaining("rules/claude-code"),
    });

    const applyRequest = {
      protocolVersion: "1.0",
      command: "apply",
      requestId: "journey:apply:1",
      input: {
        agents: ["codex", "claude-code", "journey-agent"],
        dir: targetProject,
        collection: "journey",
        capabilities: ["rules"],
        copy: true,
      },
    };
    const applied = await invoke(["--output", "jsonl", "--input", "-", "apply"], {
      stdinIsTTY: false,
      readInput: async () => JSON.stringify(applyRequest),
    });
    const applyRecords = protocolRecords(applied);
    expect(applyRecords.filter((record) => "event" in record)).toHaveLength(2);
    expect(applyRecords.at(-1)).toMatchObject({
      command: "apply",
      status: "success",
      data: { entries: expect.arrayContaining([expect.objectContaining({ agent: "codex" })]) },
    });
    await expect(fs.readFile(join(targetProject, "AGENTS.md"), "utf8")).resolves.toContain(
      "Shared team rules",
    );
    await expect(fs.readFile(join(targetProject, "CLAUDE.md"), "utf8")).resolves.toContain(
      "Shared team rules",
    );
    await expect(
      fs.readFile(join(targetProject, ".journey", "RULES.md"), "utf8"),
    ).resolves.toContain("Shared team rules");

    const verifyRequestPath = join(root, "verify-request.json");
    await fs.writeFile(
      verifyRequestPath,
      JSON.stringify({
        protocolVersion: "1.0",
        command: "verify",
        input: {
          scope: "project",
          dir: targetProject,
          agents: ["codex", "claude-code", "journey-agent"],
          collections: ["journey"],
          capabilities: ["rules"],
          method: "copy",
        },
      }),
      "utf8",
    );
    expect(
      protocolTerminal(await invoke(["--output", "json", "--input", verifyRequestPath, "verify"])),
    ).toMatchObject({ status: "success", data: { healthy: true } });
    expect(
      protocolTerminal(
        await invoke([
          "--output",
          "json",
          "diff",
          "--scope",
          "project",
          "--dir",
          targetProject,
          "--agent",
          "codex,claude-code,journey-agent",
          "--collection",
          "journey",
          "--rules",
          "--method",
          "copy",
        ]),
      ),
    ).toMatchObject({ status: "success", data: { status: "converged" } });

    const operations = protocolTerminal(await invoke(["--output", "json", "operation", "list"]));
    const operationRows = (
      operations.data as { operations: Array<{ operationId: string; operation: string }> }
    ).operations;
    const applyOperationId = operationRows.find((row) => row.operation === "apply")?.operationId;
    expect(applyOperationId).toBeDefined();
    expect(
      protocolTerminal(
        await invoke(["--output", "json", "operation", "show", applyOperationId as string]),
      ),
    ).toMatchObject({
      status: "success",
      data: { operation: { operationId: applyOperationId, recoveryStatus: "clean" } },
    });

    const reverted = await invoke(["--output", "jsonl", "--input", "-", "revert"], {
      stdinIsTTY: false,
      readInput: async () =>
        JSON.stringify({
          protocolVersion: "1.0",
          command: "revert",
          input: {
            agents: ["codex", "claude-code", "journey-agent"],
            dir: targetProject,
          },
        }),
    });
    expect(protocolRecords(reverted).at(-1)).toMatchObject({
      command: "revert",
      status: "success",
    });
    await expect(fs.stat(join(targetProject, ".journey", "RULES.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    for (const args of [
      ["agent", "disable", "journey-agent"],
      ["agent", "remove", "journey-agent"],
      ["collection", "defaults", "set", "--collection", "default"],
      ["collection", "delete", "journey"],
    ]) {
      expect(await invoke(args)).toMatchObject({ stderr: "", exitCode: undefined });
    }
    expect(protocolTerminal(await invoke(["--output", "json", "agent", "list"]))).toMatchObject({
      status: "success",
      data: {
        agents: expect.not.arrayContaining([expect.objectContaining({ id: "journey-agent" })]),
      },
    });
  }, 30_000);

  it("keeps overlapping CLI and Web reads and planned agent mutation semantically equivalent", async () => {
    expect(
      protocolTerminal(await invoke(["--output", "json", "init", "--agent", "codex"])),
    ).toMatchObject({
      status: "success",
    });
    await fs.writeFile(join(storeRoot, "store", "rules", "style.md"), "# Style\n", "utf8");
    const env = createRealEnv();
    env.mutationAuthority = deterministicMutationAuthority();
    const app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });

    const cliResources = protocolTerminal(
      await invoke([
        "--output",
        "json",
        "resource",
        "list",
        "--kind",
        "rules",
        "--destination",
        "project",
        "--dir",
        targetProject,
        "--agent",
        "codex",
        "--no-include-discovered",
      ]),
    ).data;
    const webResources = await apiJson(
      app.request(
        `/api/v1/resources/rules?destination=project&dir=${encodeURIComponent(targetProject)}&agents=codex&includeDiscovered=false`,
      ),
    );
    expect(withoutVolatile(webResources)).toEqual(withoutVolatile(cliResources));

    const cliAgents = protocolTerminal(
      await invoke([
        "--output",
        "json",
        "agent",
        "list",
        "--scope",
        "project",
        "--dir",
        targetProject,
        "--agent",
        "codex,claude-code",
      ]),
    ).data;
    const webAgents = await apiJson(
      app.request(
        `/api/v1/agents?scope=project&dir=${encodeURIComponent(targetProject)}&agents=codex,claude-code`,
      ),
    );
    expect(withoutVolatile(webAgents)).toEqual(withoutVolatile(cliAgents));

    const cliDiscovery = protocolTerminal(
      await invoke([
        "--output",
        "json",
        "discovery",
        "summary",
        "--destination",
        "project",
        "--dir",
        targetProject,
        "--agent",
        "codex",
      ]),
    ).data;
    const webDiscovery = await apiJson(
      app.request(
        `/api/v1/discovery?destination=project&dir=${encodeURIComponent(targetProject)}&agents=codex`,
      ),
    );
    expect(withoutVolatile(webDiscovery)).toEqual(withoutVolatile(cliDiscovery));

    const cliVerify = protocolTerminal(
      await invoke([
        "--output",
        "json",
        "verify",
        "--scope",
        "project",
        "--dir",
        targetProject,
        "--agent",
        "codex",
        "--collection",
        "default",
        "--rules",
      ]),
    ).data;
    const webVerify = await apiJson(
      app.request("/api/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "project",
          dir: targetProject,
          agents: ["codex"],
          collections: ["default"],
          capabilities: ["rules"],
        }),
      }),
    );
    expect(withoutVolatile(webVerify)).toEqual(withoutVolatile(cliVerify));

    const cliDisable = protocolTerminal(
      await invoke(["--output", "json", "agent", "disable", "codex", "--dry-run"]),
    ).data as { changedFields: string[]; plan: { operation: string; baseRevision: number } };
    const webDisable = (await apiJson(
      app.request("/api/v1/agents/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set-enabled", agentId: "codex", enabled: false }),
      }),
    )) as typeof cliDisable;
    expect(webDisable.changedFields).toEqual(cliDisable.changedFields);
    expect(webDisable.plan).toMatchObject({
      operation: cliDisable.plan.operation,
      baseRevision: cliDisable.plan.baseRevision,
    });
  });

  it("applies the exact structured authority-sealed plan and rejects ambiguity, tampering, drift, and staleness", async () => {
    expect(
      protocolTerminal(await invoke(["--output", "json", "init", "--agent", "codex"])),
    ).toMatchObject({ status: "success" });
    await fs.writeFile(join(storeRoot, "store", "rules", "sealed.md"), "# Sealed\n", "utf8");

    const planned = protocolTerminal(
      await invoke([
        "--output",
        "json",
        "plan",
        "--agent",
        "codex",
        "--scope",
        "project",
        "--dir",
        targetProject,
        "--rules",
      ]),
    );
    const plan = (planned.data as { plan: Record<string, unknown> }).plan;
    const request = (candidate: unknown, extra: Record<string, unknown> = {}) => ({
      protocolVersion: "1.0",
      command: "apply",
      input: { plan: candidate, ...extra },
    });
    const structuredApply = (candidate: unknown, extra: Record<string, unknown> = {}) =>
      invoke(["--output", "jsonl", "--input", "-", "apply"], {
        stdinIsTTY: false,
        readInput: async () => JSON.stringify(request(candidate, extra)),
      });

    expect(
      protocolRecords(await structuredApply(plan, { agents: ["codex"] })).at(-1),
    ).toMatchObject({
      status: "error",
      error: { code: "INPUT_AMBIGUITY" },
    });
    const authorization = plan.authorization as Record<string, unknown>;
    await expect(
      structuredApply({ ...plan, authorization: { ...authorization, extra: true } }),
    ).rejects.toMatchObject({
      cliError: { code: "DOMAIN_VALIDATION_FAILED", details: { coreCode: "INVALID_PLAN" } },
    });
    const seal = String(authorization.seal);
    expect(
      protocolRecords(
        await structuredApply({
          ...plan,
          authorization: {
            ...authorization,
            seal: `${seal.slice(0, -1)}${seal.endsWith("0") ? "1" : "0"}`,
          },
        }),
      ).at(-1),
    ).toMatchObject({ status: "error", error: { code: "DOMAIN_VALIDATION_FAILED" } });

    const target = join(targetProject, "AGENTS.md");
    await fs.writeFile(target, "# Drifted after planning\n", "utf8");
    expect(protocolRecords(await structuredApply(plan)).at(-1)).toMatchObject({
      status: "error",
      error: { code: "TARGET_CONFLICT", details: { coreCode: "TARGET_PRECONDITION_CONFLICT" } },
    });
    await fs.rm(target);

    const applied = protocolRecords(await structuredApply(plan));
    expect(applied.at(-1)).toMatchObject({
      status: "success",
      data: {
        entries: expect.arrayContaining([expect.objectContaining({ agent: "codex" })]),
        mutation: { planId: plan.planId, result: { receipt: { outcome: "committed" } } },
      },
    });
    await expect(fs.readFile(target, "utf8")).resolves.toContain("Sealed");

    const stalePlan = (
      protocolTerminal(
        await invoke([
          "--output",
          "json",
          "plan",
          "--agent",
          "codex",
          "--scope",
          "project",
          "--dir",
          targetProject,
          "--rules",
        ]),
      ).data as { plan: Record<string, unknown> }
    ).plan;
    expect(
      protocolTerminal(
        await invoke(["--output", "json", "config", "update", "--settings", '{"method":"copy"}']),
      ),
    ).toMatchObject({ status: "success" });
    expect(protocolRecords(await structuredApply(stalePlan)).at(-1)).toMatchObject({
      status: "error",
      error: { code: "DOMAIN_VALIDATION_FAILED" },
    });

    const settingsPlan = (
      protocolTerminal(await invoke(["--output", "json", "agent", "disable", "codex", "--dry-run"]))
        .data as { plan: Record<string, unknown> }
    ).plan;
    const settingsActions = settingsPlan.actions as Record<string, unknown>[];
    const settingsRecords = protocolRecords(await structuredApply(settingsPlan));
    expect(settingsRecords).toHaveLength(3);
    expect(settingsRecords.at(-1)).toMatchObject({
      status: "success",
      data: {
        changedFields: ["adapterOverrides.codex.enabled"],
        receipt: { outcome: "committed" },
      },
    });
    await expect(
      structuredApply({
        ...settingsPlan,
        actions: [
          {
            ...settingsActions[0],
            payload: { ...(settingsActions[0]?.payload as object), extra: true },
          },
        ],
      }),
    ).rejects.toMatchObject({
      cliError: { code: "DOMAIN_VALIDATION_FAILED", details: { coreCode: "INVALID_PLAN" } },
    });
    await expect(
      structuredApply({
        ...settingsPlan,
        actions: [{ ...settingsActions[0], kind: "unknown-action" }],
      }),
    ).rejects.toMatchObject({
      cliError: { code: "DOMAIN_VALIDATION_FAILED", details: { coreCode: "INVALID_PLAN" } },
    });
    await expect(
      structuredApply({ ...settingsPlan, operation: "unknown-operation" }),
    ).rejects.toMatchObject({
      cliError: { code: "DOMAIN_VALIDATION_FAILED", details: { coreCode: "INVALID_PLAN" } },
    });
  }, 30_000);

  async function invoke(
    args: readonly string[],
    inputIo?: {
      readonly stdinIsTTY: boolean;
      readonly readInput: (source: string) => Promise<string>;
    },
  ): Promise<CapturedInvocation> {
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
    globalThis.console.warn = (...data: unknown[]) =>
      stderr.push(`${data.map(String).join(" ")}\n`);
    globalThis.console.error = (...data: unknown[]) =>
      stderr.push(`${data.map(String).join(" ")}\n`);
    try {
      await buildProgram(inputIo).parseAsync(["node", "cellarer", ...args], { from: "node" });
    } finally {
      process.stdout.write = oldStdoutWrite;
      process.stderr.write = oldStderrWrite;
      globalThis.console.log = oldConsoleLog;
      globalThis.console.warn = oldConsoleWarn;
      globalThis.console.error = oldConsoleError;
    }
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: process.exitCode };
  }
});

function protocolTerminal(captured: CapturedInvocation): ProtocolEnvelope {
  expect(captured.stderr).toBe("");
  const records = protocolRecords(captured);
  expect(records).toHaveLength(1);
  return records[0] as unknown as ProtocolEnvelope;
}

function protocolRecords(captured: CapturedInvocation): Record<string, unknown>[] {
  expect(captured.stderr).toBe("");
  return captured.stdout
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function apiJson(responsePromise: Promise<Response>): Promise<unknown> {
  const response = await responsePromise;
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { status?: string; data?: unknown };
  expect(body.status).toBe("success");
  return body.data;
}

function withoutVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutVolatile);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["generatedAt", "verifiedAt", "checkedAt"].includes(key))
      .map(([key, child]) => [key, withoutVolatile(child)]),
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
