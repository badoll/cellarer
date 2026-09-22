import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  type InventorySource,
  inspectInventorySourcesBounded,
} from "../src/inventory/enumerator.js";
import { refreshInventory } from "../src/inventory/projector.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv } from "./helpers/env.js";

describe("unified Inventory bounded performance", () => {
  it.each([100, 1000])("captures a shared %i Skill pool once across consumers", async (count) => {
    const t = makeTmpEnv();
    try {
      await ensureBaseDirs(t);
      const storeRoot = t.path("home", ".cellarer");
      await initStore(t.env, storeRoot);
      const pool = t.path("home", ".agents", "skills");
      for (let index = 0; index < count; index += 1) {
        const dir = join(pool, `skill-${index}`);
        await t.env.fs.mkdir(dir, { recursive: true });
        await t.env.fs.writeFile(join(dir, "SKILL.md"), `# Skill ${index}\n`);
      }
      let captures = 0;
      const env = {
        ...t.env,
        fs: {
          ...t.env.fs,
          snapshotPathNoFollow: async (
            ...args: Parameters<typeof t.env.fs.snapshotPathNoFollow>
          ) => {
            if (args[1] === pool) captures += 1;
            return t.env.fs.snapshotPathNoFollow(...args);
          },
        },
      };
      const start = performance.now();
      const result = await refreshInventory(env, { storeRoot });
      const elapsed = performance.now() - start;
      expect(captures).toBe(1);
      expect(result.candidates).toHaveLength(count);
      expect(result.candidates.every((candidate) => candidate.relatedAdapters.length >= 2)).toBe(
        true,
      );
      expect(result.completeness).toBe("complete");
      console.info(
        `Inventory ${count} Skills: ${elapsed.toFixed(1)} ms; shared captures=${captures}`,
      );
    } finally {
      await t.cleanup();
    }
  });

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
