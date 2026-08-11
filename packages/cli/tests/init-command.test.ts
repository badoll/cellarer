import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_PROTOCOL_VERSION, parseConfig } from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEADLESS_MUTATION_AUTHORITY_ENV } from "../src/mutation-authority.js";
import { buildProgram } from "../src/program.js";

interface InvocationOptions {
  readonly output?: "text" | "json";
  readonly stdinIsTTY?: boolean;
  readonly input?: string;
  readonly selectAgents?: (inventory: unknown) => Promise<string>;
}

describe("init agent activation", () => {
  let root: string;
  let storeRoot: string;
  let previousCellarerHome: string | undefined;
  let previousSystemHome: string | undefined;
  let previousAuthority: string | undefined;
  let previousExitCode: number | undefined;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-init-command-")));
    storeRoot = join(root, "home");
    previousCellarerHome = process.env.CELLARER_HOME;
    previousSystemHome = process.env.HOME;
    previousAuthority = process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    previousExitCode = process.exitCode;
    process.env.CELLARER_HOME = storeRoot;
    process.env.HOME = root;
    process.env[HEADLESS_MUTATION_AUTHORITY_ENV] =
      `v1:1:${Buffer.alloc(32, 0x4e).toString("base64url")}`;
    process.exitCode = undefined;
  });

  afterEach(async () => {
    if (previousCellarerHome === undefined) delete process.env.CELLARER_HOME;
    else process.env.CELLARER_HOME = previousCellarerHome;
    if (previousSystemHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousSystemHome;
    if (previousAuthority === undefined) delete process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    else process.env[HEADLESS_MUTATION_AUTHORITY_ENV] = previousAuthority;
    process.exitCode = previousExitCode;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("uses the interactive selector when text-mode stdin is a TTY", async () => {
    const captured = await invoke(["init"], {
      stdinIsTTY: true,
      selectAgents: async () => "codex",
    });

    expect(captured.stdout).toContain("库房已初始化:");
    expect(await enabledAgents(storeRoot)).toEqual(["codex"]);
  });

  it("persists an interactive empty selection without touching agent targets", async () => {
    const captured = await invoke(["init"], {
      stdinIsTTY: true,
      selectAgents: async () => "",
    });

    expect(captured.stdout).toContain("库房已初始化:");
    expect(await enabledAgents(storeRoot)).toEqual([]);
    await expect(fs.stat(join(root, ".codex"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps non-TTY omission fail-closed without invoking a selector", async () => {
    const captured = await invoke(["init"], {
      output: "json",
      stdinIsTTY: false,
      selectAgents: async () => {
        throw new Error("selector must not run");
      },
    });

    expect(JSON.parse(captured.stdout)).toMatchObject({
      status: "error",
      error: { code: "INPUT_REQUIRED", details: { fields: ["agents"] } },
    });
    await expect(fs.stat(join(storeRoot, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps JSON TTY invocation protocol-only without invoking a selector", async () => {
    const captured = await invoke(["init"], {
      output: "json",
      stdinIsTTY: true,
      selectAgents: async () => {
        throw new Error("selector must not run");
      },
    });

    expect(JSON.parse(captured.stdout)).toMatchObject({
      status: "error",
      error: { code: "INPUT_REQUIRED" },
    });
    expect(captured.stderr).toBe("");
  });

  it("keeps structured file input non-interactive on a TTY", async () => {
    let selectorCalls = 0;
    const request = JSON.stringify({
      protocolVersion: CLI_PROTOCOL_VERSION,
      command: "init",
      requestId: "test:init:file-input",
      input: { dryRun: true },
    });

    const captured = await invoke(["--input", "request.json", "init"], {
      stdinIsTTY: true,
      input: request,
      selectAgents: async () => {
        selectorCalls += 1;
        return "codex";
      },
    });

    expect(selectorCalls).toBe(0);
    expect(captured.stderr).toContain("init requires explicit agent target intent");
    await expect(fs.stat(join(storeRoot, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts --no-agent as explicit empty non-interactive intent", async () => {
    const captured = await invoke(["init", "--no-agent"], {
      output: "json",
      stdinIsTTY: false,
    });

    expect(JSON.parse(captured.stdout)).toMatchObject({ status: "success" });
    expect(await enabledAgents(storeRoot)).toEqual([]);
  });

  it("rejects an empty --agent value instead of treating it as --no-agent", async () => {
    const captured = await invoke(["init", "--agent", ","], {
      output: "json",
      stdinIsTTY: false,
    });

    expect(JSON.parse(captured.stdout)).toMatchObject({
      status: "error",
      error: { code: "INVALID_INPUT", details: { fields: ["agents"] } },
    });
    await expect(fs.stat(join(storeRoot, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts structured agents: [] as explicit empty intent", async () => {
    const request = JSON.stringify({
      protocolVersion: CLI_PROTOCOL_VERSION,
      command: "init",
      requestId: "test:init:empty",
      input: { agents: [], dryRun: true },
    });
    const captured = await invoke(["--input", "-", "init"], {
      output: "json",
      stdinIsTTY: false,
      input: request,
    });

    expect(JSON.parse(captured.stdout)).toMatchObject({
      status: "success",
      requestId: "test:init:empty",
      data: { dryRun: true, agentTargets: [] },
    });
    await expect(fs.stat(join(storeRoot, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects --agent with --no-agent as ambiguous before initialization", async () => {
    const captured = await invoke(["init", "--agent", "codex", "--no-agent"], {
      output: "json",
      stdinIsTTY: false,
    });

    expect(JSON.parse(captured.stdout)).toMatchObject({
      status: "error",
      error: { code: "INPUT_AMBIGUITY", details: { fields: ["agents"] } },
    });
    await expect(fs.stat(join(storeRoot, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects structured agent targets with --no-agent as ambiguous", async () => {
    const request = JSON.stringify({
      protocolVersion: CLI_PROTOCOL_VERSION,
      command: "init",
      requestId: "test:init:ambiguous-structured",
      input: { agents: ["codex"], dryRun: true },
    });
    const captured = await invoke(["--input", "request.json", "init", "--no-agent"], {
      output: "json",
      stdinIsTTY: true,
      input: request,
    });

    expect(JSON.parse(captured.stdout)).toMatchObject({
      status: "error",
      requestId: "test:init:ambiguous-structured",
      error: { code: "INPUT_AMBIGUITY", details: { fields: ["agents"] } },
    });
    await expect(fs.stat(join(storeRoot, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts matching repeated initialization and rejects conflicting activation", async () => {
    expect(JSON.parse((await invokeJson(["init", "--agent", "codex"])).stdout)).toMatchObject({
      status: "success",
    });
    const configPath = join(storeRoot, "config.json");
    const before = await fs.readFile(configPath, "utf8");

    expect(JSON.parse((await invokeJson(["init", "--agent", "codex"])).stdout)).toMatchObject({
      status: "success",
    });
    const conflicting = JSON.parse((await invokeJson(["init", "--agent", "claude-code"])).stdout);
    expect(conflicting).toMatchObject({
      status: "error",
      error: {
        code: "DOMAIN_VALIDATION_FAILED",
        details: {
          currentAgentTargets: ["codex"],
          requestedAgentTargets: ["claude-code"],
        },
      },
    });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(before);
  });
});

async function enabledAgents(root: string): Promise<string[]> {
  const config = parseConfig(await fs.readFile(join(root, "config.json"), "utf8"));
  return Object.entries(config.adapterOverrides)
    .filter(([, override]) => override.enabled === true)
    .map(([agentId]) => agentId)
    .sort();
}

function invokeJson(args: readonly string[]) {
  return invoke(args, { output: "json", stdinIsTTY: false });
}

async function invoke(
  args: readonly string[],
  options: InvocationOptions = {},
): Promise<{ stdout: string; stderr: string }> {
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
  const inputIo = {
    stdinIsTTY: options.stdinIsTTY ?? false,
    readInput: async () => options.input ?? "",
  };
  const program = buildProgram(inputIo, options.selectAgents);
  program.exitOverride();
  const argv = options.output === "json" ? ["--output", "json", ...args] : [...args];
  try {
    await program.parseAsync(["node", "cellarer", ...argv], { from: "node" });
  } finally {
    process.stdout.write = oldStdoutWrite;
    process.stderr.write = oldStderrWrite;
    globalThis.console.log = oldConsoleLog;
    globalThis.console.warn = oldConsoleWarn;
    globalThis.console.error = oldConsoleError;
  }
  return { stdout: stdout.join(""), stderr: stderr.join("") };
}
