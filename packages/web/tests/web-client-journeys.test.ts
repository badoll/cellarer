import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealEnv, type Env, type MutationPlan, recoveryLockPath } from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initStore, writeRuleArtifact } from "../../core/src/store/store.js";
import { createApp } from "../src/app.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

describe("bundled Web client end-to-end journeys", () => {
  let root: string;
  let storeRoot: string;
  let workspaceRoot: string;
  let env: Env;

  beforeEach(async () => {
    vi.resetModules();
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-web-client-journey-")));
    storeRoot = join(root, "home", ".cellarer");
    workspaceRoot = join(root, "workspace");
    const real = createRealEnv();
    env = {
      ...real,
      homedir: () => join(root, "home"),
      cwd: () => workspaceRoot,
      now: () => new Date("2026-08-10T16:00:00.000Z"),
      mutationAuthority: deterministicMutationAuthority(),
    };
    await fs.mkdir(workspaceRoot, { recursive: true });
    await initStore(env, storeRoot);
    await writeRuleArtifact(env, storeRoot, "style", "# Shared style\n");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reads, applies, verifies, reverts, renders recovery, and reauthenticates after restart", async () => {
    let app = createApp({
      env,
      storeRoot,
      auth: { mode: "browser-session", sessionId: "session-before-restart" },
    });
    let cookie = "";
    let bootstrapCount = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = clientPath(input);
      const headers = new Headers(init.headers);
      headers.set("host", "127.0.0.1:4317");
      if (cookie) headers.set("cookie", cookie);
      const method = init.method?.toUpperCase() ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        headers.set("origin", "http://127.0.0.1:4317");
        headers.set("sec-fetch-site", "same-origin");
      }
      const response = await app.request(path, { ...init, method, headers });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) {
        cookie = setCookie.split(";", 1)[0] ?? "";
        bootstrapCount += path === "/api/v1/auth/session" ? 1 : 0;
      }
      return response;
    });
    const [{ apiFetch }, { readApiJson }] = await Promise.all([
      import("../client/api.js"),
      import("../client/api-state.js"),
    ]);

    const inventory = await readApiJson<{ resources: readonly { id: string }[] }>(
      await apiFetch("/api/v1/resources?includeDiscovered=false"),
    );
    expect(inventory.resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "rules/style" })]),
    );

    const planned = await postData<{
      readonly mutationPlan: MutationPlan;
    }>(apiFetch, readApiJson, "/api/v1/sync/plan", {
      agents: ["codex"],
      destination: "project",
      dir: workspaceRoot,
      resources: { kinds: ["rules"] },
      method: "copy",
    });
    const applied = await postData<{
      readonly operation: { readonly ok: boolean; readonly receipt?: { readonly planId: string } };
    }>(apiFetch, readApiJson, "/api/v1/sync/apply", {
      mutationPlan: planned.mutationPlan,
    });
    expect(applied.operation).toMatchObject({
      ok: true,
      receipt: { planId: planned.mutationPlan.planId },
    });

    const verified = await postData<{ readonly healthy: boolean; readonly storeRevision: number }>(
      apiFetch,
      readApiJson,
      "/api/v1/verify",
      { agents: ["codex"], scope: "project", dir: workspaceRoot, capabilities: ["rules"] },
    );
    expect(verified).toMatchObject({ healthy: true, storeRevision: expect.any(Number) });

    const revertPlan = await postData<{ readonly mutationPlan: MutationPlan }>(
      apiFetch,
      readApiJson,
      "/api/v1/revert/plan",
      { agents: ["codex"], scope: "project", dir: workspaceRoot },
    );
    const reverted = await postData<{ readonly operation: { readonly ok: boolean } }>(
      apiFetch,
      readApiJson,
      "/api/v1/revert/apply",
      {
        agents: ["codex"],
        scope: "project",
        dir: workspaceRoot,
        mutationPlan: revertPlan.mutationPlan,
      },
    );
    expect(reverted.operation.ok).toBe(true);

    await env.fs.writeFile(
      recoveryLockPath(storeRoot),
      `${JSON.stringify({
        operationId: "operation-web-recovery",
        processId: 4242,
        hostname: "web-test-host",
        acquiredAt: "2026-08-10T15:59:00.000Z",
      })}\n`,
    );
    const readiness = await readApiJson<{
      readonly ready: boolean;
      readonly blockers: readonly { readonly code: string }[];
    }>(await apiFetch("/api/v1/readiness"));
    expect(readiness).toMatchObject({
      ready: false,
      blockers: [{ code: "RECOVERY_REQUIRED" }],
    });
    await env.fs.rm(recoveryLockPath(storeRoot), { force: true });

    const cookieBeforeRestart = cookie;
    app = createApp({
      env,
      storeRoot,
      auth: { mode: "browser-session", sessionId: "session-after-restart" },
    });
    const summary = await readApiJson<Record<string, unknown>>(await apiFetch("/api/v1/summary"));

    expect(summary).toBeDefined();
    expect(cookie).not.toBe(cookieBeforeRestart);
    expect(bootstrapCount).toBe(2);
  });
});

async function postData<T>(
  apiFetch: (path: `/api/v1/${string}`, init?: RequestInit) => Promise<Response>,
  readApiJson: <TData>(response: Response) => Promise<TData>,
  path: `/api/v1/${string}`,
  body: unknown,
): Promise<T> {
  return readApiJson<T>(
    await apiFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function clientPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return `${input.pathname}${input.search}`;
  const url = new URL(input.url);
  return `${url.pathname}${url.search}`;
}
