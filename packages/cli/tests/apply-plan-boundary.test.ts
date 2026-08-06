import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planApplyMutation } from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveVault } from "../../core/src/secrets/vault.js";
import { resolveContext } from "../src/context.js";
import { HEADLESS_MUTATION_AUTHORITY_ENV } from "../src/mutation-authority.js";
import { handleCliRunnerBoundaryError } from "../src/protocol/execution.js";

const protectedInput = vi.hoisted(() => ({
  reads: vi.fn(async () => "test-passphrase"),
}));

vi.mock("../src/commands/secret.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/commands/secret.js")>();
  return { ...actual, readProtectedPassphraseInput: protectedInput.reads };
});

import { buildProgram } from "../src/program.js";

interface CapturedInvocation {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
}

describe("apply external plan boundary", () => {
  let root: string;
  let storeRoot: string;
  let previousCellarerHome: string | undefined;
  let previousAuthority: string | undefined;
  let previousExitCode: number | undefined;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-apply-plan-boundary-")));
    storeRoot = join(root, "store");
    previousCellarerHome = process.env.CELLARER_HOME;
    previousAuthority = process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    previousExitCode = process.exitCode;
    process.env.CELLARER_HOME = storeRoot;
    process.env[HEADLESS_MUTATION_AUTHORITY_ENV] =
      `v1:1:${Buffer.alloc(32, 0x47).toString("base64url")}`;
    process.exitCode = undefined;
    protectedInput.reads.mockClear();

    expect(
      protocolTerminal(await invoke(["--output", "json", "init", "--agent", "codex"])),
    ).toMatchObject({
      status: "success",
    });
    protectedInput.reads.mockClear();
  });

  afterEach(async () => {
    restoreEnv("CELLARER_HOME", previousCellarerHome);
    restoreEnv(HEADLESS_MUTATION_AUTHORITY_ENV, previousAuthority);
    process.exitCode = previousExitCode;
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    "json",
    "jsonl",
  ] as const)("rejects a malformed argv plan before protected input in %s mode", async (output) => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const captured = await invoke([
      "--output",
      output,
      "apply",
      "--plan",
      JSON.stringify({ operation: "settings", accessToken: canary }),
      "--secret-mode",
      "vault",
      "--vault-passphrase-fd",
      "9",
      "--snapshot-passphrase-fd",
      "10",
    ]);

    expect(protectedInput.reads).not.toHaveBeenCalled();
    expect(captured.exitCode).toBe(3);
    expect(captured.stdout + captured.stderr).not.toContain(canary);
    expect(protocolRecords(captured).at(-1)).toMatchObject({
      status: "error",
      error: {
        code: "DOMAIN_VALIDATION_FAILED",
        details: { coreCode: "INVALID_PLAN" },
      },
    });
  });

  it("renders a redacted typed human error before protected input", async () => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const captured = await invoke([
      "apply",
      "--plan",
      JSON.stringify({ operation: "settings", accessToken: canary }),
      "--secret-mode",
      "vault",
      "--vault-passphrase-fd",
      "9",
    ]);

    expect(protectedInput.reads).not.toHaveBeenCalled();
    expect(captured).toMatchObject({ stdout: "", exitCode: 3 });
    expect(captured.stderr).toContain("The sealed plan is invalid");
    expect(captured.stdout + captured.stderr).not.toContain(canary);
    expect(captured.stderr).not.toContain("undefined");
  });

  it("gives structured and argv malformed plans the same stable error", async () => {
    const malformed = { operation: "settings" };
    const argv = await invoke(["--output", "json", "apply", "--plan", JSON.stringify(malformed)]);
    const structured = await invoke(
      ["--output", "json", "--input", "-", "apply"],
      JSON.stringify({
        protocolVersion: "1.0",
        command: "apply",
        input: { plan: malformed },
      }),
    );

    expect(protocolTerminal(argv).error).toEqual(protocolTerminal(structured).error);
    expect(protectedInput.reads).not.toHaveBeenCalled();
  });

  it("rejects irrelevant protected-input flags for a settings plan without reading or mutating", async () => {
    const settingsPlan = planFrom(
      protocolTerminal(
        await invoke(["--output", "json", "agent", "disable", "codex", "--dry-run"]),
      ),
    );
    const before = await snapshotTree(storeRoot);
    const argv = await invoke([
      "--output",
      "json",
      "apply",
      "--plan",
      JSON.stringify(settingsPlan),
      "--secret-mode",
      "vault",
      "--vault-passphrase-fd",
      "9",
      "--keychain-service",
      "unused-service",
      "--snapshot-passphrase-fd",
      "10",
    ]);
    const structured = await invoke(
      ["--output", "json", "--input", "-", "apply"],
      JSON.stringify({
        protocolVersion: "1.0",
        command: "apply",
        input: {
          plan: settingsPlan,
          secretMode: "vault",
          vaultPassphraseFd: 9,
          keychainService: "unused-service",
          snapshotPassphraseFd: 10,
        },
      }),
    );

    expect(protectedInput.reads).not.toHaveBeenCalled();
    expect(protocolTerminal(argv)).toMatchObject({
      status: "error",
      error: { code: "INPUT_AMBIGUITY" },
    });
    expect(protocolTerminal(structured).error).toEqual(protocolTerminal(argv).error);
    expect(await snapshotTree(storeRoot)).toEqual(before);

    const applied = protocolTerminal(
      await invoke(["--output", "json", "apply", "--plan", JSON.stringify(settingsPlan)]),
    );
    expect(applied).toMatchObject({
      status: "success",
      data: { receipt: { outcome: "committed" } },
    });
  });

  it("rejects a forged settings plan before protected input and preserves the store", async () => {
    const settingsPlan = planFrom(
      protocolTerminal(
        await invoke(["--output", "json", "agent", "disable", "codex", "--dry-run"]),
      ),
    );
    const authorization = settingsPlan.authorization as Record<string, unknown>;
    const seal = String(authorization.seal);
    const forged = {
      ...settingsPlan,
      authorization: {
        ...authorization,
        seal: `${seal.slice(0, -1)}${seal.endsWith("0") ? "1" : "0"}`,
      },
    };
    const before = await snapshotTree(storeRoot);

    const captured = await invoke([
      "--output",
      "json",
      "apply",
      "--plan",
      JSON.stringify(forged),
      "--secret-mode",
      "vault",
      "--vault-passphrase-fd",
      "9",
    ]);

    expect(protectedInput.reads).not.toHaveBeenCalled();
    expect(protocolTerminal(captured)).toMatchObject({
      status: "error",
      error: { code: "INPUT_AMBIGUITY" },
    });
    expect(await snapshotTree(storeRoot)).toEqual(before);

    const authorityRejected = await invoke([
      "--output",
      "json",
      "apply",
      "--plan",
      JSON.stringify(forged),
    ]);
    expect(protectedInput.reads).not.toHaveBeenCalled();
    expect(protocolTerminal(authorityRejected)).toMatchObject({
      status: "error",
      error: {
        code: "DOMAIN_VALIDATION_FAILED",
        details: { coreCode: "INVALID_PLAN" },
      },
    });
    expect(await snapshotTree(storeRoot)).toEqual(before);

    const human = await invoke(["apply", "--plan", JSON.stringify(forged)]);
    expect(protectedInput.reads).not.toHaveBeenCalled();
    expect(human).toMatchObject({ stdout: "", exitCode: 3 });
    expect(human.stderr).toContain("mutation plan is invalid");
    expect(human.stderr).not.toContain(String(authorization.seal));
    expect(await snapshotTree(storeRoot)).toEqual(before);
  });

  it("preflights distribution authority and reads protected input only when the plan needs it", async () => {
    const project = join(root, "project");
    await fs.mkdir(join(storeRoot, "store", "rules"), { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(join(storeRoot, "store", "rules", "boundary.md"), "# Boundary\n", "utf8");
    const distributionPlan = planFrom(
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
          project,
          "--rules",
        ]),
      ),
    );
    const authorization = distributionPlan.authorization as Record<string, unknown>;
    const seal = String(authorization.seal);
    const forged = {
      ...distributionPlan,
      authorization: {
        ...authorization,
        seal: `${seal.slice(0, -1)}${seal.endsWith("0") ? "1" : "0"}`,
      },
    };
    const beforeStore = await snapshotTree(storeRoot);
    const beforeTarget = await snapshotTree(project);

    const rejected = await invoke([
      "--output",
      "json",
      "apply",
      "--plan",
      JSON.stringify(forged),
      "--secret-mode",
      "vault",
      "--vault-passphrase-fd",
      "9",
      "--snapshot-passphrase-fd",
      "10",
    ]);
    expect(protectedInput.reads).not.toHaveBeenCalled();
    expect(protocolTerminal(rejected)).toMatchObject({
      status: "error",
      error: {
        code: "DOMAIN_VALIDATION_FAILED",
        details: { coreCode: "INVALID_PLAN" },
      },
    });
    expect(await snapshotTree(storeRoot)).toEqual(beforeStore);
    expect(await snapshotTree(project)).toEqual(beforeTarget);

    const applied = await invoke([
      "--output",
      "json",
      "apply",
      "--plan",
      JSON.stringify(distributionPlan),
      "--secret-mode",
      "vault",
      "--vault-passphrase-fd",
      "9",
      "--snapshot-passphrase-fd",
      "10",
    ]);
    expect(protectedInput.reads).not.toHaveBeenCalled();
    expect(protocolTerminal(applied)).toMatchObject({ status: "success" });
    await expect(fs.readFile(join(project, "AGENTS.md"), "utf8")).resolves.toContain("Boundary");
  });

  it("reads one vault passphrase after preflight when a serialized plan requires a cellarer reference", async () => {
    const project = join(root, "vault-project");
    await fs.mkdir(join(storeRoot, "store", "mcp"), { recursive: true });
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(
      join(storeRoot, "store", "mcp", "context.json"),
      JSON.stringify({ command: "npx", env: { TOKEN: "$" + "{CELLARER_SECRET:CTX_TOKEN}" } }),
      "utf8",
    );
    const adapter = {
      displayName: "Reference Native",
      detect: { project: [".reference-native"] },
      mcp: {
        project: "{dir}/.reference-native/mcp.json",
        format: "json",
        supportedSecretReferences: ["cellarer"],
      },
      capabilities: { mcp: ["project"] },
    };
    const configPath = join(storeRoot, "config.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      customAdapters: Record<string, unknown>;
    };
    config.customAdapters["reference-native"] = adapter;
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const ctx = await resolveContext({}, "required");
    await saveVault(ctx.env, storeRoot, { CTX_TOKEN: "vault-only-secret" }, "test-passphrase");
    const prepared = await planApplyMutation(ctx.env, {
      storeRoot,
      scope: "project",
      dir: project,
      agents: ["reference-native"],
      capabilities: ["mcp"],
      secretMode: "vault",
      vaultPassphrase: "test-passphrase",
      dryRun: true,
    });
    protectedInput.reads.mockClear();

    const applied = await invoke([
      "--output",
      "json",
      "apply",
      "--plan",
      JSON.stringify(prepared.mutationPlan),
      "--secret-mode",
      "vault",
      "--vault-passphrase-fd",
      "9",
      "--snapshot-passphrase-fd",
      "10",
    ]);

    expect(protectedInput.reads).toHaveBeenCalledTimes(1);
    expect(protectedInput.reads).toHaveBeenCalledWith("9", undefined, expect.any(Object));
    expect(protocolTerminal(applied)).toMatchObject({ status: "success" });
    const target = await fs.readFile(join(project, ".reference-native", "mcp.json"), "utf8");
    expect(target).toContain("$" + "{CELLARER_SECRET:CTX_TOKEN}");
    expect(target).not.toContain("vault-only-secret");
  });

  it("does not read a vault passphrase for an environment-only reference", async () => {
    const project = join(root, "environment-project");
    const variable = "CELLARER_BOUNDARY_ENV_TOKEN";
    const reference = `\${${variable}}`;
    const previousValue = process.env[variable];
    process.env[variable] = "environment-only-secret";
    try {
      await fs.mkdir(join(storeRoot, "store", "mcp"), { recursive: true });
      await fs.mkdir(project, { recursive: true });
      await fs.writeFile(
        join(storeRoot, "store", "mcp", "environment.json"),
        JSON.stringify({ command: "npx", env: { TOKEN: reference } }),
        "utf8",
      );
      const configPath = join(storeRoot, "config.json");
      const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
        customAdapters: Record<string, unknown>;
      };
      config.customAdapters["environment-native"] = {
        displayName: "Environment Native",
        detect: { project: [".environment-native"] },
        mcp: {
          project: "{dir}/.environment-native/mcp.json",
          format: "json",
          supportedSecretReferences: ["environment"],
        },
        capabilities: { mcp: ["project"] },
      };
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      const ctx = await resolveContext({}, "required");
      const prepared = await planApplyMutation(ctx.env, {
        storeRoot,
        scope: "project",
        dir: project,
        agents: ["environment-native"],
        capabilities: ["mcp"],
        secretMode: "vault",
        dryRun: true,
      });
      protectedInput.reads.mockClear();

      const applied = await invoke([
        "--output",
        "json",
        "apply",
        "--plan",
        JSON.stringify(prepared.mutationPlan),
        "--secret-mode",
        "vault",
        "--vault-passphrase-fd",
        "9",
      ]);

      expect(protectedInput.reads).not.toHaveBeenCalled();
      expect(protocolTerminal(applied)).toMatchObject({ status: "success" });
      const target = await fs.readFile(join(project, ".environment-native", "mcp.json"), "utf8");
      expect(target).toContain(reference);
      expect(target).not.toContain("environment-only-secret");
    } finally {
      restoreEnv(variable, previousValue);
    }
  });
});

async function invoke(
  args: readonly string[],
  structuredInput?: string,
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
  globalThis.console.warn = (...data: unknown[]) => stderr.push(`${data.map(String).join(" ")}\n`);
  globalThis.console.error = (...data: unknown[]) => stderr.push(`${data.map(String).join(" ")}\n`);
  try {
    await buildProgram(
      structuredInput === undefined
        ? undefined
        : { stdinIsTTY: false, readInput: async () => structuredInput },
    ).parseAsync(["node", "cellarer", ...args], { from: "node" });
  } catch (error) {
    const outputArgument = args.indexOf("--output");
    const output =
      outputArgument >= 0 &&
      (args[outputArgument + 1] === "json" || args[outputArgument + 1] === "jsonl")
        ? args[outputArgument + 1]
        : "text";
    handleCliRunnerBoundaryError(error, {
      command: "apply",
      output,
      nonInteractive: output !== "text" || structuredInput !== undefined,
    });
  } finally {
    process.stdout.write = oldStdoutWrite;
    process.stderr.write = oldStderrWrite;
    globalThis.console.log = oldConsoleLog;
    globalThis.console.warn = oldConsoleWarn;
    globalThis.console.error = oldConsoleError;
  }
  return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: process.exitCode };
}

function protocolTerminal(captured: CapturedInvocation): Record<string, unknown> & {
  readonly error?: unknown;
} {
  const records = protocolRecords(captured);
  expect(records).toHaveLength(1);
  return records[0] as Record<string, unknown>;
}

function protocolRecords(captured: CapturedInvocation): Record<string, unknown>[] {
  expect(captured.stderr).toBe("");
  return captured.stdout
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function planFrom(envelope: Record<string, unknown>): Record<string, unknown> {
  const data = envelope.data as { readonly plan?: unknown } | undefined;
  if (!data || typeof data.plan !== "object" || data.plan === null || Array.isArray(data.plan)) {
    throw new Error("expected a serialized mutation plan");
  }
  return data.plan as Record<string, unknown>;
}

async function snapshotTree(path: string): Promise<readonly string[]> {
  const entries = await fs.readdir(path, { withFileTypes: true });
  const snapshot: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      snapshot.push(`dir:${entry.name}`);
      snapshot.push(...(await snapshotTree(child)).map((value) => `${entry.name}/${value}`));
    } else if (entry.isSymbolicLink()) {
      snapshot.push(`link:${entry.name}:${await fs.readlink(child)}`);
    } else {
      snapshot.push(`file:${entry.name}:${(await fs.readFile(child)).toString("base64")}`);
    }
  }
  return snapshot;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
