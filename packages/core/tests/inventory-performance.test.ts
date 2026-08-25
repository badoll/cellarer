import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  type InventorySource,
  inspectInventorySourcesBounded,
} from "../src/inventory/enumerator.js";

describe("unified Inventory bounded performance", () => {
  it("keeps fixture work within the requested peak concurrency and latency budget", async () => {
    const sources: InventorySource[] = Array.from({ length: 24 }, (_, index) => ({
      id: `fixture:global:skills:/fixture/${String(index).padStart(2, "0")}`,
      adapterId: "fixture",
      displayName: "Fixture",
      scope: "global",
      kind: "skills",
      path: `/fixture/${String(index).padStart(2, "0")}`,
      enabled: false,
      detected: false,
    }));
    let active = 0;
    let peak = 0;
    const startedAt = performance.now();

    const results = await inspectInventorySourcesBounded(sources, 3, async (source) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return source.id;
    });
    const elapsedMs = performance.now() - startedAt;

    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(results.map(({ source }) => source.id)).toEqual(sources.map(({ id }) => id));
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
