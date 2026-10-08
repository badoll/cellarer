// @vitest-environment happy-dom
import type { InventoryRefreshResult, MutationPlan } from "@cellarer/core/client-api";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyInventoryStoreImport,
  planInventoryStoreImport,
  streamInventory,
} from "../client/api.js";
import { InventoryPage } from "../client/inventory-page.js";

vi.mock("../client/api.js", () => ({
  streamInventory: vi.fn(),
  planInventoryStoreImport: vi.fn(),
  applyInventoryStoreImport: vi.fn(),
  planInventorySecretAdoption: vi.fn(),
  applyInventorySecretAdoption: vi.fn(),
}));

const inventory: InventoryRefreshResult = {
  generatedAt: "2026-10-08T00:00:00Z",
  completeness: "complete",
  findings: [],
  counts: {
    total: 111,
    ready: 83,
    needsAttention: 28,
    inStore: 0,
    observedSources: 23,
    failedSources: 0,
  },
  candidates: Array.from({ length: 111 }, (_, i) => ({
    id: `inventory-candidate:v1:skills:${i}`,
    name: `skill-${i}`,
    kind: "skills",
    contentFingerprint: `sha256:${"a".repeat(64)}`,
    state: i < 83 ? "ready" : "needs-attention",
    defaultSelected: i < 83,
    sources: [],
    relatedAdapters: [],
    findings: [],
  })),
};
const candidateIds = inventory.candidates
  .slice(0, 83)
  .map(({ id }) => id)
  .sort();
const mutationPlan = { schemaVersion: 1, planId: "exact-83-item-plan" } as MutationPlan;
const receipt = { inventory, candidateIds, mutationPlan };

describe("Inventory import review visibility", () => {
  let host: HTMLDivElement;
  let root: Root;
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(navigator, "language", "get").mockReturnValue("zh-CN");
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(scrollIntoView);
    scrollIntoView.mockClear();
    vi.mocked(streamInventory).mockReset().mockResolvedValue(inventory);
    vi.mocked(planInventoryStoreImport).mockReset().mockResolvedValue(receipt);
    vi.mocked(applyInventoryStoreImport).mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function button(text: string) {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes(text),
    );
    if (!found) throw new Error(`Missing button ${text}`);
    return found;
  }

  async function review() {
    await act(async () => root.render(createElement(InventoryPage)));
    await act(async () => button("审查导入").click());
    return host.querySelector<HTMLElement>(".inventory-confirmation");
  }

  it("brings the completed 83-item review into view above results without applying", async () => {
    const panel = await review();
    if (!panel) throw new Error("Missing confirmation panel");
    const table = host.querySelector("table");
    expect(table).not.toBeNull();
    expect(
      panel.compareDocumentPosition(table as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(document.activeElement).toBe(panel);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(panel?.textContent).toContain("83");
    expect(panel?.querySelectorAll(".inventory-review-resources li")).toHaveLength(83);
    expect(panel?.textContent).toContain("skill-82");
    expect(panel?.textContent).not.toContain("skill-83");
    expect(panel?.textContent).not.toContain("inventory-candidate:v1");
    expect(button("确认导入 Store").closest(".inventory-review-resources")).toBeNull();
    expect(planInventoryStoreImport).toHaveBeenCalledWith({ candidateIds, dir: undefined });
    expect(applyInventoryStoreImport).not.toHaveBeenCalled();
  });

  it("cancels without rescanning or applying and preserves selection", async () => {
    await review();
    await act(async () => button("取消").click());
    expect(host.querySelector(".inventory-confirmation")).toBeNull();
    expect(button("审查导入 (83)").disabled).toBe(false);
    expect(host.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(20);
    expect(streamInventory).toHaveBeenCalledTimes(1);
    expect(applyInventoryStoreImport).not.toHaveBeenCalled();
  });

  it("submits only the unchanged plan and keeps pending confirmation controls disabled", async () => {
    vi.mocked(applyInventoryStoreImport).mockImplementation(() => new Promise(() => {}));
    const panel = await review();
    await act(async () => button("确认导入 Store").click());
    expect(host.querySelector(".inventory-confirmation")).toBe(panel);
    expect(button("正在导入").disabled).toBe(true);
    expect(button("取消").disabled).toBe(true);
    await act(async () => button("正在导入").click());
    expect(applyInventoryStoreImport).toHaveBeenCalledTimes(1);
    expect(vi.mocked(applyInventoryStoreImport).mock.calls[0]?.[0]).toBe(mutationPlan);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
