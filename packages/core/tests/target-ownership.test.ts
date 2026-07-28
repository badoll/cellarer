import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TargetOwner } from "../src/model/index.js";
import { sha256 } from "../src/store/checksum.js";
import { inspectTargetOwnership } from "../src/target-ownership.js";
import { ensureBaseDirs, FIXED_NOW, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

function ownerFor(target: string, fingerprint: string): TargetOwner {
  return {
    agent: "codex",
    scope: "global",
    capability: "rules",
    target,
    artifactIds: ["rules/coding-style"],
    receipt: {
      method: "write",
      fingerprint,
      backup: null,
      generated: true,
      appliedAt: FIXED_NOW.toISOString(),
    },
  };
}

describe("target ownership inspection", () => {
  let t: TmpEnv;
  let target: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    target = t.path("home", ".codex", "AGENTS.md");
  });

  afterEach(() => t.cleanup());

  function inspect(owners: TargetOwner[] = [], inspectedTarget = target) {
    return inspectTargetOwnership(t.env, {
      agent: "codex",
      scope: "global",
      capability: "rules",
      target: inspectedTarget,
      owners,
    });
  }

  it("classifies a missing adapter target as absent", async () => {
    await expect(inspect()).resolves.toMatchObject({
      classification: "absent",
      target,
      fingerprint: null,
    });
  });

  it("classifies an intact owned file as owned-current", async () => {
    await t.env.fs.mkdir(t.path("home", ".codex"), { recursive: true });
    await t.env.fs.writeFile(target, "managed\n");

    await expect(inspect([ownerFor(target, sha256("managed\n"))])).resolves.toMatchObject({
      classification: "owned-current",
      fingerprint: sha256("managed\n"),
    });
  });

  it("classifies a changed owned file as owned-drifted", async () => {
    await t.env.fs.mkdir(t.path("home", ".codex"), { recursive: true });
    await t.env.fs.writeFile(target, "edited\n");

    await expect(inspect([ownerFor(target, sha256("managed\n"))])).resolves.toMatchObject({
      classification: "owned-drifted",
      fingerprint: sha256("edited\n"),
    });
  });

  it("classifies an existing unowned directory and fingerprints its contents", async () => {
    const skillTarget = t.path("home", ".codex", "skills", "demo");
    await t.env.fs.mkdir(skillTarget, { recursive: true });
    await t.env.fs.writeFile(t.path("home", ".codex", "skills", "demo", "SKILL.md"), "demo");

    const result = await inspectTargetOwnership(t.env, {
      agent: "codex",
      scope: "global",
      capability: "skills",
      target: skillTarget,
      owners: [],
    });

    expect(result.classification).toBe("unowned-existing");
    expect(result.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("classifies duplicate matching owners as invalid-owner", async () => {
    await t.env.fs.mkdir(t.path("home", ".codex"), { recursive: true });
    await t.env.fs.writeFile(target, "managed\n");
    const owner = ownerFor(target, sha256("managed\n"));

    await expect(
      inspect([owner, { ...owner, artifactIds: ["rules/security"] }]),
    ).resolves.toMatchObject({
      classification: "invalid-owner",
      reason: expect.stringMatching(/duplicate/i),
    });
  });

  it("normalizes adapter and owner paths before matching", async () => {
    await t.env.fs.mkdir(t.path("home", ".codex"), { recursive: true });
    await t.env.fs.writeFile(target, "managed\n");
    const aliasedTarget = t.path("home", ".codex", "nested", "..", "AGENTS.md");

    await expect(inspect([ownerFor(aliasedTarget, sha256("managed\n"))])).resolves.toMatchObject({
      classification: "owned-current",
      target,
    });
  });

  it("rejects an adapter target outside its scope root", async () => {
    const outside = t.path("outside", "AGENTS.md");
    await t.env.fs.mkdir(t.path("outside"), { recursive: true });
    await t.env.fs.writeFile(outside, "outside\n");

    await expect(inspect([ownerFor(outside, sha256("outside\n"))], outside)).resolves.toMatchObject(
      {
        classification: "invalid-owner",
        reason: expect.stringMatching(/outside.*managed root/i),
      },
    );
  });

  it("rejects a target below an ancestor symlink", async () => {
    const outside = t.path("outside");
    const linkedDir = t.path("home", ".codex");
    await t.env.fs.mkdir(outside, { recursive: true });
    await t.env.fs.symlink(outside, linkedDir, "dir");
    await t.env.fs.writeFile(t.path("outside", "AGENTS.md"), "outside\n");

    await expect(inspect([ownerFor(target, sha256("outside\n"))])).resolves.toMatchObject({
      classification: "invalid-owner",
      reason: expect.stringMatching(/ancestor symlink/i),
    });
  });

  it("allows the final target itself to be an owned Skill symlink", async () => {
    const source = t.path("home", ".cellarer", "store", "skills", "demo");
    const skillTarget = t.path("home", ".codex", "skills", "demo");
    await t.env.fs.mkdir(source, { recursive: true });
    await t.env.fs.mkdir(t.path("home", ".codex", "skills"), { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "store", "skills", "demo", "SKILL.md"),
      "demo",
    );
    await t.env.fs.symlink(source, skillTarget, "dir");

    const initial = await inspectTargetOwnership(t.env, {
      agent: "codex",
      scope: "global",
      capability: "skills",
      target: skillTarget,
      owners: [],
    });
    expect(initial.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    if (!initial.fingerprint) throw new Error("expected the Skill symlink to be fingerprinted");

    await expect(
      inspectTargetOwnership(t.env, {
        agent: "codex",
        scope: "global",
        capability: "skills",
        target: skillTarget,
        owners: [
          {
            ...ownerFor(skillTarget, initial.fingerprint),
            capability: "skills",
            artifactIds: ["skills/demo"],
            receipt: {
              ...ownerFor(skillTarget, "").receipt,
              method: "symlink",
              fingerprint: initial.fingerprint,
            },
          },
        ],
      }),
    ).resolves.toMatchObject({ classification: "owned-current" });
  });
});
