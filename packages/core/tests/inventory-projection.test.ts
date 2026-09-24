import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshInventory } from "../src/inventory/projector.js";
import type { InventoryStreamEvent } from "../src/protocol/client-types.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("unified Inventory projection", () => {
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

  it("projects in-store and ready candidates from one stable Store revision", async () => {
    const rules = "# Shared rules\n";
    await t.env.fs.mkdir(t.path("home", ".agents"), { recursive: true });
    await t.env.fs.writeFile(t.path("home", ".agents", "AGENTS.md"), rules);
    await t.env.fs.writeFile(join(storeRoot, "store", "rules", "AGENTS.md"), rules);
    await t.env.fs.mkdir(t.path("home", ".agents", "skills", "fresh-skill"), {
      recursive: true,
    });
    await t.env.fs.writeFile(
      t.path("home", ".agents", "skills", "fresh-skill", "SKILL.md"),
      "---\nname: fresh-skill\ndescription: Fresh\n---\n# Fresh\n",
    );

    const result = await refreshInventory(t.env, { storeRoot, agentId: "agents-md" });
    const managed = result.candidates.find((candidate) => candidate.kind === "rules");
    const fresh = result.candidates.find((candidate) => candidate.name === "fresh-skill");

    expect(result.completeness).toBe("complete");
    expect(managed).toMatchObject({
      state: "in-store",
      defaultSelected: false,
      managedMatch: { resourceId: "rules/AGENTS" },
    });
    expect(fresh).toMatchObject({ state: "ready", defaultSelected: true });
    expect(result.counts).toMatchObject({ total: 2, ready: 1, inStore: 1 });
    expect(JSON.stringify(result)).not.toContain(t.root);
  });

  it("preserves safe candidates and reports partial completeness when one source is unsafe", async () => {
    await t.env.fs.mkdir(t.path("home", ".agents", "skills", "safe"), { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".agents", "skills", "safe", "SKILL.md"),
      "---\nname: safe\ndescription: Safe\n---\n# Safe\n",
    );
    const external = t.path("external-rules.md");
    await t.env.fs.writeFile(external, "# External\n");
    await t.env.fs.mkdir(t.path("home", ".agents"), { recursive: true });
    await t.env.fs.symlink(external, t.path("home", ".agents", "AGENTS.md"), "file");

    const result = await refreshInventory(t.env, { storeRoot, agentId: "agents-md" });

    expect(result.completeness).toBe("partial");
    expect(result.candidates.some((candidate) => candidate.name === "safe")).toBe(true);
    expect(result.findings.some((finding) => finding.code === "UNSAFE_LINK")).toBe(true);
  });

  it("reports provisional observations before later conflicts and source failures", async () => {
    const skills = t.path("home", ".agents", "skills");
    await t.env.fs.mkdir(join(skills, "first"), { recursive: true });
    await t.env.fs.mkdir(join(skills, "second"), { recursive: true });
    await t.env.fs.writeFile(
      join(skills, "first", "SKILL.md"),
      "---\nname: same\ndescription: first\n---\n# First\n",
    );
    await t.env.fs.writeFile(
      join(skills, "second", "SKILL.md"),
      "---\nname: same\ndescription: second\n---\n# Second\n",
    );
    await t.env.fs.symlink(t.path("outside-rules"), t.path("home", ".agents", "AGENTS.md"));
    const events: InventoryStreamEvent[] = [];
    const result = await refreshInventory(t.env, {
      storeRoot,
      agentId: "agents-md",
      concurrency: 1,
      onProgress: (event) => events.push(event),
    });
    expect(events[0]).toMatchObject({ type: "started", attempt: 1, sequence: 1 });
    expect(events.at(-1)).toMatchObject({ type: "completed", result });
    const progress = events.filter((event) => event.type === "progress");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toMatchObject({
      completedSources: expect.any(Number),
      findingCodes: expect.any(Array),
    });
    expect(progress.some((event) => event.candidates.length > 0)).toBe(true);
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conflictGroupId: expect.any(String), state: "needs-attention" }),
      ]),
    );
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "UNSAFE_LINK" })]),
    );
    const provisional = JSON.stringify(progress);
    expect(provisional).not.toContain(t.root);
    expect(provisional).not.toContain("# First");
    expect(provisional).not.toContain("defaultSelected");
    expect(provisional).not.toContain("state");
  });

  it("resets provisional rows before a Store-revision retry", async () => {
    const skill = t.path("home", ".agents", "skills", "retry");
    await t.env.fs.mkdir(skill, { recursive: true });
    await t.env.fs.writeFile(
      join(skill, "SKILL.md"),
      "---\nname: retry\ndescription: fixture\n---\n",
    );
    const events: InventoryStreamEvent[] = [];
    let changed = false;
    const result = await refreshInventory(t.env, {
      storeRoot,
      agentId: "agents-md",
      onProgress: (event) => {
        events.push(event);
        if (event.type === "progress" && !changed) {
          changed = true;
          writeFileSync(join(storeRoot, "revision.json"), '{"schemaVersion":1,"revision":1}\n');
        }
      },
    });
    expect(result.completeness).toBe("complete");
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["reset", "completed"]),
    );
    const resetIndex = events.findIndex((event) => event.type === "reset");
    expect(events.slice(resetIndex + 1)[0]).toMatchObject({
      type: "started",
      attempt: 2,
      sequence: 1,
    });
    expect(events.at(-1)).toMatchObject({ type: "completed", attempt: 2, result });
  });

  it("stops a cancelled read without publishing a terminal result", async () => {
    const skill = t.path("home", ".agents", "skills", "cancel");
    await t.env.fs.mkdir(skill, { recursive: true });
    await t.env.fs.writeFile(
      join(skill, "SKILL.md"),
      "---\nname: cancel\ndescription: fixture\n---\n",
    );
    const controller = new AbortController();
    const events: InventoryStreamEvent[] = [];
    await expect(
      refreshInventory(t.env, {
        storeRoot,
        agentId: "agents-md",
        signal: controller.signal,
        onProgress: (event) => {
          events.push(event);
          if (event.type === "progress") controller.abort();
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });

  it("returns a closed failed result for an unsafe Store snapshot", async () => {
    const external = t.path("external-config.json");
    await t.env.fs.writeFile(external, '{"secret":"must-not-observe"}\n');
    await t.env.fs.rm(join(storeRoot, "config.json"));
    await t.env.fs.symlink(external, join(storeRoot, "config.json"), "file");

    const result = await refreshInventory(t.env, { storeRoot });

    expect(result).toMatchObject({
      completeness: "failed",
      candidates: [],
      findings: [{ code: "STORE_SNAPSHOT_UNSAFE" }],
    });
    expect(JSON.stringify(result)).not.toContain("must-not-observe");
  });

  it("preserves safe source candidates when managed Store projection fails", async () => {
    await t.env.fs.mkdir(t.path("home", ".agents", "skills", "safe"), { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".agents", "skills", "safe", "SKILL.md"),
      "---\nname: safe\ndescription: Safe\n---\n# Safe\n",
    );
    await t.env.fs.writeFile(join(storeRoot, "store", "mcp", "broken.json"), "{not-json\n");

    const result = await refreshInventory(t.env, { storeRoot, agentId: "agents-md" });

    expect(result.completeness).toBe("partial");
    expect(result.candidates).toEqual([
      expect.objectContaining({ name: "safe", state: "ready", defaultSelected: true }),
    ]);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "STORE_PROJECTION_FAILED", scope: "refresh" }),
    );
  });
});
