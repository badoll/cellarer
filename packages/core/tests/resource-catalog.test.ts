import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apply,
  initStore,
  resourceCatalog,
  saveLedger,
  tagArtifactCollections,
  writeRuleArtifact,
} from "../src/index.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("resource catalog", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });

  afterEach(() => t.cleanup());

  it("lists managed resources with collections", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await tagArtifactCollections(t.env, storeRoot, ["rules/style"], "default");

    const catalog = await resourceCatalog(t.env, { storeRoot, kind: "rules" });

    expect(catalog.resources).toContainEqual(
      expect.objectContaining({
        id: "rules/style",
        kind: "rules",
        name: "style",
        state: "managed",
        collections: ["default"],
      }),
    );
  });

  it("marks synced and drifted targets from ledger status", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["codex"],
      collections: ["default"],
      capabilities: ["rules"],
      secretMode: "env",
    });

    let catalog = await resourceCatalog(t.env, { storeRoot, kind: "rules" });
    expect(catalog.resources[0]?.syncTargets[0]).toMatchObject({
      agent: "codex",
      destination: "user",
      state: "synced",
    });

    const target = catalog.resources[0]?.syncTargets[0]?.target;
    if (!target) throw new Error("expected synced target");
    await t.env.fs.writeFile(target, "# changed");

    catalog = await resourceCatalog(t.env, { storeRoot, kind: "rules" });
    expect(catalog.resources[0]?.syncTargets[0]).toMatchObject({
      state: "drifted",
    });
  });

  it("counts resources by state", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await saveLedger(t.env, storeRoot, {
      version: 1,
      entries: [
        {
          artifact: "rules/style",
          agent: "codex",
          scope: "global",
          capability: "rules",
          target: t.path("home", ".codex", "AGENTS.md"),
          method: "write",
          checksum: "sha256:missing",
          backup: null,
          generated: false,
          appliedAt: "2026-06-30T08:00:00.000Z",
        },
      ],
    });

    const catalog = await resourceCatalog(t.env, { storeRoot, kind: "rules" });
    expect(catalog.counts).toMatchObject({ managed: 1, missing: 1 });
  });
});
