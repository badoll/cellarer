import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealEnv, type Env, initializeStore } from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIENT_API_ROUTES, createClientOpenApiDocument } from "../src/api-contract.js";
import { createApp } from "../src/app.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

describe("Inventory local client API", () => {
  let root: string;
  let env: Env;
  let storeRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-inventory-api-")));
    storeRoot = join(root, "store");
    projectRoot = join(root, "project");
    const real = createRealEnv();
    env = {
      ...real,
      homedir: () => join(root, "home"),
      cwd: () => projectRoot,
      now: () => new Date("2026-08-25T08:00:00.000Z"),
      randomId: () => "inventory-request",
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
    await env.fs.mkdir(projectRoot, { recursive: true });
    await initializeStore(env, storeRoot);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("publishes authenticated full and targeted routes backed by one DTO", async () => {
    const app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
    const fullResponse = await app.request(
      `/api/v1/inventory?dir=${encodeURIComponent(projectRoot)}`,
    );
    const targetedResponse = await app.request(
      `/api/v1/inventory/codex?dir=${encodeURIComponent(projectRoot)}`,
    );
    const full = (await fullResponse.json()) as Record<string, unknown>;
    const targeted = (await targetedResponse.json()) as Record<string, unknown>;

    expect(fullResponse.status).toBe(200);
    expect(full).toMatchObject({
      status: "success",
      data: {
        completeness: "complete",
        counts: { ready: 1 },
        candidates: [{ name: "inventory-demo", state: "ready" }],
      },
    });
    expect(targetedResponse.status).toBe(200);
    expect(targeted.data).toMatchObject({
      completeness: "complete",
      candidates: [{ name: "inventory-demo", state: "ready" }],
    });
  });

  it("keeps route registry, OpenAPI, schemas, and authentication in parity", () => {
    expect(
      CLIENT_API_ROUTES.filter(({ operationId }) => operationId.startsWith("refreshInventory")),
    ).toMatchObject([
      {
        operationId: "refreshInventory",
        method: "get",
        path: "/api/v1/inventory",
        authentication: "authenticated",
      },
      {
        operationId: "refreshInventoryByAgent",
        method: "get",
        path: "/api/v1/inventory/{agentId}",
        authentication: "authenticated",
      },
    ]);
    const openApi = createClientOpenApiDocument() as {
      paths: Record<string, { get: { operationId: string; parameters: unknown[] } }>;
    };
    expect(openApi.paths["/api/v1/inventory"]?.get.operationId).toBe("refreshInventory");
    expect(openApi.paths["/api/v1/inventory/{agentId}"]?.get).toMatchObject({
      operationId: "refreshInventoryByAgent",
      parameters: expect.arrayContaining([
        expect.objectContaining({ in: "path", name: "agentId", required: true }),
      ]),
    });
  });

  it("rejects malformed targeted paths and empty project queries", async () => {
    const app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
    const malformedAgent = await app.request("/api/v1/inventory/not%2Can%2Cagent");
    const emptyDir = await app.request("/api/v1/inventory?dir=");

    expect(malformedAgent.status).toBe(400);
    expect(await malformedAgent.json()).toMatchObject({
      status: "error",
      error: { code: "INVALID_INPUT", details: { fields: ["agentId"] } },
    });
    expect(emptyDir.status).toBe(400);
    expect(await emptyDir.json()).toMatchObject({
      status: "error",
      error: { code: "INVALID_INPUT", details: { fields: ["dir"] } },
    });
  });

  it("requires authentication without turning Core partial results into transport errors", async () => {
    const unauthenticated = await createApp({
      env,
      storeRoot,
      auth: { mode: "bearer", token: "inventory-token" },
    }).request("/api/v1/inventory");
    expect(unauthenticated.status).toBe(401);

    await env.fs.mkdir(join(root, "home", ".codex"), { recursive: true });
    await env.fs.symlink(join(root, "outside-rules.md"), join(root, "home", ".codex", "AGENTS.md"));
    const response = await createApp({
      env,
      storeRoot,
      auth: { mode: "trusted-embedded" },
    }).request("/api/v1/inventory/codex");
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "success",
      data: {
        completeness: "partial",
        candidates: [{ name: "inventory-demo", state: "ready" }],
      },
    });
  });
});
