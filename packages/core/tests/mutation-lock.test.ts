import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as ts from "typescript";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LockOwnerEvidence } from "../src/protocol/models.js";
import {
  acquireStoreMutationLock,
  mutationLockPath,
  type StoreMutationLock,
} from "../src/protocol/mutation-lock.js";
import { makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const tsRuntime = createRequire(import.meta.url)("typescript") as typeof ts;
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(packageRoot, "src");

let sourceBuildRoot: string;
let lockUrl: string;
let sourceBuildInputs: readonly string[] = [];

function owner(operationId: string, acquiredAt = "2026-07-28T10:00:00.000Z"): LockOwnerEvidence {
  return { operationId, processId: 1234, hostname: "test-host", acquiredAt };
}

async function runChild(storeRoot: string, evidence: LockOwnerEvidence): Promise<unknown> {
  const script = `
    const [{ open, readFile, rm }, { acquireStoreMutationLock }] = await Promise.all([
      import("node:fs/promises"), import(process.argv[1])
    ]);
    const env = {
      fs: {
        async writeFileExclusive(path, data, options) {
          let handle;
          try {
            handle = await open(path, "wx", options?.mode);
            await handle.writeFile(data, "utf8");
            return true;
          } catch (error) {
            if (error?.code === "EEXIST") return false;
            throw error;
          } finally {
            await handle?.close();
          }
        },
        readFile: (path) => readFile(path, "utf8"),
        rm: (path) => rm(path)
      }
    };
    const result = await acquireStoreMutationLock(
      env, process.argv[2], JSON.parse(process.argv[3])
    );
    if (result.ok) await result.lock.release();
    process.stdout.write(JSON.stringify(result.ok ? { ok: true } : result));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", script, lockUrl, storeRoot, JSON.stringify(evidence)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`lock child exited ${code}: ${stderr}`));
      resolve(JSON.parse(stdout));
    });
  });
}

describe("store mutation lock", () => {
  let t: TmpEnv;
  let held: StoreMutationLock | undefined;

  beforeAll(() => {
    sourceBuildRoot = mkdtempSync(join(tmpdir(), "cellarer-mutation-lock-source-build-"));
    sourceBuildInputs = buildCurrentCoreSource(sourceBuildRoot);
    lockUrl = pathToFileURL(join(sourceBuildRoot, "dist", "protocol", "mutation-lock.js")).href;
  });
  afterAll(() => {
    rmSync(sourceBuildRoot, { recursive: true, force: true });
  });
  beforeEach(() => {
    t = makeTmpEnv();
  });

  it("runs the child from a suite-unique build of the current Core source", () => {
    const builtLock = realpathSync(fileURLToPath(lockUrl));
    const sharedDist = `${realpathSync(packageRoot)}${sep}dist${sep}`;

    expect(builtLock.startsWith(realpathSync(sourceBuildRoot) + sep)).toBe(true);
    expect(builtLock.startsWith(sharedDist)).toBe(false);
    expect(sourceBuildInputs).toEqual([
      realpathSync(join(sourceRoot, "protocol", "mutation-lock.ts")),
    ]);
  });
  afterEach(async () => {
    await held?.release();
    await t.cleanup();
  });

  it("returns the active owner when another process requests the same store", async () => {
    const active = owner("operation-parent");
    const acquired = await acquireStoreMutationLock(t.env, t.path("store"), active);
    if (!acquired.ok) throw new Error("expected parent lock acquisition");
    held = acquired.lock;

    const child = await runChild(t.path("store"), owner("operation-child"));

    expect(child).toEqual({
      ok: false,
      conflict: {
        code: "LOCK_CONFLICT",
        message: "store mutation lock is held",
        owner: active,
      },
    });
    await expect(t.env.fs.readFile(mutationLockPath(t.path("store")))).resolves.toContain(
      "operation-parent",
    );
  });

  it("never deletes an apparently abandoned lock based only on age", async () => {
    const abandoned = owner("operation-abandoned", "2020-01-01T00:00:00.000Z");
    const acquired = await acquireStoreMutationLock(t.env, t.path("store"), abandoned);
    if (!acquired.ok) throw new Error("expected abandoned lock setup");
    held = acquired.lock;

    const blocked = await acquireStoreMutationLock(
      t.env,
      t.path("store"),
      owner("operation-new", "2030-01-01T00:00:00.000Z"),
    );

    expect(blocked).toEqual({
      ok: false,
      conflict: {
        code: "LOCK_CONFLICT",
        message: "store mutation lock is held",
        owner: abandoned,
      },
    });
    await expect(t.env.fs.readFile(mutationLockPath(t.path("store")))).resolves.toContain(
      "operation-abandoned",
    );
  });
});

function buildCurrentCoreSource(destinationRoot: string): readonly string[] {
  const configPath = join(packageRoot, "tsconfig.json");
  const parsed = tsRuntime.getParsedCommandLineOfConfigFile(
    configPath,
    {
      composite: false,
      declaration: false,
      declarationMap: false,
      incremental: false,
      outDir: join(destinationRoot, "dist"),
      rootDir: sourceRoot,
      sourceMap: false,
      tsBuildInfoFile: join(destinationRoot, ".tsbuildinfo"),
    },
    {
      ...tsRuntime.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(formatDiagnostics([diagnostic]));
      },
    },
  );
  if (!parsed) throw new Error("failed to parse Core tsconfig for mutation-lock source build");
  if (parsed.errors.length > 0) throw new Error(formatDiagnostics(parsed.errors));
  const entrypoints = [join(sourceRoot, "protocol", "mutation-lock.ts")];
  const program = tsRuntime.createProgram({ rootNames: entrypoints, options: parsed.options });
  const source = program.getSourceFile(entrypoints[0] ?? "");
  if (!source) throw new Error("failed to load mutation-lock source entrypoint");
  const emit = program.emit(source);
  const diagnostics = [
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source),
    ...emit.diagnostics,
  ];
  if (diagnostics.length > 0) throw new Error(formatDiagnostics(diagnostics));
  return entrypoints.map((path) => realpathSync(path));
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return tsRuntime.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => relative(packageRoot, fileName),
    getCurrentDirectory: () => packageRoot,
    getNewLine: () => "\n",
  });
}
