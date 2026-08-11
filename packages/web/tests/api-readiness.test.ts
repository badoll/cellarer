import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRealEnv,
  type Env,
  getClientReadiness,
  initializeStore,
  mutationLockPath,
  recoveryLockPath,
} from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

describe("local client operational readiness", () => {
  let root: string;
  let storeRoot: string;
  let env: Env;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-api-readiness-")));
    storeRoot = join(root, "home", ".cellarer");
    const real = createRealEnv();
    env = {
      ...real,
      homedir: () => join(root, "home"),
      cwd: () => join(root, "cwd"),
      now: () => new Date("2026-08-10T13:00:00.000Z"),
      mutationAuthority: deterministicMutationAuthority(),
    };
    await initializeStore(env, storeRoot);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports ready only when initialization, authority, locks, and recovery are clear", async () => {
    await expect(getClientReadiness(env, storeRoot)).resolves.toEqual({
      ready: true,
      blockers: [],
    });
    const response = await readiness(env);

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "success",
      data: { ready: true, blockers: [] },
    });
  });

  it("distinguishes unavailable and stale mutation authority without provider details", async () => {
    const { mutationAuthority: _authority, ...withoutAuthority } = env;
    const unavailable = await readiness(withoutAuthority);
    const stale = await readiness({
      ...env,
      mutationAuthority: deterministicMutationAuthority({ isCurrent: async () => false }),
    });

    expect(unavailable.status, await unavailable.clone().text()).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      data: {
        ready: false,
        blockers: [{ code: "MUTATION_AUTHORITY_UNAVAILABLE" }],
      },
    });
    expect(stale.status).toBe(503);
    expect(await stale.json()).toMatchObject({
      data: {
        ready: false,
        blockers: [{ code: "MUTATION_AUTHORITY_NOT_CURRENT" }],
      },
    });
  });

  it("reports a normal mutation lock separately from recovery", async () => {
    await writeLock(mutationLockPath(storeRoot), "operation-active");
    const response = await readiness(env);
    const text = await response.text();

    expect(response.status, text).toBe(503);
    expect(JSON.parse(text)).toMatchObject({
      data: {
        ready: false,
        blockers: [{ code: "MUTATION_LOCKED", operationId: "operation-active" }],
      },
    });
    expect(text).not.toContain(storeRoot);
    expect(text).not.toContain("test-host");
    expect(text).not.toContain("4242");
  });

  it("reports an outstanding recovery claim as a recovery blocker", async () => {
    await writeLock(recoveryLockPath(storeRoot), "operation-recovery");
    const response = await readiness(env);

    expect(response.status, await response.clone().text()).toBe(503);
    expect(await response.json()).toMatchObject({
      data: {
        ready: false,
        blockers: [{ code: "RECOVERY_REQUIRED", operationId: "operation-recovery" }],
      },
    });
  });

  async function readiness(readinessEnv: Env): Promise<Response> {
    return createApp({
      env: readinessEnv,
      storeRoot,
      auth: { mode: "trusted-embedded" },
    }).request("/api/v1/readiness", {
      headers: { "x-request-id": "req-readiness" },
    });
  }

  async function writeLock(path: string, operationId: string): Promise<void> {
    await env.fs.writeFile(
      path,
      `${JSON.stringify({
        operationId,
        processId: 4242,
        hostname: "test-host",
        acquiredAt: "2026-08-10T12:59:00.000Z",
      })}\n`,
    );
  }
});
