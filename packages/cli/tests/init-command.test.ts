import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_PROTOCOL_VERSION, parseConfig } from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultCliCommandCatalog } from "../src/commands/command-catalog.js";
import { HEADLESS_MUTATION_AUTHORITY_ENV } from "../src/mutation-authority.js";
import { buildProgram } from "../src/program.js";

interface InvocationOptions {
  readonly output?: "text" | "json" | "jsonl";
  readonly stdinIsTTY?: boolean;
  readonly input?: string;
  readonly confirmImport?: (plan: unknown) => Promise<boolean>;
}

describe("init Inventory onboarding", () => {
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

  it("confirms one exact Core-default import without changing activation or agent targets", async () => {
    await createReadySkill(root, "inventory-demo", "initial");
    let confirmationPlan: unknown;
    const captured = await invoke(["init"], {
      stdinIsTTY: true,
      confirmImport: async (plan) => {
        confirmationPlan = plan;
        return true;
      },
    });

    expect(captured.stdout).toContain("库房已初始化:");
    expect(captured.stdout).toContain("inventory: complete");
    expect(confirmationPlan).toMatchObject({
      candidateIds: [expect.stringMatching(/^inventory-candidate:v1:/)],
      mutationPlan: { operation: "store-import" },
    });
    expect(await explicitAgentOverrides(storeRoot)).toEqual({});
    await expect(
      fs.readFile(join(storeRoot, "store", "skills", "inventory-demo", "SKILL.md"), "utf8"),
    ).resolves.toContain("description: initial");
    await expect(
      fs.readFile(join(root, ".codex", "skills", "inventory-demo", "SKILL.md"), "utf8"),
    ).resolves.toContain("description: initial");
    await expect(fs.stat(join(root, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps Store initialization when the user declines the exact import", async () => {
    await createReadySkill(root, "inventory-demo", "declined");
    const captured = await invoke(["init"], {
      stdinIsTTY: true,
      confirmImport: async () => false,
    });

    expect(captured.stdout).toContain("库房已初始化:");
    expect(captured.stdout).toContain("inventory import declined");
    await expect(fs.stat(join(storeRoot, "config.json"))).resolves.toBeDefined();
    await expect(
      fs.stat(join(storeRoot, "store", "skills", "inventory-demo", "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not reconfirm an equal candidate already imported by a prior init", async () => {
    await createReadySkill(root, "inventory-demo", "repeat");
    await invoke(["init"], { stdinIsTTY: true, confirmImport: async () => true });

    const repeated = await invoke(["init"], {
      stdinIsTTY: true,
      confirmImport: async () => {
        throw new Error("in-store candidates must not be offered again");
      },
    });

    expect(repeated.stdout).toContain("inventory: complete");
    expect(repeated.stdout).toContain("0 ready");
    expect(repeated.stdout).toContain("1 in Store");
  });

  it("preserves partial Inventory and skips import confirmation", async () => {
    await createReadySkill(root, "inventory-demo", "partial");
    const external = join(root, "external-rules.md");
    await fs.writeFile(external, "# External\n");
    await fs.mkdir(join(root, ".agents"), { recursive: true });
    await fs.symlink(external, join(root, ".agents", "AGENTS.md"), "file");

    const captured = await invoke(["init"], {
      stdinIsTTY: true,
      confirmImport: async () => {
        throw new Error("partial Inventory must not be confirmed");
      },
    });

    expect(captured.stdout).toContain("inventory: partial");
    expect(captured.stderr).toContain("cellarer inventory refresh");
    await expect(fs.stat(join(storeRoot, "config.json"))).resolves.toBeDefined();
    await expect(
      fs.stat(join(storeRoot, "store", "skills", "inventory-demo", "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves failed Inventory separately from successful Store initialization", async () => {
    const external = join(root, "external-rules.md");
    await fs.writeFile(external, "# External\n");
    await fs.mkdir(join(root, ".agents"), { recursive: true });
    await fs.symlink(external, join(root, ".agents", "AGENTS.md"), "file");

    const captured = await invoke(["init"], {
      stdinIsTTY: true,
      confirmImport: async () => {
        throw new Error("failed Inventory must not be confirmed");
      },
    });

    expect(captured.stdout).toContain("库房已初始化:");
    expect(captured.stdout).toContain("inventory: failed");
    expect(captured.stderr).toContain("cellarer inventory refresh");
    await expect(fs.stat(join(storeRoot, "config.json"))).resolves.toBeDefined();
  });

  it("surfaces stale exact-plan failure without refreshing, replanning, or target writes", async () => {
    const source = await createReadySkill(root, "inventory-demo", "reviewed");
    const captured = await invoke(["init"], {
      stdinIsTTY: true,
      confirmImport: async () => {
        await fs.writeFile(
          source,
          "---\nname: inventory-demo\ndescription: drifted after review\n---\n",
        );
        return true;
      },
    });

    expect(captured.stderr).toContain("TARGET_PRECONDITION_CONFLICT");
    expect(captured.stderr).toContain("cellarer inventory refresh");
    await expect(
      fs.stat(join(storeRoot, "store", "skills", "inventory-demo", "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(join(root, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns closed Inventory in non-TTY JSON with zero prompt and zero import", async () => {
    await createReadySkill(root, "inventory-demo", "machine-json");
    const captured = await invoke(["init"], {
      output: "json",
      stdinIsTTY: false,
      confirmImport: async () => {
        throw new Error("selector must not run");
      },
    });

    expect(JSON.parse(captured.stdout)).toMatchObject({
      status: "success",
      data: {
        store: { createdConfig: true, operation: { ok: true } },
        inventory: {
          completeness: "complete",
          candidates: [expect.objectContaining({ name: "inventory-demo", defaultSelected: true })],
        },
        confirmation: { status: "not-offered", reason: "non-interactive" },
        import: { status: "not-started" },
      },
    });
    expect(captured.stderr).toBe("");
    await expect(fs.stat(join(storeRoot, "config.json"))).resolves.toBeDefined();
    await expect(
      fs.stat(join(storeRoot, "store", "skills", "inventory-demo", "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns one terminal JSONL Inventory record without invoking confirmation", async () => {
    await createReadySkill(root, "inventory-demo", "machine-jsonl");
    const captured = await invoke(["init"], {
      output: "jsonl",
      stdinIsTTY: true,
      confirmImport: async () => {
        throw new Error("selector must not run");
      },
    });

    const records = captured.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: "success",
      data: {
        inventory: { completeness: "complete", candidates: [{ name: "inventory-demo" }] },
        confirmation: { status: "not-offered", reason: "non-interactive" },
        import: { status: "not-started" },
      },
    });
    expect(captured.stderr).toBe("");
  });

  it("keeps structured init prompt-free and imports nothing on a TTY", async () => {
    await createReadySkill(root, "inventory-demo", "structured");
    const request = JSON.stringify({
      protocolVersion: CLI_PROTOCOL_VERSION,
      command: "init",
      requestId: "test:init:file-input",
      input: {},
    });

    const captured = await invoke(["--input", "request.json", "init"], {
      output: "json",
      stdinIsTTY: true,
      input: request,
      confirmImport: async () => {
        throw new Error("structured init must not confirm import");
      },
    });

    expect(JSON.parse(captured.stdout)).toMatchObject({
      status: "success",
      requestId: "test:init:file-input",
      data: {
        inventory: { candidates: [{ name: "inventory-demo" }] },
        confirmation: { status: "not-offered", reason: "non-interactive" },
        import: { status: "not-started" },
      },
    });
    await expect(
      fs.stat(join(storeRoot, "store", "skills", "inventory-demo", "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps explicitly non-interactive text init prompt-free and read-only after Store setup", async () => {
    await createReadySkill(root, "inventory-demo", "explicit-non-interactive");
    const captured = await invoke(["--non-interactive", "init"], {
      stdinIsTTY: true,
      confirmImport: async () => {
        throw new Error("explicitly non-interactive init must not confirm import");
      },
    });

    expect(captured.stdout).toContain("inventory: complete");
    expect(captured.stdout).toContain("inventory import not offered in non-interactive mode");
    await expect(
      fs.stat(join(storeRoot, "store", "skills", "inventory-demo", "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes init activation options and structured selection from help and catalog", async () => {
    const program = buildProgram();
    const help =
      program.commands.find((command) => command.name() === "init")?.helpInformation() ?? "";
    const definition = getDefaultCliCommandCatalog().requireDefinition("init");

    expect(help).not.toContain("--agent");
    expect(help).not.toContain("--no-agent");
    expect(definition.requiredFeatures).not.toContain("exact-agent-targets");
    expect(definition.inputSchema.properties?.input?.properties).not.toHaveProperty("agents");

    const request = JSON.stringify({
      protocolVersion: CLI_PROTOCOL_VERSION,
      command: "init",
      requestId: "test:init:removed-agents",
      input: { agents: [] },
    });
    const removedStructuredProgram = buildProgram({
      stdinIsTTY: false,
      readInput: async () => request,
    });
    removedStructuredProgram.exitOverride();
    const structuredError = await removedStructuredProgram
      .parseAsync(["node", "cellarer", "--input", "-", "init"], { from: "node" })
      .catch((error: unknown) => error);
    expect(structuredError).toMatchObject({ cliError: { code: "INVALID_INPUT" } });
    await expect(fs.stat(join(storeRoot, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function explicitAgentOverrides(root: string): Promise<Record<string, unknown>> {
  const config = parseConfig(await fs.readFile(join(root, "config.json"), "utf8"));
  return config.adapterOverrides;
}

async function createReadySkill(root: string, name: string, description: string): Promise<string> {
  const path = join(root, ".codex", "skills", name, "SKILL.md");
  await fs.mkdir(join(path, ".."), { recursive: true });
  await fs.writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\n`, "utf8");
  return path;
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
  const program = buildProgram(inputIo, options.confirmImport);
  program.exitOverride();
  const argv =
    options.output === "json" || options.output === "jsonl"
      ? ["--output", options.output, ...args]
      : [...args];
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
