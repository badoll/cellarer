// @vitest-environment happy-dom
import type { InventoryRefreshResult, InventoryStreamEvent } from "@cellarer/core/client-api";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamInventory } from "../client/api.js";

vi.mock("../client/api.js", () => ({
  streamInventory: vi.fn(),
  planInventoryStoreImport: vi.fn(),
  applyInventoryStoreImport: vi.fn(),
  planInventorySecretAdoption: vi.fn(),
  applyInventorySecretAdoption: vi.fn(),
}));

import { InventoryPage } from "../client/inventory-page.js";

const candidate = {
  id: "inventory-candidate:v1:skills:fixture",
  kind: "skills" as const,
  name: "fixture-skill",
  contentFingerprint: `sha256:${"a".repeat(64)}`,
  state: "ready" as const,
  defaultSelected: true,
  sources: [],
  relatedAdapters: [],
  findings: [],
};
const complete: InventoryRefreshResult = {
  generatedAt: "2026-09-24T00:00:00.000Z",
  candidates: [candidate],
  findings: [],
  counts: {
    total: 1,
    ready: 1,
    needsAttention: 0,
    inStore: 0,
    observedSources: 2,
    failedSources: 0,
  },
  completeness: "complete",
};

function deferredStream() {
  let resolve!: (result: InventoryRefreshResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<InventoryRefreshResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let emit!: (event: InventoryStreamEvent) => void;
  return {
    promise,
    resolve,
    reject,
    setEmit(callback: (event: InventoryStreamEvent) => void) {
      emit = callback;
    },
    send(event: InventoryStreamEvent) {
      emit(event);
    },
  };
}

describe("Inventory streaming page", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(streamInventory).mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows early pending rows and later authoritative status without enabling provisional selection", async () => {
    const stream = deferredStream();
    vi.mocked(streamInventory).mockImplementation((onEvent) => {
      stream.setEmit(onEvent);
      return stream.promise;
    });
    await act(async () => root.render(createElement(InventoryPage)));
    await act(async () => {
      stream.send({ type: "started", attempt: 1, sequence: 1, totalSources: 2 });
      stream.send({
        type: "progress",
        attempt: 1,
        sequence: 2,
        completedSources: 1,
        totalSources: 2,
        candidates: [{ id: candidate.id, kind: "skills", sourceCount: 1, sources: [] }],
        findingCodes: [],
      });
    });
    expect(container.textContent).toContain("Scanning sources · 1/2");
    expect(container.textContent).toContain("Pending");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    const conflicted: InventoryRefreshResult = {
      ...complete,
      candidates: [
        {
          ...candidate,
          state: "needs-attention",
          defaultSelected: false,
          conflictGroupId: "conflict",
        },
      ],
      counts: { ...complete.counts, ready: 0, needsAttention: 1 },
    };
    await act(async () => {
      stream.send({ type: "completed", attempt: 1, sequence: 3, result: conflicted });
      stream.resolve(conflicted);
    });
    expect(container.textContent).not.toContain("Pending");
    expect(container.textContent).toContain("Needs attention");
    expect(container.querySelector('input[type="checkbox"]')?.hasAttribute("disabled")).toBe(true);
  });

  it("labels a prior result stale, clears reset previews, and keeps actions disabled after transport failure", async () => {
    const first = deferredStream();
    const second = deferredStream();
    vi.mocked(streamInventory)
      .mockImplementationOnce((onEvent) => {
        first.setEmit(onEvent);
        return first.promise;
      })
      .mockImplementationOnce((onEvent) => {
        second.setEmit(onEvent);
        return second.promise;
      });
    await act(async () => root.render(createElement(InventoryPage)));
    await act(async () => {
      first.resolve(complete);
    });
    expect(container.querySelector('input[type="checkbox"]')?.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Refresh Inventory"))
        ?.click();
    });
    await act(async () => {
      second.send({ type: "started", attempt: 1, sequence: 1, totalSources: 2 });
      second.send({
        type: "progress",
        attempt: 1,
        sequence: 2,
        completedSources: 1,
        totalSources: 2,
        candidates: [{ id: candidate.id, kind: "skills", sourceCount: 1, sources: [] }],
        findingCodes: [],
      });
    });
    expect(container.textContent).toContain("Previous Inventory result is stale");
    expect(container.querySelector('input[type="checkbox"]')?.hasAttribute("disabled")).toBe(true);
    await act(async () => second.send({ type: "reset", attempt: 1, sequence: 3 }));
    expect(container.textContent).not.toContain("Pending");
    await act(async () => second.reject(new Error("connection lost")));
    expect(container.textContent).toContain("refresh failed");
    expect(container.querySelector('input[type="checkbox"]')?.hasAttribute("disabled")).toBe(true);
  });
});
