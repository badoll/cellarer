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
      resolutionContext: "project",
      coverage: expect.arrayContaining([
        expect.objectContaining({ adapterId: "codex", dimension: "plugins", status: "excluded" }),
      ]),
      effectiveResources: expect.arrayContaining([
        expect.objectContaining({ adapterId: "codex", state: "unknown" }),
      ]),
      candidates: [{ name: "inventory-demo", state: "ready" }],
    });
  });

  it("streams redacted progress before the same authoritative result", async () => {
    const app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
    const streamResponse = await app.request(
      `/api/v1/inventory/stream?agentId=codex&dir=${encodeURIComponent(projectRoot)}`,
    );
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("content-type")).toContain("application/x-ndjson");
    const events = (await streamResponse.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const finalResponse = await app.request(
      `/api/v1/inventory/codex?dir=${encodeURIComponent(projectRoot)}`,
    );
    const final = (await finalResponse.json()) as { data: unknown };
    expect(events[0]).toMatchObject({ type: "started", attempt: 1, sequence: 1 });
    expect(
      events.some(
        (event) =>
          event.type === "progress" &&
          Array.isArray(event.candidates) &&
          event.candidates.length > 0,
      ),
    ).toBe(true);
    expect(events.filter((event) => event.type === "progress")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidates: expect.arrayContaining([
            expect.objectContaining({
              sources: expect.arrayContaining([
                expect.objectContaining({ location: "~/.agents/skills/inventory-demo" }),
              ]),
            }),
          ]),
        }),
      ]),
    );
    expect(events.at(-1)).toMatchObject({ type: "completed", result: final.data });
    const preview = JSON.stringify(events.slice(0, -1));
    expect(preview).not.toContain(root);
    expect(preview).not.toContain("inventory fixture");
    expect(preview).not.toContain("defaultSelected");
    expect(preview).not.toContain("provider");
  });

  it("keeps a typed failed final result when the Store snapshot is unsafe", async () => {
    await env.fs.writeFile(join(root, "outside-config.json"), '{"secret":"never expose"}');
    await env.fs.rm(join(storeRoot, "config.json"));
    await env.fs.symlink(join(root, "outside-config.json"), join(storeRoot, "config.json"));
    const response = await createApp({
      env,
      storeRoot,
      auth: { mode: "trusted-embedded" },
    }).request("/api/v1/inventory/stream");
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toMatchObject([
      { type: "started", attempt: 1, sequence: 1 },
      {
        type: "completed",
        result: { completeness: "failed", findings: [{ code: "STORE_SNAPSHOT_UNSAFE" }] },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("never expose");
  });

  it("does not access the secret provider while streaming progress", async () => {
    const forbidden = () => {
      throw new Error("secret provider was accessed");
    };
    const isolated: Env = {
      ...env,
      secretStore: { get: forbidden, set: forbidden, delete: forbidden },
    };
    const response = await createApp({
      env: isolated,
      storeRoot,
      auth: { mode: "trusted-embedded" },
    }).request("/api/v1/inventory/stream");
    const text = await response.text();
    expect(text).toContain('"type":"progress"');
    expect(text).toContain('"type":"completed"');
    expect(text).not.toContain("secret provider was accessed");
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
    expect(openApi.paths["/api/v1/inventory/stream"]?.get).toMatchObject({
      operationId: "streamInventory",
      parameters: expect.arrayContaining([
        expect.objectContaining({ in: "query", name: "agentId" }),
      ]),
      responses: { "200": { content: { "application/x-ndjson": expect.any(Object) } } },
    });
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
    const unauthenticatedStream = await createApp({
      env,
      storeRoot,
      auth: { mode: "bearer", token: "inventory-token" },
    }).request("/api/v1/inventory/stream");
    expect(unauthenticatedStream.status).toBe(401);

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
