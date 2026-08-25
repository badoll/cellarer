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
    await env.fs.mkdir(join(root, "home", ".codex", "skills", "inventory-demo"), {
      recursive: true,
    });
    await env.fs.writeFile(
      join(root, "home", ".codex", "skills", "inventory-demo", "SKILL.md"),
      "---\nname: inventory-demo\ndescription: inventory fixture\n---\n",
      "utf8",
    );
    await initializeStore(env, storeRoot, { agentTargets: ["codex"] });
  });

  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

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
