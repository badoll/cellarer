import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LockOwnerEvidence } from "../src/protocol/models.js";
import {
  acquireStoreMutationLock,
  mutationLockPath,
  type StoreMutationLock,
} from "../src/protocol/mutation-lock.js";
import { makeTmpEnv, type TmpEnv } from "./helpers/env.js";

function owner(operationId: string, acquiredAt = "2026-07-28T10:00:00.000Z"): LockOwnerEvidence {
  return { operationId, processId: 1234, hostname: "test-host", acquiredAt };
}

async function runChild(storeRoot: string, evidence: LockOwnerEvidence): Promise<unknown> {
  const realEnvUrl = pathToFileURL(new URL("../src/real-env.ts", import.meta.url).pathname).href;
  const lockUrl = pathToFileURL(
    new URL("../src/protocol/mutation-lock.ts", import.meta.url).pathname,
  ).href;
  const script = `
    const [{ createRealEnv }, { acquireStoreMutationLock }] = await Promise.all([
      import(process.argv[1]), import(process.argv[2])
    ]);
    const result = await acquireStoreMutationLock(
      createRealEnv(), process.argv[3], JSON.parse(process.argv[4])
    );
    if (result.ok) await result.lock.release();
    process.stdout.write(JSON.stringify(result.ok ? { ok: true } : result));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        script,
        realEnvUrl,
        lockUrl,
        storeRoot,
        JSON.stringify(evidence),
      ],
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

  beforeEach(() => {
    t = makeTmpEnv();
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
