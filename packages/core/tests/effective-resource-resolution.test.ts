import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planInventoryStoreImport } from "../src/inventory/import.js";
import { refreshInventory } from "../src/inventory/projector.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("bounded effective resource projection", () => {
  let t: TmpEnv;
  let storeRoot: string;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });
  afterEach(async () => {
    await t.cleanup();
  });
  async function put(path: string, text: string) {
    await t.env.fs.mkdir(join(path, ".."), { recursive: true });
    await t.env.fs.writeFile(path, text);
  }
  async function config(
    policy: "ranked" | "unknown" | "cumulative",
    kind: "skills" | "rules" = "skills",
  ) {
    await t.env.fs.writeFile(
      join(storeRoot, "config.json"),
      JSON.stringify({
        customAdapters: {
          fixture: {
            skills: { global: "~/.placement" },
            discovery: [1, 2, 3].map((rank) => ({
              sourceId: `source-${rank}`,
              scope: "global",
              kind,
              path: kind === "skills" ? `~/.pool-${rank}` : `~/.pool-${rank}/RULES.md`,
              locator: kind === "skills" ? "tree" : "file",
              maxDepth: 16,
              maxEntries: 100,
              maxBytes: 10000,
              precedence: { policy, rank, evidence: "fixture declared policy" },
            })),
          },
        },
      }),
    );
  }
  it("preserves three conflicting candidates and blocks default import despite a known winner", async () => {
    await config("ranked");
    for (const rank of [1, 2, 3])
      await put(
        t.path("home", `.pool-${rank}`, "demo", "SKILL.md"),
        `---\nname: demo\ndescription: Version ${rank}\n---\n# Version ${rank}\n`,
      );
    const result = await refreshInventory(t.env, { storeRoot, agentId: "fixture" });
    expect(result.candidates).toHaveLength(3);
    expect(
      result.candidates.every(
        (candidate) => candidate.conflictGroupId && !candidate.defaultSelected,
      ),
    ).toBe(true);
    expect(result.effectiveResources?.map((row) => row.state).sort()).toEqual([
      "effective",
      "shadowed",
      "shadowed",
    ]);
    const selected = result.effectiveResources?.find((row) => row.state === "effective");
    expect(selected?.sourceId).toBe("source-3");
    await expect(
      planInventoryStoreImport(t.env, {
        storeRoot,
        agentId: "fixture",
        candidateIds: result.candidates.map((row) => row.id),
      }),
    ).rejects.toThrow();
    const before = result.candidates.map((row) => row.id).sort();
    await put(
      t.path("home", ".pool-1", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Version 3\n---\n# Version 3\n",
    );
    const merged = await refreshInventory(t.env, { storeRoot, agentId: "fixture" });
    expect(merged.candidates).toHaveLength(2);
    expect(merged.candidates.every((row) => before.includes(row.id))).toBe(true);
    expect(merged.candidates.find((row) => row.id === selected?.candidateId)?.sources).toHaveLength(
      2,
    );
  });
  it("does not guess a winner for unknown policies or incomplete sources", async () => {
    await config("unknown");
    for (const rank of [1, 2])
      await put(
        t.path("home", `.pool-${rank}`, "demo", "SKILL.md"),
        `---\nname: demo\ndescription: Version ${rank}\n---\n# Version ${rank}\n`,
      );
    const result = await refreshInventory(t.env, { storeRoot, agentId: "fixture" });
    expect(result.effectiveResources?.every((row) => row.state === "ambiguous")).toBe(true);
    await config("ranked");
    await t.env.fs.symlink(t.path("home", ".pool-1"), t.path("home", ".pool-3"), "dir");
    const partial = await refreshInventory(t.env, { storeRoot, agentId: "fixture" });
    expect(partial.completeness).toBe("partial");
    expect(partial.effectiveResources?.every((row) => row.state === "unknown")).toBe(true);
  });
  it("uses the builtin Claude project context and personal priority without searching parents", async () => {
    const projectRoot = t.path("project");
    await put(
      t.path("home", ".claude", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Personal\n---\n# Personal\n",
    );
    await put(
      join(projectRoot, ".claude", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Project\n---\n# Project\n",
    );
    const result = await refreshInventory(t.env, {
      storeRoot,
      agentId: "claude-code",
      projectRoot,
    });
    expect(result.resolutionContext).toBe("project");
    expect(result.effectiveResources).toContainEqual(
      expect.objectContaining({ adapterId: "claude-code", scope: "global", state: "effective" }),
    );
    expect(result.effectiveResources).toContainEqual(
      expect.objectContaining({ adapterId: "claude-code", scope: "project", state: "shadowed" }),
    );
    expect(result.coverage).toContainEqual(
      expect.objectContaining({ dimension: "ancestors", status: "excluded" }),
    );
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        location: "<project>/.claude/skills",
        bounds: { maxDepth: 16, maxEntries: 10000, maxBytes: 33554432 },
      }),
    );
  });

  it("keeps cumulative Rules effective without erasing import conflicts", async () => {
    await config("cumulative", "rules");
    for (const rank of [1, 2, 3])
      await put(t.path("home", `.pool-${rank}`, "RULES.md"), `Rule ${rank}\n`);
    const result = await refreshInventory(t.env, { storeRoot, agentId: "fixture" });
    expect(result.candidates).toHaveLength(3);
    expect(
      result.effectiveResources?.every(
        (row) => row.state === "effective" && row.policy === "cumulative",
      ),
    ).toBe(true);
    expect(result.candidates.every((row) => !row.defaultSelected)).toBe(true);
  });
});
