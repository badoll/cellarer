import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, promises as nodeFs, realpathSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRealEnv, headlessLifetimeOwnerEndpoint } from "../src/real-env.js";

const cleanups: Array<() => Promise<void>> = [];

function legacyHeadlessLifetimeOwnerPort(normalizedStoreRoot: string): number {
  const digest = createHash("sha256")
    .update("cellarer-headless-lifetime-owner-v1\0")
    .update(normalizedStoreRoot)
    .digest();
  return 49_152 + (digest.readUInt16BE(0) % 16_384);
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function bindLoopback(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
}

async function startChildSocketOwner(endpoint: string): Promise<ChildProcess> {
  const source = [
    'import { createServer } from "node:net";',
    "const endpoint = process.argv[1];",
    "const server = createServer((socket) => socket.destroy());",
    'server.listen({ path: endpoint, exclusive: true }, () => process.stdout.write("ready\\n"));',
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source, endpoint], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const onExit = (): void => reject(new Error("child socket owner exited before listening"));
    child.once("exit", onExit);
    child.stdout?.once("data", (chunk: Buffer) => {
      child.off("exit", onExit);
      if (chunk.toString("utf8").includes("ready")) resolve();
      else reject(new Error("child socket owner returned an unexpected readiness message"));
    });
  });
  return child;
}

describe("headless process-lifetime kernel owner", () => {
  it("reuses one Store-scoped listener lease within the process", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-headless-owner-")));
    const env = createRealEnv();
    cleanups.push(async () => env.fs.rm(root, { recursive: true, force: true }));
    if (!env.headlessLifetimeOwner) throw new Error("expected real lifetime owner capability");

    const first = await env.headlessLifetimeOwner.acquire(root);
    const second = await env.headlessLifetimeOwner.acquire(root);

    expect(second).toBe(first);
    expect(await first.isCurrent()).toBe(true);
  });

  it("lets distinct canonical Stores with the same legacy candidate port hold owners", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-headless-port-alias-")));
    const env = createRealEnv();
    cleanups.push(async () => env.fs.rm(root, { recursive: true, force: true }));
    if (!env.headlessLifetimeOwner) throw new Error("expected real lifetime owner capability");

    const candidates = new Map<number, string>();
    let collidingRoots: readonly [string, string] | undefined;
    for (let attempt = 0; attempt < 32_768; attempt += 1) {
      const candidate = join(root, `store-${attempt}`);
      const port = legacyHeadlessLifetimeOwnerPort(candidate);
      const previous = candidates.get(port);
      if (previous) {
        collidingRoots = [previous, candidate];
        break;
      }
      candidates.set(port, candidate);
    }
    if (!collidingRoots) throw new Error("unable to find a legacy candidate-port collision");
    for (const candidate of collidingRoots) mkdirSync(candidate);
    const firstRoot = realpathSync(collidingRoots[0]);
    const secondRoot = realpathSync(collidingRoots[1]);

    expect(firstRoot).not.toBe(secondRoot);
    expect(legacyHeadlessLifetimeOwnerPort(firstRoot)).toBe(
      legacyHeadlessLifetimeOwnerPort(secondRoot),
    );
    const [first, second] = await Promise.all([
      env.headlessLifetimeOwner.acquire(firstRoot),
      env.headlessLifetimeOwner.acquire(secondRoot),
    ]);

    await expect(first.isCurrent()).resolves.toBe(true);
    await expect(second.isCurrent()).resolves.toBe(true);
  });

  it("does not confuse an unrelated legacy-port listener with the Store owner", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-headless-collision-")));
    const env = createRealEnv();
    cleanups.push(async () => env.fs.rm(root, { recursive: true, force: true }));
    if (!env.headlessLifetimeOwner) throw new Error("expected real lifetime owner capability");

    let blocker: Server | undefined;
    let storeRoot: string | undefined;
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const candidate = join(root, `store-${attempt}`);
      const candidateBlocker = createServer((socket) => socket.destroy());
      if (await bindLoopback(candidateBlocker, legacyHeadlessLifetimeOwnerPort(candidate))) {
        blocker = candidateBlocker;
        storeRoot = candidate;
        break;
      }
    }
    if (!blocker || !storeRoot) throw new Error("unable to reserve a derived loopback port");
    blocker.unref();
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          blocker?.close((error) => (error ? reject(error) : resolve()));
        }),
    );

    const lease = await env.headlessLifetimeOwner.acquire(storeRoot);
    await expect(lease.isCurrent()).resolves.toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "fails closed for a regular file occupying the Unix owner endpoint",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-headless-file-")));
      const env = createRealEnv();
      const endpoint = headlessLifetimeOwnerEndpoint(root);
      cleanups.push(async () => env.fs.rm(root, { recursive: true, force: true }));
      cleanups.push(async () => nodeFs.rm(endpoint, { force: true }));
      await nodeFs.mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
      await nodeFs.writeFile(endpoint, "do-not-remove\n", "utf8");
      if (!env.headlessLifetimeOwner) throw new Error("expected real lifetime owner capability");

      await expect(env.headlessLifetimeOwner.acquire(root)).rejects.toThrow(
        /kernel resource is active or unavailable/i,
      );
      await expect(nodeFs.readFile(endpoint, "utf8")).resolves.toBe("do-not-remove\n");
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed for a symlink occupying the Unix owner endpoint",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-headless-symlink-")));
      const env = createRealEnv();
      const endpoint = headlessLifetimeOwnerEndpoint(root);
      const target = join(root, "must-remain.txt");
      cleanups.push(async () => env.fs.rm(root, { recursive: true, force: true }));
      cleanups.push(async () => nodeFs.rm(endpoint, { force: true }));
      await nodeFs.mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
      await nodeFs.writeFile(target, "preserved\n", "utf8");
      await nodeFs.symlink(target, endpoint);
      if (!env.headlessLifetimeOwner) throw new Error("expected real lifetime owner capability");

      await expect(env.headlessLifetimeOwner.acquire(root)).rejects.toThrow(
        /kernel resource is active or unavailable/i,
      );
      await expect(nodeFs.readFile(target, "utf8")).resolves.toBe("preserved\n");
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a live prior process and recovers its stale Unix socket after exit",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-headless-process-")));
      const env = createRealEnv();
      const endpoint = headlessLifetimeOwnerEndpoint(root);
      await nodeFs.mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
      const child = await startChildSocketOwner(endpoint);
      cleanups.push(async () => env.fs.rm(root, { recursive: true, force: true }));
      cleanups.push(async () => nodeFs.rm(endpoint, { force: true }));
      cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await once(child, "exit");
        }
      });
      if (!env.headlessLifetimeOwner) throw new Error("expected real lifetime owner capability");

      await expect(env.headlessLifetimeOwner.acquire(root)).rejects.toThrow(
        /kernel resource is active or unavailable/i,
      );
      child.kill("SIGKILL");
      await once(child, "exit");

      const lease = await env.headlessLifetimeOwner.acquire(root);
      await expect(lease.isCurrent()).resolves.toBe(true);
    },
  );
});
