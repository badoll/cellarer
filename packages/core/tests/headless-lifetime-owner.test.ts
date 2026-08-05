import { mkdtempSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRealEnv, headlessLifetimeOwnerPort } from "../src/real-env.js";

const cleanups: Array<() => Promise<void>> = [];

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

  it("fails closed when an unrelated local listener occupies the derived port", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-headless-collision-")));
    const env = createRealEnv();
    cleanups.push(async () => env.fs.rm(root, { recursive: true, force: true }));
    if (!env.headlessLifetimeOwner) throw new Error("expected real lifetime owner capability");

    let blocker: Server | undefined;
    let storeRoot: string | undefined;
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const candidate = join(root, `store-${attempt}`);
      const candidateBlocker = createServer((socket) => socket.destroy());
      if (await bindLoopback(candidateBlocker, headlessLifetimeOwnerPort(candidate))) {
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

    await expect(env.headlessLifetimeOwner.acquire(storeRoot)).rejects.toThrow(
      /kernel resource is active or unavailable/i,
    );
  });
});
