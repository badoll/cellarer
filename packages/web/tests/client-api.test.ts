import { afterEach, describe, expect, it, vi } from "vitest";

describe("bundled versioned API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("bootstraps a same-origin session before the first authenticated request", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            apiVersion: "1.0",
            requestId: "req-bootstrap",
            status: "success",
            warnings: [],
            data: { authenticated: true, authMode: "browser-session" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            apiVersion: "1.0",
            requestId: "req-version",
            status: "success",
            warnings: [],
            data: { apiVersion: "1.0", contractId: "cellarer-local-client-api-v1" },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../client/api.js");

    const response = await apiFetch("/api/v1/version");

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/auth/session",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/version",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("parses split NDJSON progress and requires an authoritative terminal event", async () => {
    const result = {
      generatedAt: "2026-09-24T00:00:00.000Z",
      candidates: [],
      findings: [],
      counts: {
        total: 0,
        ready: 0,
        needsAttention: 0,
        inStore: 0,
        observedSources: 0,
        failedSources: 0,
      },
      completeness: "complete",
    };
    const lines = [
      { type: "started", attempt: 1, sequence: 1, totalSources: 1 },
      {
        type: "progress",
        attempt: 1,
        sequence: 2,
        completedSources: 1,
        totalSources: 1,
        candidates: [],
        findingCodes: [],
      },
      { type: "completed", attempt: 1, sequence: 3, result },
    ]
      .map((event) => `${JSON.stringify(event)}\n`)
      .join("");
    const bytes = new TextEncoder().encode(lines);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 19));
        controller.enqueue(bytes.slice(19));
        controller.close();
      },
    });
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
          operations: ["streamInventory"],
        }),
      )
      .mockResolvedValueOnce(
        new Response(body, { headers: { "content-type": "application/x-ndjson" } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { streamInventory } = await import("../client/api.js");
    const seen: string[] = [];
    await expect(streamInventory((event) => seen.push(event.type))).resolves.toEqual(result);
    expect(seen).toEqual(["started", "progress", "completed"]);
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/v1/inventory/stream");
  });

  it("rejects an interrupted Inventory stream without treating previews as final", async () => {
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
          operations: ["streamInventory"],
        }),
      )
      .mockResolvedValueOnce(
        new Response('{"type":"started","attempt":1,"sequence":1,"totalSources":2}\n', {
          headers: { "content-type": "application/x-ndjson" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { streamInventory } = await import("../client/api.js");
    await expect(streamInventory(() => {})).rejects.toThrow("before the final result");
  });

  it("rejects legacy API paths at the single client boundary", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    const { apiFetch } = await import("../client/api.js");

    await expect(apiFetch("/api/agents")).rejects.toThrow("versioned /api/v1 path");
  });

  it("negotiates the exact API version and contract before ordinary operations", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successResponse("req-bootstrap", {
          authenticated: true,
          authMode: "browser-session",
        }),
      )
      .mockResolvedValueOnce(
        successResponse("req-version", {
          apiVersion: "1.0",
          contractId: "cellarer-local-client-api-v1",
        }),
      )
      .mockResolvedValueOnce(
        successResponse("req-capabilities", {
          apiVersion: "1.0",
          contractId: "cellarer-local-client-api-v1",
          operations: ["getSummary"],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { negotiateClientApi } = await import("../client/api.js");

    await expect(negotiateClientApi()).resolves.toMatchObject({
      apiVersion: "1.0",
      contractId: "cellarer-local-client-api-v1",
      operations: ["getSummary"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed when discovery reports an incompatible contract", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(successResponse("req-bootstrap", { authenticated: true }))
      .mockResolvedValueOnce(
        successResponse("req-version", {
          apiVersion: "2.0",
          contractId: "unknown-contract",
        }),
      )
      .mockResolvedValueOnce(
        successResponse("req-capabilities", {
          apiVersion: "2.0",
          contractId: "unknown-contract",
          operations: [],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { negotiateClientApi } = await import("../client/api.js");

    await expect(negotiateClientApi()).rejects.toThrow("incompatible local client API");
  });

  it("applies the exact plan receipt returned by the preview request", async () => {
    const mutationPlan = { schemaVersion: 1, planId: "plan-exact" };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(successResponse("req-bootstrap", { authenticated: true }))
      .mockResolvedValueOnce(
        successResponse("req-version", {
          apiVersion: "1.0",
          contractId: "cellarer-local-client-api-v1",
        }),
      )
      .mockResolvedValueOnce(
        successResponse("req-capabilities", {
          apiVersion: "1.0",
          contractId: "cellarer-local-client-api-v1",
          operations: ["planCollectionMutation", "applyControlPlaneMutation"],
        }),
      )
      .mockResolvedValueOnce(successResponse("req-plan", { plan: mutationPlan }))
      .mockResolvedValueOnce(successResponse("req-apply", { operation: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const { applyPlannedControlPlaneMutation } = await import("../client/api.js");

    await applyPlannedControlPlaneMutation("/api/v1/collections/plan", {
      action: "create",
      collectionName: "exact",
    });

    const applyInit = fetchMock.mock.calls[4]?.[1];
    expect(JSON.parse(String(applyInit?.body))).toEqual({ mutationPlan });
  });

  it("keeps Inventory planning separate until confirmation applies the exact receipt", async () => {
    const mutationPlan = { schemaVersion: 1, planId: "inventory-import-plan" };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(successResponse("req-bootstrap", { authenticated: true }))
      .mockResolvedValueOnce(
        successResponse("req-version", {
          apiVersion: "1.0",
          contractId: "cellarer-local-client-api-v1",
        }),
      )
      .mockResolvedValueOnce(
        successResponse("req-capabilities", {
          apiVersion: "1.0",
          contractId: "cellarer-local-client-api-v1",
          operations: ["planInventoryStoreImport", "applyInventoryStoreImport"],
        }),
      )
      .mockResolvedValueOnce(successResponse("req-plan", { mutationPlan }))
      .mockResolvedValueOnce(successResponse("req-apply", { operation: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("../client/api.js");

    const planned = await api.planInventoryStoreImport({ candidateIds: ["candidate-exact"] });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await api.applyInventoryStoreImport(planned.mutationPlan);

    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({ mutationPlan });
    expect(api).not.toHaveProperty("applyPlannedInventoryStoreImport");
  });
});

function successResponse(requestId: string, data: unknown): Response {
  return new Response(
    JSON.stringify({ apiVersion: "1.0", requestId, status: "success", warnings: [], data }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
