import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRealEnv, initializeStore, loadConfig, operationJournalPath } from "@cellarer/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { crossProcessMutationAuthority } from "./helpers/cross-process-mutation-authority.js";

const execFileAsync = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "..", "..", "..");
const childFixture = join(testDirectory, "fixtures", "sidecar-concurrency-child.mjs");
const typescriptBin = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

describe("multi-process sidecar store serialization", () => {
  let root: string;
  let storeRoot: string;
  let staticRoot: string;
  let tipPath: string;
  const children = new Set<ChildProtocol>();

  beforeAll(async () => {
    await execFileAsync(
      process.execPath,
      [typescriptBin, "-b", "packages/web/tsconfig.json", "--force"],
      {
        cwd: repositoryRoot,
      },
    );
  });

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-sidecar-processes-")));
    storeRoot = join(root, "home", ".cellarer");
    staticRoot = join(root, "dist");
    tipPath = join(root, "authority-tip.json");
    await fs.mkdir(join(staticRoot, "assets"), { recursive: true });
    await fs.writeFile(join(staticRoot, "index.html"), "<!doctype html><title>cellarer</title>");
    const env = {
      ...createRealEnv(),
      homedir: () => join(root, "home"),
      cwd: () => root,
      mutationAuthority: crossProcessMutationAuthority(tipPath),
    };
    await initializeStore(env, storeRoot);
  });

  afterEach(async () => {
    for (const child of children) child.terminate();
    await Promise.all([...children].map((child) => child.exited.catch(() => undefined)));
    children.clear();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("permits at most one current commit when two sidecars apply plans from one revision", async () => {
    const first = startChild("process-a");
    const second = startChild("process-b");
    const [firstReady, secondReady] = await Promise.all([
      first.next<ReadyMessage>("ready"),
      second.next<ReadyMessage>("ready"),
    ]);
    expect(new URL(firstReady.ready.baseUrl).port).not.toBe("");
    expect(new URL(secondReady.ready.baseUrl).port).not.toBe("");
    expect(firstReady.ready.baseUrl).not.toBe(secondReady.ready.baseUrl);
    expect(firstReady.ready.pid).not.toBe(secondReady.ready.pid);

    first.go();
    second.go();
    const results = await Promise.all([
      first.next<ResultMessage>("result"),
      second.next<ResultMessage>("result"),
    ]);
    await Promise.all([first.exited, second.exited]);

    expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([200, 409]);
    const rejected = results.find((result) => result.status === 409);
    expect(rejected?.body).toMatchObject({
      status: "error",
      error: {
        code: expect.stringMatching(/^(LOCK_CONFLICT|STALE_REVISION)$/),
      },
    });
    const observable = JSON.stringify(results);
    expect(observable).not.toContain(`child-${firstReady.ready.pid}-token`);
    expect(observable).not.toContain(`child-${secondReady.ready.pid}-token`);

    const env = {
      ...createRealEnv(),
      mutationAuthority: crossProcessMutationAuthority(tipPath),
    };
    const config = await loadConfig(env, storeRoot);
    expect(["process-a", "process-b"].filter((name) => config.collections[name])).toHaveLength(1);
    await expect(env.fs.lstat(operationJournalPath(storeRoot))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  function startChild(collectionName: string): ChildProtocol {
    const child = new ChildProtocol(
      spawn(process.execPath, [childFixture, storeRoot, staticRoot, tipPath, collectionName], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    children.add(child);
    return child;
  }
});

interface ReadyMessage {
  readonly type: "ready";
  readonly ready: { readonly baseUrl: string; readonly pid: number };
}

interface ResultMessage {
  readonly type: "result";
  readonly status: number;
  readonly body: unknown;
}

class ChildProtocol {
  readonly exited: Promise<void>;
  readonly #messages: unknown[] = [];
  readonly #waiters: Array<(message: unknown) => void> = [];
  #stdout = "";
  #stderr = "";

  constructor(readonly process: ChildProcessWithoutNullStreams) {
    process.stdout.setEncoding("utf8");
    process.stderr.setEncoding("utf8");
    process.stdout.on("data", (chunk: string) => this.#accept(chunk));
    process.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
    this.exited = new Promise<void>((resolve, reject) => {
      process.once("error", reject);
      process.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else
          reject(new Error(`sidecar child exited code=${code} signal=${signal}: ${this.#stderr}`));
      });
    });
  }

  async next<T extends { readonly type: string }>(type: T["type"]): Promise<T> {
    const message =
      this.#messages.shift() ??
      (await new Promise<unknown>((resolve) => this.#waiters.push(resolve)));
    const typed = message as T;
    if (typed.type !== type) {
      throw new Error(`expected child message ${type}, received ${JSON.stringify(message)}`);
    }
    return typed;
  }

  go(): void {
    this.process.stdin.write("go\n");
  }

  terminate(): void {
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill();
  }

  #accept(chunk: string): void {
    this.#stdout += chunk;
    for (;;) {
      const newline = this.#stdout.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdout.slice(0, newline);
      this.#stdout = this.#stdout.slice(newline + 1);
      if (!line) continue;
      const message: unknown = JSON.parse(line);
      const waiter = this.#waiters.shift();
      if (waiter) waiter(message);
      else this.#messages.push(message);
    }
  }
}
