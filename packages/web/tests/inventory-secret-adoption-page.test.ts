import type { InventoryCandidate } from "@cellarer/core/client-api";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventorySecretAdoptionView } from "../client/inventory-page.js";

describe("Inventory secret-adoption client view", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("renders reference-only candidate metadata and explicit plan/apply controls", () => {
    const candidate = {
      id: "inventory-candidate:v1:mcp:test",
      kind: "mcp",
      name: "demo",
      contentFingerprint: "sha256:test",
      state: "needs-attention",
      defaultSelected: false,
      sources: [],
      relatedAdapters: [],
      findings: [
        {
          code: "secret-adoption-required",
          severity: "blocked",
          scope: "candidate",
          remediation: "adopt-supported-secret",
          adoption: {
            selector: { kind: "environment", server: "demo", name: "API_TOKEN" },
            targetName: "mcp-demo-environment-api-token-deadbeef",
          },
        },
      ],
    } satisfies InventoryCandidate;
    const html = renderToStaticMarkup(
      createElement(InventorySecretAdoptionView, {
        candidate,
        state: "review",
        provider: "vault",
      }),
    );

    expect(html).toContain("Adopt secret reference");
    expect(html).toContain("API_TOKEN");
    expect(html).toContain("mcp-demo-environment-api-token-deadbeef");
    expect(html).toContain("Confirm exact adoption");
    expect(html).not.toMatch(/type="(?:password|text)"/u);
    expect(html).not.toContain("page-known-value-canary");
  });

  it("sends only selector metadata and reapplies the exact reviewed receipt", async () => {
    const mutationPlan = { schemaVersion: 1, planId: "adoption-plan" };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(successResponse("bootstrap", { authenticated: true }))
      .mockResolvedValueOnce(
        successResponse("version", {
          apiVersion: "1.0",
          contractId: "cellarer-local-client-api-v1",
        }),
      )
      .mockResolvedValueOnce(
        successResponse("capabilities", {
          apiVersion: "1.0",
          contractId: "cellarer-local-client-api-v1",
          operations: ["planInventorySecretAdoption", "applyInventorySecretAdoption"],
        }),
      )
      .mockResolvedValueOnce(successResponse("plan", { mutationPlan }))
      .mockResolvedValueOnce(
        successResponse("apply", { status: "applied", operation: { ok: true } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("../client/api.js");
    const selector = { kind: "environment", server: "demo", name: "API_TOKEN" } as const;

    const planned = await api.planInventorySecretAdoption({
      candidateId: "candidate",
      selector,
      provider: "vault",
    });
    await api.applyInventorySecretAdoption(planned.mutationPlan);

    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      candidateId: "candidate",
      selector,
      provider: "vault",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({ mutationPlan });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("page-known-value-canary");
  });
});

function successResponse(requestId: string, data: unknown): Response {
  return new Response(
    JSON.stringify({ apiVersion: "1.0", requestId, status: "success", warnings: [], data }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
