import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealEnv } from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../web/src/app.js";
import { HEADLESS_MUTATION_AUTHORITY_ENV } from "../src/mutation-authority.js";
import { buildProgram } from "../src/program.js";
import { handleCliBoundaryError } from "../src/protocol/execution.js";

describe("CLI and HTTP read parity", () => {
  let root: string;
  let storeRoot: string;
  let previousHome: string | undefined;
  let previousAuthority: string | undefined;
  let previousExitCode: number | undefined;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-read-parity-")));
    storeRoot = join(root, "home");
    previousHome = process.env.CELLARER_HOME;
    previousAuthority = process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    previousExitCode = process.exitCode;
    process.env.CELLARER_HOME = storeRoot;
    process.env[HEADLESS_MUTATION_AUTHORITY_ENV] =
      `v1:1:${Buffer.alloc(32, 0x5a).toString("base64url")}`;
    process.exitCode = undefined;
    expect(await invoke(["init"])).toMatchObject({ status: "success" });
    await fs.writeFile(join(storeRoot, "store", "rules", "style.md"), "# style\n", "utf8");
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.CELLARER_HOME;
    else process.env.CELLARER_HOME = previousHome;
    if (previousAuthority === undefined) delete process.env[HEADLESS_MUTATION_AUTHORITY_ENV];
    else process.env[HEADLESS_MUTATION_AUTHORITY_ENV] = previousAuthority;
    process.exitCode = previousExitCode;
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    {
      name: "resources",
      cliArgs: ["resource", "list", "--no-include-discovered"],
      httpPath: "/api/v1/resources?includeDiscovered=false",
    },
    { name: "collections", cliArgs: ["collection", "list"], httpPath: "/api/v1/collections" },
    { name: "config", cliArgs: ["config", "show"], httpPath: "/api/v1/config" },
  ])("returns the same Core DTO and warnings for $name", async ({ cliArgs, httpPath }) => {
    const cli = await invoke(cliArgs);
    const httpResponse = await createApp({
      env: createRealEnv(),
      storeRoot,
      auth: { mode: "trusted-embedded" },
    }).request(httpPath);
    const http = (await httpResponse.json()) as Record<string, unknown>;

    expect(cli.status).toBe("success");
    expect(httpResponse.status, JSON.stringify(http)).toBe(200);
    expect(http.status).toBe("success");
    expect(withoutVolatile(http.data)).toEqual(withoutVolatile(cli.data));
  });

  it("preserves the stable domain error code and non-disclosing remediation boundary", async () => {
    const cli = await invoke(["resource", "list", "--kind", "not-a-kind"]);
    const response = await createApp({
      env: createRealEnv(),
      storeRoot,
      auth: { mode: "trusted-embedded" },
    }).request("/api/v1/resources/not-a-kind");
    const http = (await response.json()) as {
      readonly error?: { readonly code?: string; readonly details?: unknown };
    };

    expect(cli).toMatchObject({
      status: "error",
      error: { code: "INVALID_INPUT" },
    });
    expect(response.status).toBe(400);
    expect(http.error?.code).toBe((cli.error as { readonly code?: string } | undefined)?.code);
    expect(http.error?.details).toEqual({ fields: ["kind"] });
    expect(JSON.stringify({ cli, http })).not.toContain(storeRoot);
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
    try {
      await buildProgram().parseAsync(
        ["node", "cellarer", "--output", "json", "--non-interactive", ...args],
        { from: "node" },
      );
    } catch (error) {
      handleCliBoundaryError(error);
    }
  } finally {
    process.stdout.write = oldStdoutWrite;
    process.stderr.write = oldStderrWrite;
  }
  expect(stderr).toEqual([]);
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0] as string) as Record<string, unknown>;
}

function withoutVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutVolatile);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["generatedAt", "verifiedAt", "checkedAt", "requestId"].includes(key))
      .map(([key, child]) => [key, withoutVolatile(child)]),
  );
}
