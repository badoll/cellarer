import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEADLESS_MUTATION_AUTHORITY_ENV } from "../src/mutation-authority.js";

const core = vi.hoisted(() => ({
  apply: vi.fn(),
}));

vi.mock("@cellarer/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cellarer/core")>();
  return { ...actual, apply: core.apply };
});

import { buildProgram } from "../src/program.js";

describe("apply text presentation", () => {
  let root: string;
  let previousHome: string | undefined;
  let previousAuthority: string | undefined;
  let previousExitCode: number | undefined;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-apply-presentation-")));
    previousHome = process.env.CELLARER_HOME;
    previousAuthority = process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    previousExitCode = process.exitCode;
    process.env.CELLARER_HOME = root;
    process.env[HEADLESS_MUTATION_AUTHORITY_ENV] =
      `v1:1:${Buffer.alloc(32, 0x37).toString("base64url")}`;
    process.exitCode = undefined;
    core.apply.mockReset();
  });

  afterEach(async () => {
    restoreEnv("CELLARER_HOME", previousHome);
    restoreEnv(HEADLESS_MUTATION_AUTHORITY_ENV, previousAuthority);
    process.exitCode = previousExitCode;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("labels only the action supported by typed secret-guard evidence as guarded", async () => {
    core.apply.mockResolvedValue({
      plan: {
        actions: [
          {
            ...skip(
              "direct-artifact-guard",
              "/direct-artifact-target",
              ["rules/other"],
              "direct artifact guard",
            ),
            artifact: "rules/direct-artifact-guard",
          },
          skip("artifact-guard", "/artifact-target", ["rules/artifact-guard"], "artifact guard"),
          {
            ...skip("source-guard", "/source-target", ["rules/source-action"], "source guard"),
            source: "/source-guard",
          },
          skip("target-guard", "/target-guard", ["rules/target-action"], "target guard"),
          {
            ...skip("ordinary", "/ordinary", ["rules/ordinary"], "ordinary skip"),
            source: "/ordinary-source",
          },
          skip("unsupported", "", [], "unsupported wording"),
          skip("ownership", "/owned", ["rules/owned"], "ownership wording"),
          skip("path", "", [], "path wording"),
        ],
        warnings: [],
        conflicts: [
          {
            code: "UNOWNED_TARGET",
            target: "/owned",
            message: "ownership wording",
            ownership: {
              classification: "unowned-existing",
              key: "rules:owned",
              currentFingerprint: "sha256:owned",
            },
          },
        ],
        secretFindings: [
          {
            artifact: "rules/direct-artifact-guard",
            source: "rules/direct-artifact-guard.md",
            line: 1,
            rule: "sensitive-field",
          },
          {
            artifact: "rules/artifact-guard",
            source: "rules/artifact-guard.md",
            line: 1,
            rule: "sensitive-field",
          },
          {
            artifact: "rules/source-finding",
            source: "/source-guard",
            line: 1,
            rule: "sensitive-field",
          },
          {
            artifact: "rules/target-finding",
            source: "/target-guard",
            line: 1,
            rule: "sensitive-field",
          },
        ],
      },
      entries: [],
      failures: [],
      mutation: { planId: "plan-1", operation: "apply", baseRevision: 0 },
    });

    const captured = await invoke(["apply", "--agent", "codex", "--rules"]);
    const guardedLines = captured.stderr
      .split("\n")
      .filter((line) => line.includes("被安全护栏拦截"));

    expect(guardedLines).toEqual([
      expect.stringContaining("direct-artifact-guard rules 被安全护栏拦截:direct artifact guard"),
      expect.stringContaining("artifact-guard rules 被安全护栏拦截:artifact guard"),
      expect.stringContaining("source-guard rules 被安全护栏拦截:source guard"),
      expect.stringContaining("target-guard rules 被安全护栏拦截:target guard"),
    ]);
  });

  it("correlates a reference name with every guarded MCP action but not an ordinary pre-skip", async () => {
    core.apply.mockResolvedValue({
      plan: {
        actions: [
          skip("rules-guard", "/rules-target", ["rules/guarded"], "rules guard"),
          {
            ...skip("mcp-guard", "/mcp-target", ["mcp/guarded"], "reference guard", "mcp"),
            secretRefs: ["MISSING_TOKEN"],
          },
          skip("ordinary-mcp", "/ordinary-mcp", ["mcp/ordinary"], "ordinary skip", "mcp"),
          {
            ...skip("mcp-guard-two", "/mcp-target-two", ["mcp/guarded"], "reference guard", "mcp"),
            secretRefs: ["MISSING_TOKEN"],
          },
        ],
        warnings: [],
        conflicts: [],
        secretFindings: [
          {
            artifact: "rules/guarded",
            source: "rules/guarded.md",
            line: 1,
            rule: "sensitive-field",
          },
        ],
        secretReferenceFindings: [
          {
            reference: "$" + "{CELLARER_SECRET:MISSING_TOKEN}",
            provider: "keychain",
            status: "missing",
          },
        ],
      },
      entries: [],
      failures: [],
      mutation: { planId: "plan-2", operation: "apply", baseRevision: 0 },
    });

    const captured = await invoke(["apply", "--agent", "codex", "--rules", "--mcp"]);
    const guardedLines = captured.stderr
      .split("\n")
      .filter((line) => line.includes("被安全护栏拦截"));

    expect(guardedLines).toEqual([
      expect.stringContaining("rules-guard rules 被安全护栏拦截:rules guard"),
      expect.stringContaining("mcp-guard mcp 被安全护栏拦截:reference guard"),
      expect.stringContaining("mcp-guard-two mcp 被安全护栏拦截:reference guard"),
    ]);
    expect(captured.stderr).not.toContain("ordinary-mcp mcp 被安全护栏拦截");
  });
});

function skip(
  agent: string,
  target: string,
  artifactIds: string[],
  reason: string,
  capability: "rules" | "mcp" = "rules",
) {
  return {
    artifact: artifactIds[0] ?? `${capability}/*`,
    artifactIds,
    agent,
    scope: "global" as const,
    capability,
    target,
    method: "symlink" as const,
    op: "skip" as const,
    reason,
  };
}

async function invoke(args: readonly string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const oldStdoutWrite = process.stdout.write;
  const oldStderrWrite = process.stderr.write;
  const oldConsoleLog = globalThis.console.log;
  const oldConsoleWarn = globalThis.console.warn;
  const oldConsoleError = globalThis.console.error;
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
    await buildProgram().parseAsync(["node", "cellarer", ...args], { from: "node" });
  } finally {
    process.stdout.write = oldStdoutWrite;
    process.stderr.write = oldStderrWrite;
    globalThis.console.log = oldConsoleLog;
    globalThis.console.warn = oldConsoleWarn;
    globalThis.console.error = oldConsoleError;
  }
  return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: process.exitCode };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
