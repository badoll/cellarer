import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealEnv, type Env, initializeStore } from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIENT_API_ROUTES, createClientOpenApiDocument } from "../src/api-contract.js";
import { createApp } from "../src/app.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

describe("Inventory Store import local client API", () => {
  let root: string;
  let env: Env;
  let storeRoot: string;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-inventory-import-api-")));
    storeRoot = join(root, "store");
    const real = createRealEnv();
    env = {
      ...real,
      homedir: () => join(root, "home"),
      cwd: () => root,
      now: () => new Date("2026-08-25T08:00:00.000Z"),
      randomId: (() => {
        let sequence = 0;
        return () => `inventory-import-request-${++sequence}`;
      })(),
      mutationAuthority: deterministicMutationAuthority(),
    };
    await env.fs.mkdir(join(root, "home", ".agents", "skills", "inventory-demo"), {
      recursive: true,
    });
    await env.fs.writeFile(
      join(root, "home", ".agents", "skills", "inventory-demo", "SKILL.md"),
      "---\nname: inventory-demo\ndescription: inventory fixture\n---\n",
      "utf8",
    );
    await initializeStore(env, storeRoot);
  });

  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  it("preserves UTF-8 BOM bytes through Skill plan and apply transport", async () => {
    const skillRoot = join(root, "home", ".agents", "skills", "inventory-demo");
    const bytes = Buffer.from("\uFEFF# Reviewed asset\n", "utf8");
    await env.fs.writeFileBytes(join(skillRoot, "asset.md"), bytes);
    const app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
    const inventory = await app.request("/api/v1/inventory/codex");
    const inventoryBody = (await inventory.json()) as { data: { candidates: { id: string }[] } };
    const candidateId = inventoryBody.data.candidates[0]?.id;
    if (!candidateId) throw new Error("missing Inventory candidate");
    const response = await app.request("/api/v1/inventory/import/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidateIds: [candidateId], agentId: "codex" }),
    });
    expect(response.status).toBe(200);
    const planned = (await response.json()) as { data: { mutationPlan: unknown } };
    const applied = await app.request("/api/v1/inventory/import/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationPlan: planned.data.mutationPlan }),
    });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      status: "success",
      data: { operation: { ok: true } },
    });
    expect(
      await env.fs.readFileBytes(join(storeRoot, "store", "skills", "inventory-demo", "asset.md")),
    ).toEqual(bytes);
    expect(await env.fs.readFileBytes(join(skillRoot, "asset.md"))).toEqual(bytes);
  });

  it("reviews and applies a binary Skill above 1 MiB through a replacement app", async () => {
    const skillRoot = join(root, "home", ".agents", "skills", "inventory-demo");
    const bytes = Buffer.alloc(900_000, 0xff);
    await env.fs.writeFileBytes(join(skillRoot, "asset.bin"), bytes);
    const app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
    const inventory = await app.request("/api/v1/inventory/codex");
    const inventoryBody = (await inventory.json()) as { data: { candidates: { id: string }[] } };
    const candidateId = inventoryBody.data.candidates[0]?.id;
    if (!candidateId) throw new Error("missing Inventory candidate");
    const response = await app.request("/api/v1/inventory/import/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidateIds: [candidateId], agentId: "codex" }),
    });
    const planned = (await response.json()) as { data: { mutationPlan: unknown } };
    expect(response.status, JSON.stringify(planned)).toBe(200);
    const body = JSON.stringify({ mutationPlan: planned.data.mutationPlan });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(1024 * 1024);
    const replacementApp = createApp({
      env: { ...env, processId: () => env.processId() + 1 },
      storeRoot,
      auth: { mode: "trusted-embedded" },
    });
    const applied = await replacementApp.request("/api/v1/inventory/import/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      status: "success",
      data: { resourceIds: ["skills/inventory-demo"], operation: { ok: true } },
    });
    expect(
      await env.fs.readFileBytes(join(storeRoot, "store", "skills", "inventory-demo", "asset.bin")),
    ).toEqual(bytes);
    expect(await env.fs.readFileBytes(join(skillRoot, "asset.bin"))).toEqual(bytes);
  }, 15_000);

  it("rejects over-budget bodies before observing Core and keeps other routes at 1 MiB", async () => {
    let observations = 0;
    const protectedEnv: Env = {
      ...env,
      fs: {
        ...env.fs,
        lstat: async () => {
          observations += 1;
          throw new Error("Core must not observe an over-budget request");
        },
      },
    };
    const app = createApp({ env: protectedEnv, storeRoot, auth: { mode: "trusted-embedded" } });
    for (const [path, maxBytes] of [
      ["/api/v1/inventory/import/apply", 64 * 1024 * 1024],
      ["/api/v1/inventory/import/plan", 1024 * 1024],
      ["/api/v1/mutations/apply", 1024 * 1024],
    ] as const) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(maxBytes + 1) },
        body: "{}",
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        status: "error",
        error: { code: "DOMAIN_VALIDATION_FAILED", details: { maxBytes } },
      });
    }
    expect(observations).toBe(0);
  });

  it("plans exact candidate IDs and applies only the unchanged receipt", async () => {
    const forbiddenCalls: string[] = [];
    const guardedEnv: Env = {
      ...env,
      fs: {
        ...env.fs,
        publishFileAtomically: async (path, data, options) => {
          if (path.startsWith(join(root, "home", ".codex"))) {
            forbiddenCalls.push(`target:${path}`);
          }
          return env.fs.publishFileAtomically(path, data, options);
        },
      },
      secretStore: {
        get: async () => {
          forbiddenCalls.push("provider:get");
          throw new Error("provider capability reached the handler");
        },
        set: async () => {
          forbiddenCalls.push("provider:set");
          throw new Error("provider capability reached the handler");
        },
        delete: async () => {
          forbiddenCalls.push("provider:delete");
          throw new Error("provider capability reached the handler");
        },
      },
    };
    const app = createApp({ env: guardedEnv, storeRoot, auth: { mode: "trusted-embedded" } });
    const inventory = await app.request("/api/v1/inventory/codex");
    const inventoryBody = (await inventory.json()) as {
      data: { candidates: readonly { id: string }[] };
    };
    const candidateId = inventoryBody.data.candidates[0]?.id;
    if (!candidateId) throw new Error("missing Inventory candidate");

    const planResponse = await app.request("/api/v1/inventory/import/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidateIds: [candidateId], agentId: "codex" }),
    });
    const planned = (await planResponse.json()) as { data: { mutationPlan: unknown } };
    expect(planResponse.status).toBe(200);
    expect(planned).toMatchObject({
      data: { candidateIds: [candidateId], mutationPlan: { operation: "store-import" } },
    });

    const applyResponse = await app.request("/api/v1/inventory/import/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationPlan: planned.data.mutationPlan }),
    });
    expect(applyResponse.status).toBe(200);
    expect(await applyResponse.json()).toMatchObject({
      status: "success",
      data: {
        resourceIds: ["skills/inventory-demo"],
        operation: { ok: true, receipt: { outcome: "committed" } },
      },
    });
    expect(forbiddenCalls).toEqual([]);
  });

  it("publishes closed mutation routes and schemas", () => {
    expect(
      CLIENT_API_ROUTES.filter(({ operationId }) => operationId.includes("InventoryStoreImport")),
    ).toMatchObject([
      {
        operationId: "planInventoryStoreImport",
        method: "post",
        path: "/api/v1/inventory/import/plan",
        authentication: "mutation",
      },
      {
        operationId: "applyInventoryStoreImport",
        method: "post",
        path: "/api/v1/inventory/import/apply",
        authentication: "mutation",
      },
    ]);
    const openApi = createClientOpenApiDocument() as {
      paths: Record<string, { post?: { operationId: string; requestBody: unknown } }>;
    };
    expect(openApi.paths["/api/v1/inventory/import/plan"]?.post).toMatchObject({
      operationId: "planInventoryStoreImport",
      requestBody: expect.any(Object),
    });
    expect(openApi.paths["/api/v1/inventory/import/apply"]?.post).toMatchObject({
      operationId: "applyInventoryStoreImport",
      requestBody: expect.any(Object),
    });
  });
});
