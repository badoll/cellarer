import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureInventorySkillChild,
  createSkillTargetCaptureCache,
} from "../src/inventory/linked-skills.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const LIMITS = { maxDepth: 15, maxEntries: 100, maxBytes: 100_000 };

describe("request-local linked Skill capture reuse", () => {
  let t: TmpEnv;
  let target: string;
  let first: string;
  let second: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    target = t.path("home", "shared", "demo");
    first = t.path("home", ".claude", "skills", "demo");
    second = t.path("home", ".cursor", "skills", "demo");
    await t.env.fs.mkdir(target, { recursive: true });
    await t.env.fs.mkdir(join(first, ".."), { recursive: true });
    await t.env.fs.mkdir(join(second, ".."), { recursive: true });
    await t.env.fs.writeFile(join(target, "SKILL.md"), "# Shared Skill\n");
    await t.env.fs.symlink(target, first, "dir");
    await t.env.fs.symlink(target, second, "dir");
  });

  afterEach(() => t.cleanup());

  it("coalesces concurrent target byte capture while validating each alias", async () => {
    let targetCaptures = 0;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        snapshotPathNoFollow: async (...args: Parameters<typeof t.env.fs.snapshotPathNoFollow>) => {
          if (args[1] === target) {
            targetCaptures += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return t.env.fs.snapshotPathNoFollow(...args);
        },
      },
    };
    const cache = createSkillTargetCaptureCache();
    const [left, right] = await Promise.all([
      captureInventorySkillChild(env, t.env.homedir(), first, LIMITS, undefined, cache),
      captureInventorySkillChild(env, t.env.homedir(), second, LIMITS, undefined, cache),
    ]);

    expect(targetCaptures).toBe(1);
    expect(left.snapshot.fingerprint).toBe(right.snapshot.fingerprint);
    expect(left.snapshot.rootPath).toBe(first);
    expect(right.snapshot.rootPath).toBe(second);
  });

  it("does not let a shared capture satisfy a smaller source budget", async () => {
    let targetCaptures = 0;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        snapshotPathNoFollow: async (...args: Parameters<typeof t.env.fs.snapshotPathNoFollow>) => {
          if (args[1] === target) targetCaptures += 1;
          return t.env.fs.snapshotPathNoFollow(...args);
        },
      },
    };
    const cache = createSkillTargetCaptureCache();
    await captureInventorySkillChild(env, t.env.homedir(), first, LIMITS, undefined, cache);
    await expect(
      captureInventorySkillChild(
        env,
        t.env.homedir(),
        second,
        { ...LIMITS, maxBytes: 1 },
        undefined,
        cache,
      ),
    ).rejects.toMatchObject({ reason: "budget-exceeded" });
    expect(targetCaptures).toBe(1);
  });

  it("retries with a larger source limit after an in-flight tight capture fails", async () => {
    const cache = createSkillTargetCaptureCache();
    const tight = captureInventorySkillChild(
      t.env,
      t.env.homedir(),
      first,
      { ...LIMITS, maxBytes: 1 },
      undefined,
      cache,
    );
    const broad = captureInventorySkillChild(
      t.env,
      t.env.homedir(),
      second,
      LIMITS,
      undefined,
      cache,
    );
    await expect(tight).rejects.toMatchObject({ reason: "budget-exceeded" });
    await expect(broad).resolves.toMatchObject({ snapshot: { kind: "directory" } });
  });

  it("rejects a retargeted alias even when its old target was cached", async () => {
    const cache = createSkillTargetCaptureCache();
    await captureInventorySkillChild(t.env, t.env.homedir(), first, LIMITS, undefined, cache);
    let changed = false;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        verifyTreeSnapshot: async (...args: Parameters<typeof t.env.fs.verifyTreeSnapshot>) => {
          if (!changed) {
            changed = true;
            await t.env.fs.rm(second);
            await t.env.fs.symlink(t.path("cwd"), second, "dir");
          }
          return t.env.fs.verifyTreeSnapshot(...args);
        },
      },
    };
    await expect(
      captureInventorySkillChild(env, t.env.homedir(), second, LIMITS, undefined, cache),
    ).rejects.toMatchObject({ reason: "stale" });
  });
});
