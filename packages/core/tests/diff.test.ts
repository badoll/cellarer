import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apply,
  diffTarget,
  importSkillArtifact,
  initStore,
  status,
  writeRuleArtifact,
} from "../src/index.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("dashboard diff", () => {
  let t: TmpEnv;
  let storeRoot: string;
  const REAL = "ghp_0123456789abcdefghijklmnopqrstuvwx";

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });
  afterEach(() => t.cleanup());

  it("returns an available file diff from reconstructed plan output", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["rules"],
    });
    const [item] = await status(t.env, { storeRoot });
    await t.env.fs.writeFile(item.target, "# changed");

    const diff = await diffTarget(t.env, {
      storeRoot,
      identity: item,
    });

    expect(diff).toMatchObject({ available: true, status: "available" });
    expect(diff.before).toContain("# changed");
    expect(diff.after).toContain("# style");
  });

  it("returns unavailable for a missing target", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["rules"],
    });
    const [item] = await status(t.env, { storeRoot });
    await t.env.fs.rm(item.target, { force: true });

    const diff = await diffTarget(t.env, { storeRoot, identity: item });

    expect(diff).toMatchObject({ available: false, warning: "target is missing" });
  });

  it("does not probe unrelated targets before reconstructing expected output", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");

    const diff = await diffTarget(t.env, {
      storeRoot,
      identity: {
        artifact: "rules/*",
        agent: "claude-code",
        scope: "global",
        capability: "rules",
        target: t.root,
      },
    });

    expect(diff).toMatchObject({
      available: false,
      warning: "expected output could not be reconstructed",
    });
  });

  it("returns unavailable for skills directory or symlink targets", async () => {
    const src = t.path("skill-src");
    await t.env.fs.mkdir(src, { recursive: true });
    await t.env.fs.writeFile(`${src}/SKILL.md`, "# Demo");
    await importSkillArtifact(t.env, storeRoot, "demo", src);
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["codex"],
      capabilities: ["skills"],
    });
    const [item] = await status(t.env, { storeRoot });

    const diff = await diffTarget(t.env, { storeRoot, identity: item });

    expect(diff.available).toBe(false);
    expect(diff.warning).toMatch(/directory|symlink/);
  });

  it("redacts plaintext secrets from diff payloads", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["rules"],
    });
    const [item] = await status(t.env, { storeRoot });
    await t.env.fs.writeFile(item.target, `token=${REAL}`);

    const diff = await diffTarget(t.env, { storeRoot, identity: item });

    expect(JSON.stringify(diff)).not.toContain(REAL);
    expect(diff.before).toBe("[redacted secret content]");
    expect(diff.redactionNotices.length).toBeGreaterThan(0);
  });
});
