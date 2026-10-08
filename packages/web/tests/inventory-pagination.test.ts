// @vitest-environment happy-dom
import type { InventoryRefreshResult, MutationPlan } from "@cellarer/core/client-api";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planInventoryStoreImport, streamInventory } from "../client/api.js";
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

describe("Inventory result pagination", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(navigator, "language", "get").mockReturnValue("zh-CN");
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    vi.mocked(streamInventory).mockReset().mockResolvedValue(inventory);
    vi.mocked(planInventoryStoreImport)
      .mockReset()
      .mockImplementation(async ({ candidateIds }) => ({
        inventory,
        candidateIds,
        mutationPlan: { schemaVersion: 1, planId: "exact-paged-selection" } as MutationPlan,
      }));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(InventoryPage)));
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
  function rows() {
    return [...host.querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')];
  }
  async function select(selector: string, value: string) {
    const input = host.querySelector<HTMLSelectElement>(selector);
    if (!input) throw new Error(`Missing select ${selector}`);
    await act(async () => {
      input.value = value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("bounds first and last pages with accurate counts and disabled navigation", async () => {
    expect(rows()).toHaveLength(20);
    expect(host.textContent).toContain("1–20 / 111");
    expect(host.textContent).toContain("第 1 / 6 页");
    expect(button("上一页").disabled).toBe(true);
    for (let i = 0; i < 5; i++) await act(async () => button("下一页").click());
    expect(rows()).toHaveLength(11);
    expect(rows()[0]?.getAttribute("aria-label")).toBe("Select skill-100");
    expect(host.textContent).toContain("101–111 / 111");
    expect(button("下一页").disabled).toBe(true);
    expect(button("上一页").disabled).toBe(false);
    expect(streamInventory).toHaveBeenCalledTimes(1);
  });

  it("retains cross-page selections and plans all checked IDs regardless of visible page", async () => {
    await act(async () => rows()[0]?.click());
    await act(async () => button("下一页").click());
    await act(async () => rows()[0]?.click());
    expect(host.textContent).toContain("第 2 / 6 页");
    expect(host.textContent).toContain("已选 81 项（本页 19 项）");
    await act(async () => button("上一页").click());
    expect(rows()[0]?.checked).toBe(false);
    await act(async () => button("审查导入").click());
    expect(planInventoryStoreImport).toHaveBeenCalledWith({
      candidateIds: inventory.candidates
        .filter(
          ({ defaultSelected, name }) =>
            defaultSelected && name !== "skill-0" && name !== "skill-20",
        )
        .map(({ id }) => id)
        .sort(),
      dir: undefined,
    });
    expect(streamInventory).toHaveBeenCalledTimes(1);
  });

  it("resets filters and page size while preserving selection, including empty results", async () => {
    await act(async () => button("下一页").click());
    await select("#inventory-filter-state", "needs-attention");
    expect(host.textContent).toContain("第 1 / 2 页");
    expect(rows()).toHaveLength(20);
    expect(rows().every(({ disabled }) => disabled)).toBe(true);
    await act(async () => button("下一页").click());
    await select(".inventory-pagination select", "10");
    expect(host.textContent).toContain("第 1 / 3 页");
    expect(rows()).toHaveLength(10);
    await select("#inventory-filter-kind", "rules");
    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain("0–0 / 0");
    expect(host.textContent).toContain("已选 83 项（本页 0 项）");
    expect(button("上一页").disabled).toBe(true);
    expect(button("下一页").disabled).toBe(true);
    expect(streamInventory).toHaveBeenCalledTimes(1);
  });

  it("resets to the first page after an explicit refresh with a smaller result", async () => {
    await act(async () => button("下一页").click());
    vi.mocked(streamInventory).mockResolvedValueOnce({
      ...inventory,
      candidates: inventory.candidates.slice(0, 3),
      counts: { ...inventory.counts, total: 3, ready: 3, needsAttention: 0 },
    });
    await act(async () => button("重新扫描").click());
    expect(rows()).toHaveLength(3);
    expect(host.textContent).toContain("第 1 / 1 页");
    expect(host.textContent).toContain("1–3 / 3");
    expect(button("上一页").disabled).toBe(true);
    expect(button("下一页").disabled).toBe(true);
    expect(streamInventory).toHaveBeenCalledTimes(2);
  });
});
