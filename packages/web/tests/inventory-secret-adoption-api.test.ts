import type {
  AppliedInventorySecretAdoption,
  Env,
  PlannedInventorySecretAdoption,
} from "@cellarer/core";
import { createRealEnv } from "@cellarer/core";
import { describe, expect, it, vi } from "vitest";
import { CLIENT_API_ROUTES, createClientOpenApiDocument } from "../src/api-contract.js";
import { bindInventorySecretAdoptionService, createApp } from "../src/app.js";

describe("Inventory secret-adoption local API", () => {
  it("keeps the narrow planning service available without an apply provider capability", () => {
    const env = createRealEnv();
    expect(env.inventorySecretAdoptionProvider).toBeUndefined();
    expect(() => bindInventorySecretAdoptionService(env, "/unused")).not.toThrow();
  });

  it("exposes authenticated exact routes backed only by the narrow service", async () => {
    const canary = "web-known-value-canary";
    const plan = vi.fn(async () => ({
      candidateId: "candidate",
      targetName: "mcp-demo-environment-api-token-deadbeef",
      mutationPlan: { planId: "adoption-plan" },
    })) as unknown as (input: unknown) => Promise<PlannedInventorySecretAdoption>;
    const apply = vi.fn(async () => ({
      status: "applied",
      operation: { ok: true },
    })) as unknown as (plan: unknown) => Promise<AppliedInventorySecretAdoption>;
    const forbidden = vi.fn(async () => {
      throw new Error(canary);
    });
    const env: Env = {
      ...createRealEnv(),
      secretStore: { get: forbidden, set: forbidden, delete: forbidden },
      inventorySecretAdoptionProvider: {
        createExactAbsentReference: forbidden,
      },
    };
    const app = createApp({
      env,
      storeRoot: "/unused",
      auth: { mode: "trusted-embedded" },
      inventorySecretAdoption: { plan, apply },
    });
    const request = {
      candidateId: "candidate",
      selector: { kind: "environment", server: "demo", name: "API_TOKEN" },
      provider: "vault",
    };

    const planned = await app.request("/api/v1/inventory/adoption/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(planned.status).toBe(200);
    expect(plan).toHaveBeenCalledOnce();
    expect(forbidden).not.toHaveBeenCalled();
    expect(await planned.text()).not.toContain(canary);

    const rejected = await app.request("/api/v1/inventory/adoption/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, value: canary }),
    });
    expect(rejected.status).toBe(400);
    expect(plan).toHaveBeenCalledOnce();

    const applied = await app.request("/api/v1/inventory/adoption/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationPlan: { planId: "adoption-plan" } }),
    });
    expect(applied.status).toBe(200);
    expect(apply).toHaveBeenCalledOnce();
    expect(forbidden).not.toHaveBeenCalled();
    expect(await applied.text()).not.toContain(canary);
  });

  it("returns typed orphan evidence through the declared adoption result schema", async () => {
    const orphan = {
      status: "provider-created-store-unpublished",
      provider: { kind: "vault" },
      targetName: "mcp-demo-environment-api-token-deadbeef",
      cleanupCommand: "cellarer secret rm mcp-demo-environment-api-token-deadbeef --provider vault",
    } as const;
    const applied = {
      mutationPlan: { planId: "adoption-plan" },
      candidateId: "candidate",
      provider: { kind: "vault" },
      targetName: orphan.targetName,
      status: "orphaned-reference",
      operation: {
        ok: false,
        conflict: {
          code: "MANUAL_RECOVERY_REQUIRED",
          message: "manual recovery is required",
          operationId: "operation",
          targets: ["store-target"],
          guidance: "review typed orphan evidence",
        },
      },
      orphan,
    } as AppliedInventorySecretAdoption;
    const app = createApp({
      env: createRealEnv(),
      storeRoot: "/unused",
      auth: { mode: "trusted-embedded" },
      inventorySecretAdoption: {
        plan: async () => ({}) as PlannedInventorySecretAdoption,
        apply: async () => applied,
      },
    });

    const response = await app.request("/api/v1/inventory/adoption/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationPlan: { planId: "adoption-plan" } }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "success",
      data: { status: "orphaned-reference", orphan },
    });
  });

  it("registers exact closed OpenAPI bodies", () => {
    expect(
      CLIENT_API_ROUTES.filter(({ operationId }) =>
        operationId.includes("InventorySecretAdoption"),
      ),
    ).toMatchObject([
      {
        operationId: "planInventorySecretAdoption",
        path: "/api/v1/inventory/adoption/plan",
        authentication: "mutation",
      },
      {
        operationId: "applyInventorySecretAdoption",
        path: "/api/v1/inventory/adoption/apply",
        authentication: "mutation",
      },
    ]);
    const openApi = createClientOpenApiDocument() as {
      paths: Record<
        string,
        { post?: { requestBody?: { content?: Record<string, { schema: unknown }> } } }
      >;
    };
    const planBody =
      openApi.paths["/api/v1/inventory/adoption/plan"]?.post?.requestBody?.content?.[
        "application/json"
      ]?.schema;
    expect(planBody).toMatchObject({ additionalProperties: false });
    expect(JSON.stringify(planBody)).not.toMatch(/"(?:secretValue|plaintext|value)"\s*:/u);
  });
});
