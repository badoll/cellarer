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
  it.skipIf(process.env.CELLARER_FIRST_USE_BENCHMARK !== "1")(
    "records five full and targeted runs on an isolated shared-link topology",
    async () => {
      const t = makeTmpEnv();
      try {
        await ensureBaseDirs(t);
        const storeRoot = t.path("home", ".cellarer");
        await initStore(t.env, storeRoot);
        const source = t.path("home", ".agents", "skills");
        const claude = t.path("home", ".claude", "skills");
        const cursor = t.path("home", ".cursor", "skills");
        await t.env.fs.mkdir(claude, { recursive: true });
        await t.env.fs.mkdir(cursor, { recursive: true });
        for (let index = 0; index < 85; index += 1) {
          const name = `shared-${String(index).padStart(3, "0")}`;
          const target = join(source, name);
          await t.env.fs.mkdir(target, { recursive: true });
          await t.env.fs.writeFile(
            join(target, "SKILL.md"),
            `---\nname: ${name}\ndescription: Synthetic shared Skill\n---\n# ${name}\n`,
          );
          await t.env.fs.symlink(target, join(claude, name), "dir");
          await t.env.fs.symlink(target, join(cursor, name), "dir");
        }

        for (const [label, agentId] of [
          ["full", undefined],
          ["targeted", "claude-code"],
        ] as const) {
          const elapsed: number[] = [];
          const phases = {
            targetCaptureMs: 0,
            targetCaptures: 0,
            targetVerifyMs: 0,
            targetVerifies: 0,
          };
          const env = {
            ...t.env,
            fs: {
              ...t.env.fs,
              snapshotPathNoFollow: async (
                ...args: Parameters<typeof t.env.fs.snapshotPathNoFollow>
              ) => {
                const start = performance.now();
                try {
                  return await t.env.fs.snapshotPathNoFollow(...args);
                } finally {
                  if (args[1].startsWith(`${source}/`)) {
                    phases.targetCaptures += 1;
                    phases.targetCaptureMs += performance.now() - start;
                  }
                }
              },
              verifyTreeSnapshot: async (
                ...args: Parameters<typeof t.env.fs.verifyTreeSnapshot>
              ) => {
                const start = performance.now();
                try {
                  return await t.env.fs.verifyTreeSnapshot(...args);
                } finally {
                  if (args[0].rootPath.startsWith(`${source}/`)) {
                    phases.targetVerifies += 1;
                    phases.targetVerifyMs += performance.now() - start;
                  }
                }
              },
            },
          };
          let reference: string | undefined;
          for (let run = 0; run < 5; run += 1) {
            const started = performance.now();
            const result = await refreshInventory(env, {
              storeRoot,
              ...(agentId ? { agentId } : {}),
            });
            elapsed.push(performance.now() - started);
            const evidence = JSON.stringify({
              candidateIds: result.candidates.map(({ id }) => id),
              findings: result.findings.map(({ code, scope }) => [code, scope]),
              observedSources: result.counts.observedSources,
              failedSources: result.counts.failedSources,
              completeness: result.completeness,
            });
            if (reference === undefined) reference = evidence;
            else expect(evidence).toBe(reference);
          }
          const median = [...elapsed].sort((left, right) => left - right)[2];
          console.info(
            `Synthetic first-use ${label}: median=${median.toFixed(1)}ms runs=${elapsed.map((value) => value.toFixed(1)).join(",")} targetCapture=${phases.targetCaptures}/${phases.targetCaptureMs.toFixed(1)}ms targetVerify=${phases.targetVerifies}/${phases.targetVerifyMs.toFixed(1)}ms previewBeforeFinal=false`,
          );
        }
      } finally {
        await t.cleanup();
      }
    },
    120_000,
  );

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
  }, 60_000);

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
