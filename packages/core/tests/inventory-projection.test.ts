import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshInventory } from "../src/inventory/projector.js";
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
      "# Fresh\n",
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
    await t.env.fs.writeFile(t.path("home", ".agents", "skills", "safe", "SKILL.md"), "# Safe\n");
    const external = t.path("external-rules.md");
    await t.env.fs.writeFile(external, "# External\n");
    await t.env.fs.mkdir(t.path("home", ".agents"), { recursive: true });
    await t.env.fs.symlink(external, t.path("home", ".agents", "AGENTS.md"), "file");

    const result = await refreshInventory(t.env, { storeRoot, agentId: "agents-md" });

    expect(result.completeness).toBe("partial");
    expect(result.candidates.some((candidate) => candidate.name === "safe")).toBe(true);
    expect(result.findings.some((finding) => finding.code === "UNSAFE_LINK")).toBe(true);
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
    await t.env.fs.writeFile(t.path("home", ".agents", "skills", "safe", "SKILL.md"), "# Safe\n");
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
