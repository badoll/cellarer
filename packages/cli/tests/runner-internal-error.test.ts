import {
  type CliError,
  ControlPlaneValidationError,
  StoreMutationConflictError,
} from "@cellarer/core";
import { CommanderError } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachObservableKnownValues,
  createSecretValue,
} from "../../core/dist/secrets/observable.js";

const boundaryFailure = vi.hoisted(() => ({
  stage: "parse" as "build" | "configure" | "parse",
  error: new Error("uninitialized parse failure"),
}));

vi.mock("../src/program.js", () => ({
  buildProgram: () => {
    if (boundaryFailure.stage === "build") throw boundaryFailure.error;
    return {
      commands: [],
      configureOutput: () => undefined,
      exitOverride: () => {
        if (boundaryFailure.stage === "configure") throw boundaryFailure.error;
      },
      parseAsync: async () => {
        if (boundaryFailure.stage === "parse") throw boundaryFailure.error;
      },
    };
  },
}));

import { getCommandDefinition } from "../src/protocol/command-registry.js";
import { CliHandledError } from "../src/protocol/errors.js";
import { CliInputError, validateJsonSchema } from "../src/protocol/input.js";
import { runCli } from "../src/runner.js";

const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;
const originalExitCode = process.exitCode;

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  process.exitCode = originalExitCode;
  boundaryFailure.stage = "parse";
  vi.restoreAllMocks();
});

describe("runCli internal-error boundary", () => {
  it.each([
    "build",
    "configure",
    "parse",
  ] as const)("emits one redacted terminal envelope when %s throws an unclassified error", async (stage) => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    boundaryFailure.stage = stage;
    boundaryFailure.error = new Error(`unexpected failure: ${canary}`, {
      cause: new Error(`nested cause: ${canary}`),
    });
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

    await runCli([
      "node",
      "cellarer",
      "authority",
      "--output",
      "json",
      "rotate",
      "--",
      "--output=text",
    ]);

    expect(stderr.join("")).toBe("[REDACTED]\n");
    expect(stdout.join("").trimEnd().split("\n")).toHaveLength(1);
    const envelope = JSON.parse(stdout.join("")) as unknown;
    expect(envelope).toMatchObject({
      command: "authority.rotate",
      status: "error",
      error: { code: "INTERNAL_ERROR" },
    });
    expect(
      validateJsonSchema(envelope, getCommandDefinition("authority.rotate").outputSchema),
    ).toEqual([]);
    expect(stdout.join("") + stderr.join("")).not.toContain(canary);
    expect(process.exitCode).toBe(70);
  });

  it("uses a deterministic machine fallback when normal invocation derivation throws", async () => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    process.exitCode = undefined;
    process.stdout.write = ((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      get() {
        throw new Error(`invocation derivation failure: ${canary}`);
      },
    });

    try {
      await runCli([
        "node",
        "cellarer",
        "authority",
        "--output=json",
        "rotate",
        "--",
        "--output=text",
      ]);
    } finally {
      if (originalIsTty) Object.defineProperty(process.stdin, "isTTY", originalIsTty);
      else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
    }

    expect(stderr.join("")).toBe("[REDACTED]\n");
    expect(stdout.join("").trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      command: "authority.rotate",
      status: "error",
      error: { code: "INTERNAL_ERROR" },
    });
    expect(stdout.join("") + stderr.join("")).not.toContain(canary);
    expect(process.exitCode).toBe(70);
  });

  it("keeps a build-stage text failure human-readable and redacted", async () => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    boundaryFailure.stage = "build";
    boundaryFailure.error = new Error(`unexpected failure: ${canary}`);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...messages) => {
      errors.push(messages.map(String).join(" "));
    });

    await runCli(["node", "cellarer", "status"]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain(canary);
    expect(errors[0]?.trim()).not.toBe("");
    expect(process.exitCode).toBe(70);
  });

  it("classifies a Core control-plane validation error as a stable domain error", async () => {
    boundaryFailure.error = new ControlPlaneValidationError("invalid config publication", {
      reason: "INVALID_CONFIG_PUBLICATION",
    });

    const captured = await invokeBoundaryFailure("json");

    expect(captured.thrown).toBeUndefined();
    expect(JSON.parse(captured.stdout)).toMatchObject({
      status: "error",
      error: {
        code: "DOMAIN_VALIDATION_FAILED",
        details: { reason: "INVALID_CONFIG_PUBLICATION" },
      },
    });
    expect(process.exitCode).toBe(3);
  });

  it.each([
    "json",
    "jsonl",
    "text",
  ] as const)("downgrades a hostile getPrototypeOf trap to one redacted %s internal failure", async (output) => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    boundaryFailure.error = new Proxy(new Error("safe outer message"), {
      getPrototypeOf() {
        throw new Error(`hostile prototype trap: ${canary}`);
      },
    });

    const captured = await invokeBoundaryFailure(output);

    expect(captured.thrown).toBeUndefined();
    assertInternalFailure(output, captured, canary);
  });

  const hostilePropertyCases = [
    [
      "CommanderError.exitCode",
      () => hostileProperty(new CommanderError(2, "commander.test", "bad usage"), "exitCode"),
    ],
    [
      "CommanderError.code",
      () => hostileProperty(new CommanderError(2, "commander.test", "bad usage"), "code"),
    ],
    [
      "CliInputError.cliError",
      () => hostileProperty(new CliInputError("INVALID_INPUT", "bad input"), "cliError"),
    ],
    [
      "CliInputError.invocation",
      () => hostileProperty(new CliInputError("INVALID_INPUT", "bad input"), "invocation"),
    ],
    [
      "CliHandledError.cliError",
      () =>
        hostileProperty(
          new CliHandledError({ code: "POLICY_VIOLATION", message: "denied" }),
          "cliError",
        ),
    ],
    [
      "StoreMutationConflictError.conflict",
      () =>
        hostileProperty(
          new StoreMutationConflictError({
            code: "INVALID_PLAN",
            message: "mutation plan is invalid",
          }),
          "conflict",
        ),
    ],
  ] as const;

  it.each(
    hostilePropertyCases.flatMap(([label, createError]) =>
      (["json", "jsonl", "text"] as const).map((output) => [label, output, createError] as const),
    ),
  )("downgrades a hostile %s getter to one redacted %s internal failure", async (_label, output, createError) => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    boundaryFailure.error = createError() as Error;

    const captured = await invokeBoundaryFailure(output);

    expect(captured.thrown).toBeUndefined();
    assertInternalFailure(output, captured, canary);
  });

  const unsafeDetailsCases = [
    [
      "nested Proxy ownKeys",
      (canary: string) => ({
        details: {
          nested: new Proxy(
            { value: canary },
            {
              ownKeys() {
                throw new Error(`hostile details ownKeys: ${canary}`);
              },
            },
          ),
        },
        accessorReads: () => 0,
      }),
    ],
    [
      "nested getter",
      (canary: string) => {
        let reads = 0;
        const nested = Object.defineProperty({}, "value", {
          enumerable: true,
          get() {
            reads += 1;
            throw new Error(`hostile details getter: ${canary}`);
          },
        });
        return {
          details: { nested },
          accessorReads: () => reads,
        };
      },
    ],
    [
      "nested cycle",
      (canary: string) => {
        const nested: Record<string, unknown> = { value: canary };
        nested.self = nested;
        return {
          details: { nested },
          accessorReads: () => 0,
        };
      },
    ],
  ] as const;

  it.each(
    (["input", "handled"] as const).flatMap((errorKind) =>
      (["json", "jsonl"] as const).flatMap((output) =>
        unsafeDetailsCases.map(
          ([label, createDetails]) => [errorKind, output, label, createDetails] as const,
        ),
      ),
    ),
  )("downgrades %s error with %s %s details without reading accessors", async (errorKind, output, _label, createDetails) => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const hostile = createDetails(canary);
    boundaryFailure.error = classifiedError(errorKind, hostile.details);

    const captured = await invokeBoundaryFailure(output);

    expect(captured.thrown).toBeUndefined();
    expect(hostile.accessorReads()).toBe(0);
    assertInternalFailure(output, captured, canary);
  });

  it.each(
    (["input", "handled"] as const).flatMap((errorKind) =>
      (["json", "jsonl"] as const).map((output) => [errorKind, output] as const),
    ),
  )("preserves and redacts safe %s details in %s", async (errorKind, output) => {
    const knownValue = "tiny-known-value";
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const acknowledgementToken = `sha256:${"a".repeat(64)}`;
    const details = attachObservableKnownValues(
      {
        attempt: 2,
        retryable: false,
        nested: { labels: ["alpha", null] },
        accessToken: "plain-sensitive-field",
        knownText: `provider returned ${knownValue}`,
        canaryText: canary,
        acknowledgement: { kind: "replace-unowned", token: acknowledgementToken },
        nearAcknowledgement: {
          kind: "replace-unowned",
          token: acknowledgementToken,
          extra: true,
        },
      },
      [createSecretValue(knownValue)],
    );
    boundaryFailure.error = classifiedError(errorKind, details);

    const captured = await invokeBoundaryFailure(output);

    expect(captured.thrown).toBeUndefined();
    expect(captured.stderr).toBe("");
    expect(captured.stdout.trimEnd().split("\n")).toHaveLength(1);
    const envelope = JSON.parse(captured.stdout) as {
      error: { code: string; details: Record<string, unknown> };
    };
    expect(envelope.error.code).toBe(errorKind === "input" ? "INVALID_INPUT" : "POLICY_VIOLATION");
    expect(envelope.error.details).toMatchObject({
      attempt: 2,
      retryable: false,
      nested: { labels: ["alpha", null] },
      accessToken: "[REDACTED]",
      knownText: "provider returned [REDACTED]",
      canaryText: "[REDACTED]",
      acknowledgement: { kind: "replace-unowned", token: acknowledgementToken },
      nearAcknowledgement: {
        kind: "replace-unowned",
        token: "[REDACTED]",
        extra: true,
      },
    });
    expect(captured.stdout).not.toContain("plain-sensitive-field");
    expect(captured.stdout).not.toContain(knownValue);
    expect(captured.stdout).not.toContain(canary);
    expect(process.exitCode).toBe(errorKind === "input" ? 2 : 3);
  });
});

function classifiedError(
  kind: "input" | "handled",
  details: Readonly<Record<string, unknown>>,
): Error {
  if (kind === "input") return new CliInputError("INVALID_INPUT", "bad input", details);
  const cliError: CliError = { code: "POLICY_VIOLATION", message: "denied", details };
  return new CliHandledError(cliError);
}

function hostileProperty<T extends object>(target: T, property: PropertyKey): T {
  return Object.defineProperty(target, property, {
    configurable: true,
    get() {
      throw new Error("ghp_0123456789abcdefghijklmnopqrstuvwx");
    },
  });
}

async function invokeBoundaryFailure(output: "json" | "jsonl" | "text"): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly consoleErrors: readonly string[];
  readonly thrown: unknown;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const consoleErrors: string[] = [];
  process.exitCode = undefined;
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  vi.spyOn(console, "error").mockImplementation((...messages) => {
    consoleErrors.push(messages.map(String).join(" "));
  });

  const args =
    output === "text"
      ? ["node", "cellarer", "status"]
      : ["node", "cellarer", "--output", output, "status"];
  const thrown = await runCli(args).catch((error: unknown) => error);
  return {
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    consoleErrors,
    thrown,
  };
}

function assertInternalFailure(
  output: "json" | "jsonl" | "text",
  captured: {
    readonly stdout: string;
    readonly stderr: string;
    readonly consoleErrors: readonly string[];
  },
  canary: string,
): void {
  if (output === "text") {
    expect(captured.stdout).toBe("");
    expect(captured.consoleErrors).toHaveLength(1);
  } else {
    expect(captured.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(captured.stdout)).toMatchObject({
      command: "status",
      status: "error",
      error: { code: "INTERNAL_ERROR" },
    });
  }
  expect(captured.stdout + captured.stderr + captured.consoleErrors.join("\n")).not.toContain(
    canary,
  );
  expect(process.exitCode).toBe(70);
}
