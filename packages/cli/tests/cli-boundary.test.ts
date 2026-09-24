import { StoreMutationConflictError } from "@cellarer/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandRegistry } from "../src/protocol/command-registry.js";
import { CliHandledError } from "../src/protocol/errors.js";
import { handleCliBoundaryError } from "../src/protocol/execution.js";
import { CliInputError, validateJsonSchema } from "../src/protocol/input.js";
import { runCli } from "../src/runner.js";

vi.mock("../src/mutation-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/mutation-authority.js")>()),
  attachMutationAuthority: async () => undefined,
}));

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;
const originalExitCode = process.exitCode;

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("top-level CLI parse boundary", () => {
  it.each([
    ["unknown command", ["--output", "json", "does-not-exist"], "does-not-exist"],
    ["unknown option", ["--output", "json", "status", "--does-not-exist"], "status"],
    ["excess argument", ["--output", "json", "status", "unexpected"], "status"],
    [
      "transport-like argument after double dash",
      ["--output", "json", "status", "--", "--output=text"],
      "status",
    ],
    [
      "command-like excess arguments",
      ["status", "authority", "rotate", "--output", "json"],
      "status",
    ],
    ["unknown nested command", ["--output", "json", "authority", "does-not-exist"], "authority"],
    [
      "unknown nested option",
      ["authority", "rotate", "--does-not-exist", "--output", "json"],
      "authority.rotate",
    ],
  ])("wraps %s in one machine terminal envelope", async (_label, args, expectedCommand) => {
    const captured = await invoke(args);

    expect(captured.stderr).toBe("");
    expect(captured.stdout.trimEnd().split("\n")).toHaveLength(1);
    const envelope = JSON.parse(captured.stdout) as unknown;
    expect(envelope).toMatchObject({
      command: expectedCommand,
      status: "error",
      error: { code: "INVALID_USAGE" },
    });
    const definition = commandRegistry.find(({ command }) => command === expectedCommand);
    if (definition) expect(validateJsonSchema(envelope, definition.outputSchema)).toEqual([]);
    expect(process.exitCode).toBe(2);
  });

  it("keeps Commander prose on stderr in text mode", async () => {
    const captured = await invoke(["does-not-exist"]);

    expect(captured.stdout).toBe("");
    expect(captured.stderr).toContain("unknown command");
    expect(process.exitCode).toBe(2);
  });

  it("maps an unreadable secret value descriptor to a non-leaking input failure", async () => {
    const captured = await invoke([
      "--output",
      "json",
      "secret",
      "add",
      "canary",
      "--provider",
      "keychain",
      "--fd",
      "9999",
    ]);

    expect(captured.stderr).toBe("");
    expect(captured.stdout).not.toMatch(/EBADF|readFileSync|commands\/secret\.ts/i);
    expect(JSON.parse(captured.stdout)).toMatchObject({
      command: "secret.add",
      status: "error",
      error: { code: "INVALID_INPUT" },
    });
    expect(process.exitCode).toBe(2);
  });

  it.each([
    ["passphrase", ["secret", "ls", "--passphrase-fd"]],
    ["UI token", ["ui", "--token-fd"]],
  ] as const)("rejects invalid %s descriptor argv as typed input without a stack", async (_label, prefix) => {
    for (const value of ["2", "2147483648", "NaN"]) {
      const captured = await invoke(["--output", "json", ...prefix, value]);

      expect(captured.stderr).toBe("");
      expect(captured.stdout).not.toMatch(
        /stack|readProtectedDescriptorInput|commands\/secret\.ts/i,
      );
      expect(JSON.parse(captured.stdout)).toMatchObject({
        status: "error",
        error: { code: "INVALID_INPUT" },
      });
      expect(process.exitCode).toBe(2);
    }
  });

  it.each([
    [new CliInputError("INVALID_INPUT", "bad input"), "INVALID_INPUT", 2],
    [
      new CliHandledError({ code: "POLICY_VIOLATION", message: "policy denied" }),
      "POLICY_VIOLATION",
      3,
    ],
    [
      new StoreMutationConflictError({
        code: "INVALID_PLAN",
        message: "mutation plan is invalid",
      }),
      "DOMAIN_VALIDATION_FAILED",
      3,
    ],
  ] as const)("preserves normal classified %s mapping", (error, expectedCode, expectedExitCode) => {
    const captured = captureWrites(() => {
      handleCliBoundaryError(error, {
        command: "status",
        output: "json",
        nonInteractive: true,
      });
    });

    expect(captured.stderr).toBe("");
    expect(JSON.parse(captured.stdout)).toMatchObject({
      status: "error",
      error: { code: expectedCode },
    });
    expect(process.exitCode).toBe(expectedExitCode);
  });

  it.each([
    "json",
    "jsonl",
  ] as const)("wraps an unclassified %s boundary error in exactly one redacted internal-error envelope", (output) => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const captured = captureWrites(() => {
      handleCliBoundaryError(
        new Error(`unexpected failure: ${canary}`, {
          cause: new Error(`nested cause: ${canary}`),
        }),
        {
          command: "status",
          output,
          requestId: "req-boundary-error",
          nonInteractive: true,
        },
      );
    });

    expect(captured.stderr).toBe("[REDACTED]\n");
    expect(captured.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(captured.stdout)).toMatchObject({
      command: "status",
      requestId: "req-boundary-error",
      status: "error",
      error: { code: "INTERNAL_ERROR" },
    });
    expect(captured.stdout + captured.stderr).not.toContain(canary);
    expect(process.exitCode).toBe(70);
  });

  it.each([
    "json",
    "jsonl",
  ] as const)("terminates hostile diagnostic extraction in %s mode with exit 70", (output) => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const error = Object.defineProperty(new Error("safe message"), "stack", {
      configurable: true,
      get() {
        throw new Error(`hostile stack: ${canary}`);
      },
    });

    const captured = captureWrites(() => {
      handleCliBoundaryError(error, {
        command: "status",
        output,
        requestId: "req-hostile-boundary",
        nonInteractive: true,
      });
    });

    expect(captured.stderr).toBe("Unexpected internal failure\n");
    expect(captured.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(captured.stdout)).toMatchObject({
      command: "status",
      requestId: "req-hostile-boundary",
      status: "error",
      error: { code: "INTERNAL_ERROR" },
    });
    expect(captured.stdout + captured.stderr).not.toContain(canary);
    expect(process.exitCode).toBe(70);
  });

  it("keeps an unclassified text boundary error human-readable and redacted", () => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...messages) => {
      errors.push(messages.map(String).join(" "));
    });
    const captured = captureWrites(() => {
      handleCliBoundaryError(new Error(`unexpected failure: ${canary}`), {
        command: "status",
        output: "text",
        nonInteractive: false,
      });
    });

    expect(captured.stdout).toBe("");
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain(canary);
    expect(errors[0]?.trim()).not.toBe("");
    expect(process.exitCode).toBe(70);
  });

  it.each([
    [
      "message getter",
      () =>
        Object.defineProperties(new Error("safe message"), {
          stack: { configurable: true, value: undefined },
          message: {
            configurable: true,
            get() {
              throw new Error("hostile message getter");
            },
          },
        }),
    ],
    [
      "string conversion",
      () =>
        Object.defineProperty({}, "toString", {
          configurable: true,
          get() {
            throw new Error("hostile toString getter");
          },
        }),
    ],
  ] as const)("does not rethrow a hostile %s at the text boundary", (_label, createError) => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...messages) => {
      errors.push(messages.map(String).join(" "));
    });

    expect(() =>
      handleCliBoundaryError(createError(), {
        command: "status",
        output: "text",
        nonInteractive: false,
      }),
    ).not.toThrow();

    expect(errors).toEqual(["Unexpected internal failure"]);
    expect(process.exitCode).toBe(70);
  });
});

async function invoke(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  await runCli(["node", "cellarer", ...args]);
  return { stdout: stdout.join(""), stderr: stderr.join("") };
}

function captureWrites(action: () => void): { stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  action();
  return { stdout: stdout.join(""), stderr: stderr.join("") };
}
