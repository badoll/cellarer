// @vitest-environment happy-dom
import type { InventoryRefreshResult, InventoryStreamEvent } from "@cellarer/core/client-api";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../client/App.js";
import { streamInventory } from "../client/api.js";

vi.mock("../client/api.js", () => ({
  apiFetch: vi.fn(),
  streamInventory: vi.fn(),
  planInventoryStoreImport: vi.fn(),
  applyInventoryStoreImport: vi.fn(),
  planInventorySecretAdoption: vi.fn(),
  applyInventorySecretAdoption: vi.fn(),
}));
vi.mock("../client/library-page.js", () => ({ LibraryPage: () => null }));

const complete: InventoryRefreshResult = {
  generatedAt: "2026-10-08T00:00:00Z",
  candidates: [
    {
      id: "inventory-candidate:v1:skills:current",
      kind: "skills",
      name: "current",
      contentFingerprint: `sha256:${"a".repeat(64)}`,
      state: "ready",
      defaultSelected: true,
      sources: [],
      relatedAdapters: [],
      findings: [],
    },
  ],
  findings: [],
  counts: {
    total: 1,
    ready: 1,
    needsAttention: 0,
    inStore: 0,
    observedSources: 1,
    failedSources: 0,
  },
  completeness: "complete",
};

describe("Discover navigation", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(streamInventory).mockReset().mockResolvedValue(complete);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  function discover() {
    const button = host.querySelector<HTMLButtonElement>(".flow-step");
    if (!button) throw new Error("Missing Discover button");
    button.click();
  }

  function navigateToLibrary() {
    const button = host.querySelector<HTMLButtonElement>(".flow-step:nth-child(2)");
    if (!button) throw new Error("Missing Store button");
    button.click();
  }

  function refresh() {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("Refresh Inventory"),
    );
    if (!button) throw new Error("Missing Refresh Inventory button");
    button.click();
  }

  it("reuses results and selections across Discover clicks and page round trips", async () => {
    expect(streamInventory).not.toHaveBeenCalled();
    await act(async () => root.render(createElement(App)));
    expect(streamInventory).not.toHaveBeenCalled();
    await act(async () => discover());
    expect(streamInventory).toHaveBeenCalledTimes(1);
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!checkbox) throw new Error("Missing candidate selection");
    await act(async () => checkbox.click());
    expect(checkbox.checked).toBe(false);
    await act(async () => discover());
    await act(async () => navigateToLibrary());
    expect(host.querySelector(".inventory-project-input")?.closest("[hidden]")).not.toBeNull();
    await act(async () => discover());
    expect(host.querySelector(".inventory-project-input")?.closest("[hidden]")).toBeNull();
    expect(streamInventory).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("current");
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  });

  it("preserves project scope and only scans again through the explicit refresh button", async () => {
    await act(async () => root.render(createElement(App)));
    await act(async () => discover());
    const input = host.querySelector<HTMLInputElement>(".inventory-project-input input");
    if (!input) throw new Error("Missing project input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "/work/project",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => discover());
    expect(streamInventory).toHaveBeenCalledTimes(1);
    await act(async () => refresh());
    expect(streamInventory).toHaveBeenCalledTimes(2);
    expect(streamInventory).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.any(AbortSignal),
      { dir: "/work/project" },
    );
    await act(async () => navigateToLibrary());
    await act(async () => discover());
    expect(input.value).toBe("/work/project");
    expect(streamInventory).toHaveBeenCalledTimes(2);
    vi.mocked(streamInventory).mockImplementationOnce(() => new Promise(() => {}));
    await act(async () => refresh());
    expect(streamInventory).toHaveBeenCalledTimes(3);
    expect(streamInventory).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.any(AbortSignal),
      { dir: "/work/project" },
    );
    expect(host.textContent).toContain("Previous Inventory result is stale");
    expect(host.querySelector('input[type="checkbox"]')?.hasAttribute("disabled")).toBe(true);
  });

  it("keeps one pending scan running while navigating away and back", async () => {
    let resolveScan!: (result: InventoryRefreshResult) => void;
    let emit!: (event: InventoryStreamEvent) => void;
    vi.mocked(streamInventory).mockImplementationOnce((onEvent) => {
      emit = onEvent;
      return new Promise((resolve) => {
        resolveScan = resolve;
      });
    });
    await act(async () => root.render(createElement(App)));
    await act(async () => discover());
    const signal = vi.mocked(streamInventory).mock.calls[0]?.[1];
    await act(async () => navigateToLibrary());
    await act(async () => discover());
    expect(streamInventory).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    await act(async () => {
      emit({ type: "started", attempt: 1, sequence: 1, totalSources: 1 });
    });
    expect(host.textContent).toContain("Scanning sources");
    await act(async () => resolveScan(complete));
    expect(host.textContent).toContain("current");
    expect(host.querySelector('input[type="checkbox"]')?.hasAttribute("disabled")).toBe(false);
  });
});
