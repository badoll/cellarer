import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealEnv, type Env } from "@cellarer/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCliCommandCatalog } from "../src/commands/command-catalog.js";
import type { ResolvedContext } from "../src/context.js";
import type { MutationAuthorityCompositionMode } from "../src/mutation-authority.js";
import { commandFromCatalog } from "../src/protocol/command-contract.js";

function scanCommand(resolve: () => Promise<ResolvedContext>) {
  const catalog = createCliCommandCatalog({
    scanContextResolver: resolve,
  });
  return commandFromCatalog(catalog, "scan");
}

describe("CLI scan least-privilege composition", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  it("11.4 runs scan --dry-run without authority or credential calls", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-scan-dry-run-")));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const real = createRealEnv();
    let credentialCalls = 0;
    const env: Env = {
      ...real,
      homedir: () => join(root, "home"),
      cwd: () => join(root, "cwd"),
      env: {},
      mutationAuthority: undefined,
      secretStore: {
        async get() {
          credentialCalls += 1;
          return { found: false };
        },
        async set() {
          credentialCalls += 1;
        },
        async delete() {
          credentialCalls += 1;
          return false;
        },
      },
    };
    const storeRoot = join(root, "store");
    for (const kind of ["rules", "mcp", "skills"]) {
      await env.fs.mkdir(join(storeRoot, "store", kind), { recursive: true });
    }
    await env.fs.writeFile(
      join(storeRoot, "config.json"),
      `${JSON.stringify({
        version: 1,
        defaults: { method: "symlink", collections: ["default"], secretMode: "keychain" },
        collections: { default: { description: "Default" } },
        artifacts: {},
        adapterOverrides: {},
        customAdapters: {},
      })}\n`,
      { mode: 0o600 },
    );
    await env.fs.mkdir(join(root, "home", ".claude"), { recursive: true });
    await env.fs.writeFile(join(root, "home", ".claude", "CLAUDE.md"), "# dry run");
    let mode: MutationAuthorityCompositionMode | undefined;
    const resolve = async (
      _opts: object,
      requested: MutationAuthorityCompositionMode,
    ): Promise<ResolvedContext> => {
      mode = requested;
      return {
        env,
        storeRoot,
        scope: "global",
        scopeFilter: undefined,
        agents: ["claude-code"],
      };
    };
    const output: string[] = [];
    const oldWrite = process.stdout.write;
    try {
      process.stdout.write = ((chunk: unknown) => {
        output.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      await scanCommand(resolve).parseAsync(
        [
          "node",
          "scan",
          "--agent",
          "claude-code",
          "--rules",
          "--select",
          JSON.stringify([
            {
              kind: "rules",
              name: "claude-code",
              source: join(root, "home", ".claude", "CLAUDE.md"),
            },
          ]),
          "--dry-run",
          "--json",
        ],
        { from: "node" },
      );
    } finally {
      process.stdout.write = oldWrite;
    }

    expect(mode).toBe("none");
    expect(credentialCalls).toBe(0);
    expect(JSON.parse(output.join("")).data).toMatchObject({
      plan: {
        agent: "claude-code",
        items: [expect.objectContaining({ kind: "rules", name: "claude-code" })],
      },
      imported: [],
    });
  });

  it("rejects legacy name-only mutation selection before scanning", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-scan-selector-")));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const real = createRealEnv();
    const env: Env = {
      ...real,
      homedir: () => join(root, "home"),
      cwd: () => root,
      env: {},
    };
    const storeRoot = join(root, "store");
    let resolved = false;
    const resolve = async (): Promise<ResolvedContext> => {
      resolved = true;
      return {
        env,
        storeRoot,
        scope: "global",
        scopeFilter: undefined,
        agents: ["codex"],
      };
    };
    const output: string[] = [];
    const oldWrite = process.stdout.write;
    try {
      process.stdout.write = ((chunk: unknown) => {
        output.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      await scanCommand(resolve).parseAsync(
        ["node", "scan", "--agent", "codex", "--rules", "--select", "style", "--dry-run", "--json"],
        { from: "node" },
      );
    } finally {
      process.stdout.write = oldWrite;
    }

    expect(resolved).toBe(false);
    expect(JSON.parse(output.join(""))).toMatchObject({
      status: "error",
      error: { code: "INVALID_INPUT", details: { reason: "AMBIGUOUS_SELECTOR" } },
    });
  });
});
