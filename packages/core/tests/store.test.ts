import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRuleArtifacts, readRuleArtifact, resolveStoreRoot } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("store/store", () => {
  let t: TmpEnv;
  let storeRoot: string;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await t.env.fs.mkdir(t.path("home", ".cellarer", "store", "rules"), { recursive: true });
  });
  afterEach(() => t.cleanup());

  it("resolveStoreRoot defaults to ~/.cellarer", () => {
    expect(resolveStoreRoot(t.env)).toBe(t.path("home", ".cellarer"));
  });

  it("resolveStoreRoot honors CELLARER_HOME env override", () => {
    const w = makeTmpEnv({ env: { CELLARER_HOME: "/custom/cellarer" } });
    expect(resolveStoreRoot(w.env)).toBe("/custom/cellarer");
  });

  it("lists rule artifacts (sorted, .md only)", async () => {
    await t.env.fs.writeFile(t.path("home", ".cellarer", "store", "rules", "zeta.md"), "Z");
    await t.env.fs.writeFile(t.path("home", ".cellarer", "store", "rules", "alpha.md"), "A");
    await t.env.fs.writeFile(t.path("home", ".cellarer", "store", "rules", "notes.txt"), "x");
    const arts = await listRuleArtifacts(t.env, storeRoot);
    expect(arts.map((a) => a.id)).toEqual(["rules/alpha", "rules/zeta"]);
    expect(arts[0]?.kind).toBe("rules");
    expect(arts[0]?.name).toBe("alpha");
  });

  it("returns [] when the rules dir is absent", async () => {
    const empty = t.path("home", "empty-store");
    await t.env.fs.mkdir(empty, { recursive: true });
    expect(await listRuleArtifacts(t.env, empty)).toEqual([]);
  });

  it("reads a rule artifact's content and relPath", async () => {
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "store", "rules", "coding-style.md"),
      "Use tabs.",
    );
    const frag = await readRuleArtifact(t.env, storeRoot, "rules/coding-style");
    expect(frag.content).toBe("Use tabs.");
    expect(frag.relPath).toBe("rules/coding-style.md");
  });
});
