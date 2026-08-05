import { CLI_PROTOCOL_VERSION } from "@cellarer/core";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import {
  assertNonInteractiveMutationInput,
  CliInputError,
  getCliInvocation,
  installCliInputBoundary,
} from "../src/protocol/input.js";

function statusProgram(
  request: unknown = {
    protocolVersion: CLI_PROTOCOL_VERSION,
    command: "status",
    input: { agents: ["codex"] },
  },
) {
  const action = vi.fn();
  const readInput = vi.fn(async () => JSON.stringify(request));
  const program = new Command().name("cellarer");
  installCliInputBoundary(program, {
    stdinIsTTY: true,
    readInput,
  });
  program
    .command("status")
    .option("-a, --agent <ids>")
    .option("--dir <path>")
    .option("--json")
    .action((opts: { agent?: string; json?: boolean }, command: Command) => {
      action(opts, getCliInvocation(command));
    });
  return { action, program, readInput };
}

describe("agent CLI structured input boundary", () => {
  it.each([
    [
      ["--output", "jsonl", "--non-interactive", "status"],
      { output: "jsonl", nonInteractive: true },
      true,
    ],
    [["status", "--json", "--output", "text"], { output: "text", nonInteractive: false }, false],
    [["status", "--output", "json"], { output: "json", nonInteractive: true }, true],
  ])("parses global options in either position with explicit output precedence", async (argv, expected, expectedJson) => {
    const { action, program } = statusProgram();

    await program.parseAsync(argv, { from: "user" });

    expect(action).toHaveBeenCalledOnce();
    expect(action.mock.calls[0]?.[0]).toMatchObject({ json: expectedJson });
    expect(action.mock.calls[0]?.[1]).toMatchObject(expected);
  });

  it("validates and normalizes a structured request before the action", async () => {
    const request = {
      protocolVersion: CLI_PROTOCOL_VERSION,
      command: "status",
      requestId: "req-from-input",
      input: { agents: ["codex", "claude-code"], dir: "/tmp/project" },
    };
    const { action, program, readInput } = statusProgram(request);

    await program.parseAsync(["status", "--input", "request.json"], { from: "user" });

    expect(readInput).toHaveBeenCalledWith("request.json");
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "codex,claude-code", dir: "/tmp/project" }),
      expect.objectContaining({ requestId: "req-from-input", inputSource: "request.json" }),
    );
  });

  it("rejects invalid structured input before the action without reflecting values", async () => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const { action, program } = statusProgram({
      protocolVersion: CLI_PROTOCOL_VERSION,
      command: "status",
      input: { agents: ["codex"], unknown: canary },
    });

    const error = await program
      .parseAsync(["status", "--input", "request.json"], { from: "user" })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(CliInputError);
    expect(error).toMatchObject({ cliError: { code: "INVALID_INPUT" } });
    expect(String((error as Error).message)).not.toContain(canary);
    expect(action).not.toHaveBeenCalled();
  });

  it("rejects argv/request domain ambiguity before the action", async () => {
    const { action, program } = statusProgram();

    const error = await program
      .parseAsync(["status", "--agent", "claude-code", "--input", "request.json"], {
        from: "user",
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(CliInputError);
    expect(error).toMatchObject({
      cliError: { code: "INPUT_AMBIGUITY", details: { fields: ["agents"] } },
    });
    expect(action).not.toHaveBeenCalled();
  });

  it("supplies required positional domain input from a validated request", async () => {
    const action = vi.fn();
    const program = new Command().name("cellarer");
    installCliInputBoundary(program, {
      stdinIsTTY: true,
      readInput: async () =>
        JSON.stringify({
          protocolVersion: CLI_PROTOCOL_VERSION,
          command: "add",
          input: { source: "/tmp/source", skills: ["one", "two"] },
        }),
    });
    program
      .command("add")
      .argument("[source]")
      .option("--skill <name>", "skill", (value, previous: string[]) => [...previous, value], [])
      .action((source: string | undefined, opts: { skill?: string[] }) => action(source, opts));

    await program.parseAsync(["add", "--input", "request.json"], { from: "user" });

    expect(action).toHaveBeenCalledWith(
      "/tmp/source",
      expect.objectContaining({ skill: ["one", "two"] }),
    );
  });

  it("supplies the UI protected token descriptor from registry-owned metadata", async () => {
    const action = vi.fn();
    const program = new Command().name("cellarer");
    installCliInputBoundary(program, {
      stdinIsTTY: true,
      readInput: async () =>
        JSON.stringify({
          protocolVersion: CLI_PROTOCOL_VERSION,
          command: "ui",
          input: { port: 4318, tokenFd: 7 },
        }),
    });
    program
      .command("ui")
      .option("--port <port>")
      .option("--token-fd <number>")
      .action((opts: { port?: string; tokenFd?: string }) => action(opts));

    await program.parseAsync(["ui", "--input", "request.json"], { from: "user" });

    expect(action).toHaveBeenCalledWith(expect.objectContaining({ port: "4318", tokenFd: "7" }));
  });

  it.each([
    ["secret.ls", { passphraseFd: 2_147_483_648 }, ["secret", "ls"]],
    ["ui", { tokenFd: 2_147_483_648 }, ["ui"]],
  ] as const)("rejects an out-of-range %s descriptor in structured input", async (command, input, args) => {
    const action = vi.fn();
    const program = new Command().name("cellarer");
    installCliInputBoundary(program, {
      stdinIsTTY: true,
      readInput: async () =>
        JSON.stringify({
          protocolVersion: CLI_PROTOCOL_VERSION,
          command,
          input,
        }),
    });
    if (command === "ui") {
      program.command("ui").option("--token-fd <number>").action(action);
    } else {
      program.command("secret").command("ls").option("--passphrase-fd <number>").action(action);
    }

    const error = await program
      .parseAsync([...args, "--input", "request.json"], { from: "user" })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(CliInputError);
    expect(error).toMatchObject({ cliError: { code: "INVALID_INPUT" } });
    expect(action).not.toHaveBeenCalled();
  });

  it("treats structured stdin and non-TTY execution as non-interactive", async () => {
    const fromStdin = statusProgram();
    await fromStdin.program.parseAsync(["status", "--input", "-"], { from: "user" });
    expect(fromStdin.action.mock.calls[0]?.[1]).toMatchObject({ nonInteractive: true });

    const action = vi.fn();
    const program = new Command().name("cellarer");
    installCliInputBoundary(program, {
      stdinIsTTY: false,
      readInput: vi.fn(),
    });
    program.command("status").action((_opts, command: Command) => {
      action(getCliInvocation(command));
    });
    await program.parseAsync(["status"], { from: "user" });
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ nonInteractive: true }));
  });

  it("rejects mutation defaults that would broaden non-interactive execution", () => {
    const invocation = {
      output: "json" as const,
      nonInteractive: true,
    };

    let applyError: unknown;
    try {
      assertNonInteractiveMutationInput("apply", { agents: ["codex"] }, invocation);
    } catch (error) {
      applyError = error;
    }
    expect(applyError).toMatchObject({ cliError: { code: "INPUT_REQUIRED" } });
    expect(() =>
      assertNonInteractiveMutationInput(
        "apply",
        { agents: ["codex"], capabilities: ["skills"] },
        invocation,
      ),
    ).not.toThrow();
    let revertError: unknown;
    try {
      assertNonInteractiveMutationInput("revert", {}, invocation);
    } catch (error) {
      revertError = error;
    }
    expect(revertError).toMatchObject({ cliError: { code: "INPUT_REQUIRED" } });
    expect(() =>
      assertNonInteractiveMutationInput("revert", { all: true }, invocation),
    ).not.toThrow();
  });
});
