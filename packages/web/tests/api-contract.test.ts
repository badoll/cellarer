import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealEnv, type Env, initializeStore } from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIENT_API_ROUTES } from "../src/api-contract.js";
import { createApp } from "../src/app.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

describe("local client API contract", () => {
  let root: string;
  let env: Env;
  let storeRoot: string;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-api-v1-")));
    const real = createRealEnv();
    env = {
      ...real,
      homedir: () => join(root, "home"),
      cwd: () => join(root, "cwd"),
      platform: "darwin",
      now: () => new Date("2026-08-10T08:00:00.000Z"),
      env: {},
      mutationAuthority: deterministicMutationAuthority(),
    };
    storeRoot = join(root, "home", ".cellarer");
    await env.fs.mkdir(join(storeRoot, "store", "rules"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns the version discovery result in the stable envelope", async () => {
    const response = await createApp({
      env,
      storeRoot,
      auth: { mode: "trusted-embedded" },
    }).request("/api/v1/version", {
      headers: { "x-request-id": "req-http-contract-1" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      apiVersion: "1.0",
      requestId: "req-http-contract-1",
      status: "success",
      warnings: [],
      data: {
        apiVersion: "1.0",
        contractId: "cellarer-local-client-api-v1",
      },
    });
  });

  it("maps invalid transport input without returning raw exception text", async () => {
    const response = await createApp({
      env,
      storeRoot,
      auth: { mode: "trusted-embedded" },
    }).request("/api/v1/resources/not-a-kind", {
      headers: { "x-request-id": "req-http-contract-2" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      apiVersion: "1.0",
      requestId: "req-http-contract-2",
      status: "error",
      warnings: [],
      error: {
        code: "INVALID_INPUT",
        message: "Request input is invalid",
        details: { fields: ["kind"] },
      },
    });
  });

  it("maps malformed authenticated JSON to the documented INVALID_INPUT response", async () => {
    const response = await createApp({
      env,
      storeRoot,
      auth: { mode: "trusted-embedded" },
    }).request("/api/v1/diff", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-http-malformed-json",
      },
      body: "{not-json",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      apiVersion: "1.0",
      requestId: "req-http-malformed-json",
      status: "error",
      warnings: [],
      error: {
        code: "INVALID_INPUT",
        message: "Request input is invalid",
        details: { fields: ["body"] },
      },
    });
  });

  it.each([
    {
      name: "managed bearer",
      auth: { mode: "bearer", token: "managed-token" } as const,
      headers: { authorization: "Bearer managed-token" },
      expectedSecurity: [{ localManagedClientAuth: [] }],
    },
    {
      name: "bundled browser session",
      auth: { mode: "browser-session", sessionId: "browser-session-id" } as const,
      headers: { cookie: "cellarer_session=browser-session-id" },
      expectedSecurity: [{ localBrowserSession: [] }],
    },
  ])("publishes the active $name authentication requirement", async ({
    auth,
    headers,
    expectedSecurity,
  }) => {
    const response = await createApp({ env, storeRoot, auth }).request("/api/v1/openapi.json", {
      headers,
    });
    const body = (await response.json()) as {
      readonly data: {
        readonly paths: {
          readonly "/api/v1/version": {
            readonly get: { readonly security: readonly Readonly<Record<string, readonly []>>[] };
          };
        };
        readonly components: {
          readonly securitySchemes: Readonly<Record<string, unknown>>;
          readonly schemas: {
            readonly MutationPlan: {
              readonly properties: Readonly<Record<string, unknown>>;
            };
          };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(body.data.paths["/api/v1/version"].get.security).toEqual(expectedSecurity);
    expect(body.data.components.securitySchemes).toEqual({
      localManagedClientAuth: { type: "http", scheme: "bearer" },
      localBrowserSession: { type: "apiKey", in: "cookie", name: "cellarer_session" },
    });
    expect(body.data.components.schemas.MutationPlan.properties.authorization).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });

  it("publishes the implemented OpenAPI contract through the versioned envelope", async () => {
    const response = await createApp({
      env,
      storeRoot,
      auth: { mode: "trusted-embedded" },
    }).request("/api/v1/openapi.json", {
      headers: { "x-request-id": "req-http-contract-3" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      apiVersion: "1.0",
      requestId: "req-http-contract-3",
      status: "success",
      data: {
        openapi: "3.1.0",
        paths: {
          "/api/v1/version": { get: { operationId: "getVersion" } },
          "/api/v1/openapi.json": { get: { operationId: "getOpenApi" } },
          "/api/v1/scan/plan": { post: { operationId: "planScanMutation" } },
          "/api/v1/revert/apply": { post: { operationId: "applyRevertMutation" } },
          "/api/v1/resources/rename/plan": {
            post: { operationId: "planResourceRename" },
          },
          "/api/v1/profiles/{id}/uninstall/apply": {
            post: { operationId: "applySyncProfileUninstall" },
          },
        },
      },
    });
  });

  it("publishes a closed post-commit Inventory union for control-plane mutation apply", () => {
    const applyRoute = CLIENT_API_ROUTES.find(
      ({ operationId }) => operationId === "applyControlPlaneMutation",
    );
    const refresh =
      applyRoute?.outputSchema.oneOf?.[0]?.properties?.data?.properties?.postCommitInventoryRefresh;

    expect(refresh?.oneOf).toHaveLength(3);
    expect(refresh?.oneOf?.map((variant) => variant.additionalProperties)).toEqual([
      false,
      false,
      false,
    ]);
    expect(refresh?.oneOf?.map((variant) => variant.properties?.status?.const)).toEqual([
      "complete",
      "partial",
      "failed",
    ]);
    expect(
      refresh?.oneOf?.map((variant) => variant.properties?.inventory?.properties?.completeness),
    ).toEqual([{ const: "complete" }, { const: "partial" }, { const: "failed" }]);
    expect(refresh?.oneOf?.slice(1).map((variant) => variant.properties?.retryCommand)).toEqual([
      expect.objectContaining({
        type: "string",
        pattern: expect.stringMatching(/^\^cellarer inventory refresh --agent /),
      }),
      expect.objectContaining({
        type: "string",
        pattern: expect.stringMatching(/^\^cellarer inventory refresh --agent /),
      }),
    ]);
  });

  it("returns a fixed internal error instead of the thrown diagnostic", async () => {
    const fsWithFailure: Env["fs"] = {
      ...env.fs,
      readdir: async () => {
        throw new Error("canary-internal-diagnostic");
      },
    };
    const response = await createApp({
      env: { ...env, fs: fsWithFailure },
      storeRoot,
      auth: { mode: "trusted-embedded" },
    }).request("/api/v1/resources/rules", { headers: { "x-request-id": "req-http-contract-4" } });
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("canary-internal-diagnostic");
    expect(JSON.parse(text)).toEqual({
      apiVersion: "1.0",
      requestId: "req-http-contract-4",
      status: "error",
      warnings: [],
      error: { code: "INTERNAL_ERROR", message: "Unexpected internal failure" },
    });
  });

  it("runs the final serialized-response guard on versioned success envelopes", async () => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const guardedEnv: Env = { ...env, randomId: () => canary };
    const response = await createApp({
      env: guardedEnv,
      storeRoot,
      auth: { mode: "trusted-embedded" },
    }).request("/api/v1/version");
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain(canary);
    expect(text).toContain("[REDACTED]");
  });

  it("treats the active low-entropy authentication credential as a known secret", async () => {
    const token = "managed-test-token";
    const guardedEnv: Env = { ...env, randomId: () => token };
    const response = await createApp({
      env: guardedEnv,
      storeRoot,
      auth: { mode: "bearer", token },
    }).request("/api/v1/version", {
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain(token);
    expect(text).toContain("[REDACTED]");
  });

  it("separates public liveness from authenticated operational readiness", async () => {
    const app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
    const health = await app.request("/api/v1/health", {
      headers: { "x-request-id": "req-http-health" },
    });
    const readiness = await app.request("/api/v1/readiness", {
      headers: { "x-request-id": "req-http-readiness" },
    });

    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: "success",
      data: { live: true },
    });
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toMatchObject({
      status: "success",
      data: {
        ready: false,
        blockers: expect.arrayContaining([expect.objectContaining({ code: "STORE_NOT_READY" })]),
      },
    });
  });

  it("discovers capabilities and returns read DTOs in the same envelope", async () => {
    await env.fs.writeFile(join(storeRoot, "store", "rules", "style.md"), "# style");
    const app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
    const capabilities = await app.request("/api/v1/capabilities", {
      headers: { "x-request-id": "req-http-capabilities" },
    });
    const resources = await app.request("/api/v1/resources?includeDiscovered=false", {
      headers: { "x-request-id": "req-http-resources" },
    });

    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toMatchObject({
      status: "success",
      data: {
        operations: expect.arrayContaining([
          "getVersion",
          "listResources",
          "planScanMutation",
          "applyRevertMutation",
          "planResourceRename",
          "applySyncProfileUninstall",
        ]),
      },
    });
    expect(resources.status).toBe(200);
    expect(await resources.json()).toMatchObject({
      status: "success",
      data: {
        resources: [expect.objectContaining({ id: "rules/style", kind: "rules" })],
      },
    });
  });

  it("applies only the exact authority-sealed control-plane plan", async () => {
    await initializeStore(env, storeRoot);
    const app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
    const plannedResponse = await app.request("/api/v1/collections/plan", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-plan-collection" },
      body: JSON.stringify({
        action: "create",
        collectionName: "phase-four",
        description: "versioned client",
        resourceIds: [],
      }),
    });
    expect(plannedResponse.status).toBe(200);
    const planned = (await plannedResponse.json()) as {
      data: { plan: Record<string, unknown> };
    };

    const tampered = structuredClone(planned.data.plan);
    tampered.planId = "plan-forged";
    const rejected = await app.request("/api/v1/mutations/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationPlan: tampered }),
    });
    expect(rejected.status).toBe(400);

    const applied = await app.request("/api/v1/mutations/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationPlan: planned.data.plan }),
    });
    expect(applied.status, await applied.clone().text()).toBe(200);
    expect(await applied.json()).toMatchObject({
      status: "success",
      data: { operation: { ok: true } },
    });

    const collections = await app.request("/api/v1/collections");
    expect(await collections.json()).toMatchObject({
      data: {
        collections: expect.arrayContaining([expect.objectContaining({ name: "phase-four" })]),
      },
    });
  });

  it("plans agent mutations and applies only the returned immutable plan", async () => {
    await initializeStore(env, storeRoot);
    const app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
    const plannedResponse = await app.request("/api/v1/agents/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "set-enabled", agentId: "codex", enabled: false }),
    });
    expect(plannedResponse.status, await plannedResponse.clone().text()).toBe(200);
    const planned = (await plannedResponse.json()) as {
      data: { plan: Record<string, unknown> };
    };

    const applied = await app.request("/api/v1/mutations/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationPlan: planned.data.plan }),
    });
    expect(applied.status, await applied.clone().text()).toBe(200);
    expect(await applied.json()).toMatchObject({ data: { operation: { ok: true } } });

    const agent = await app.request("/api/v1/agents/codex");
    expect(await agent.json()).toMatchObject({ data: { agent: { enabled: false } } });
  });

  it("persists a sync profile through the exact versioned profile plan", async () => {
    await initializeStore(env, storeRoot);
    await env.fs.writeFile(join(storeRoot, "store", "rules", "style.md"), "# style");
    const app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
    const plannedResponse = await app.request("/api/v1/profiles/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "create",
        profileId: "daily",
        desired: {
          agentIds: ["codex"],
          scope: "global",
          resourceIds: ["rules/style"],
          collectionIds: [],
          capabilities: ["rules"],
          method: "copy",
          mergePolicy: "merge",
        },
      }),
    });
    expect(plannedResponse.status, await plannedResponse.clone().text()).toBe(200);
    const planned = (await plannedResponse.json()) as { data: { plan: Record<string, unknown> } };
    const applied = await app.request("/api/v1/profiles/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationPlan: planned.data.plan }),
    });
    expect(applied.status, await applied.clone().text()).toBe(200);
    expect(await applied.json()).toMatchObject({ data: { operation: { ok: true } } });

    const shown = await app.request("/api/v1/profiles/daily");
    expect(await shown.json()).toMatchObject({ data: { profile: { profileId: "daily" } } });
  });

  it("applies the exact previewed sync plan without transport replanning", async () => {
    await initializeStore(env, storeRoot);
    await env.fs.writeFile(join(storeRoot, "store", "rules", "style.md"), "# shared style");
    const app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
    const plannedResponse = await app.request("/api/v1/sync/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        destination: "user",
        resources: { kinds: ["rules"] },
      }),
    });
    expect(plannedResponse.status, await plannedResponse.clone().text()).toBe(200);
    const planned = (await plannedResponse.json()) as {
      data: { mutationPlan: Record<string, unknown> };
    };

    const applied = await app.request("/api/v1/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationPlan: planned.data.mutationPlan }),
    });
    expect(applied.status, await applied.clone().text()).toBe(200);
    expect(await applied.json()).toMatchObject({
      status: "success",
      data: { operation: { ok: true } },
    });
    expect(await env.fs.readFile(join(root, "home", ".claude", "CLAUDE.md"))).toContain(
      "# shared style",
    );
  });
});
