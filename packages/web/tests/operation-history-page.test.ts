// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../client/api.js";
import { OperationHistoryPage } from "../client/operation-history-page.js";

vi.mock("../client/api.js", () => ({ apiFetch: vi.fn() }));

const receipt = {
  operationId: "op-one",
  operation: "apply",
  outcome: "committed",
  actionCount: 1,
  startedAt: "2026-09-24T00:00:00Z",
  completedAt: "2026-09-24T00:00:01Z",
};

describe("Operation History", () => {
  let host: HTMLDivElement;
  let root: Root;
  const calls: { path: string; body?: unknown }[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path.startsWith("/api/v1/operations?")) return response({ operations: [receipt] });
      if (path === "/api/v1/operations/op-one")
        return response({
          operation: {
            ...receipt,
            recoveryStatus: "clean",
            actionReceipts: [{ actionId: "one", target: "/target", outcome: "applied" }],
          },
        });
      if (path.startsWith("/api/v1/activity?")) return response({ events: [], warnings: [] });
      if (path === "/api/v1/recovery")
        return response({
          status: "manual-recovery-required",
          journal: { operationId: "op-manual" },
          message: "Inspect journal",
        });
      if (path === "/api/v1/revert/plan")
        return response({
          plan: { planId: "fresh", authorization: { proof: "sealed" }, actions: [] },
        });
      throw new Error(`Unexpected path ${path}`);
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.mocked(apiFetch).mockReset();
    vi.unstubAllGlobals();
  });

  it("separates historical receipt, manual recovery, current verification, and fresh revert planning", async () => {
    await act(async () => root.render(createElement(OperationHistoryPage)));
    await act(async () => buttonContaining("apply · committed").click());
    expect(host.textContent).toContain("Receipt op-one");
    expect(host.textContent).toContain("applied · /target");
    expect(host.textContent).toContain("Manual recovery is required");
    expect(host.textContent).not.toContain("Recover op-manual");
    expect(buttonContaining("Verify current configuration").disabled).toBe(true);
    await setInput("Agent IDs, comma separated", "codex");
    await setInput("Exact resource IDs, comma separated", "rules/a");
    await act(async () => buttonContaining("Preview historical revert").click());
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("fresh Core revert plan");
    expect(calls.some((call) => call.path === "/api/v1/revert/plan")).toBe(false);
    await act(async () => buttonExact("Preview").click());
    expect(calls.find((call) => call.path === "/api/v1/revert/plan")?.body).toEqual({
      agents: ["codex"],
      scope: "global",
      artifactIds: ["rules/a"],
    });
    expect(calls.some((call) => call.path === "/api/v1/revert/apply")).toBe(false);
    expect(calls.some((call) => call.path === "/api/v1/recovery/apply")).toBe(false);
  });

  it("keeps receipts available when recovery diagnosis fails", async () => {
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (path.startsWith("/api/v1/operations?")) return response({ operations: [receipt] });
      if (path.startsWith("/api/v1/activity?")) return response({ events: [], warnings: [] });
      if (path === "/api/v1/recovery") throw new Error("Recovery read failed");
      throw new Error(`Unexpected path ${path}`);
    });
    await act(async () => root.render(createElement(OperationHistoryPage)));
    expect(host.textContent).toContain("apply · committed");
    expect(host.textContent).toContain("Recovery status unavailable");
    expect(host.textContent).toContain("Recovery read failed");
  });

  it("requires two explicit clicks before recovering an incomplete operation", async () => {
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path.startsWith("/api/v1/operations?")) return response({ operations: [] });
      if (path.startsWith("/api/v1/activity?")) return response({ events: [], warnings: [] });
      if (path === "/api/v1/recovery")
        return response({
          status: "incomplete",
          journal: { operationId: "op-pending" },
          message: "Interrupted",
        });
      if (path === "/api/v1/recovery/apply") return response({ operation: { ok: true } });
      throw new Error(`Unexpected path ${path}`);
    });
    await act(async () => root.render(createElement(OperationHistoryPage)));
    expect(calls.some((call) => call.path === "/api/v1/recovery/apply")).toBe(false);
    await act(async () => buttonContaining("Review recovery action").click());
    expect(calls.some((call) => call.path === "/api/v1/recovery/apply")).toBe(false);
    await act(async () => buttonContaining("Recover op-pending").click());
    expect(calls.filter((call) => call.path === "/api/v1/recovery/apply")).toEqual([
      {
        path: "/api/v1/recovery/apply",
        body: { operationId: "op-pending" },
      },
    ]);
  });

  function buttonContaining(fragment: string) {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes(fragment),
    );
    if (!found) throw new Error(`Missing button ${fragment}`);
    return found;
  }
  function buttonExact(label: string) {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === label,
    );
    if (!found) throw new Error(`Missing button ${label}`);
    return found;
  }
  async function setInput(label: string, value: string) {
    const input = [...host.querySelectorAll<HTMLLabelElement>("label")]
      .find((item) => item.textContent?.includes(label))
      ?.querySelector("input");
    if (!input) throw new Error(`Missing input ${label}`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
});

function response(data: unknown) {
  return new Response(JSON.stringify({ status: "success", data }));
}
