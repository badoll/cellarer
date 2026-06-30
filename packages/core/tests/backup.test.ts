import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupIfNeeded } from "../src/fs/backup.js";
import { GENERATED_HEADER } from "../src/markers.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("fs/backup", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  it("returns null when the target does not exist", async () => {
    const r = await backupIfNeeded(t.env, t.path("nope.md"));
    expect(r).toBeNull();
  });

  it("creates a .bak copy of an existing user file", async () => {
    const p = t.path("CLAUDE.md");
    await t.env.fs.writeFile(p, "user content");
    const bak = await backupIfNeeded(t.env, p);
    expect(bak).toBe(`${p}.bak`);
    expect(await t.env.fs.readFile(`${p}.bak`)).toBe("user content");
  });

  it("does not back up a cellarer-generated file", async () => {
    const p = t.path("CLAUDE.md");
    await t.env.fs.writeFile(p, `${GENERATED_HEADER}\n\nstuff\n`);
    const bak = await backupIfNeeded(t.env, p);
    expect(bak).toBeNull();
    await expect(t.env.fs.lstat(`${p}.bak`)).rejects.toThrow();
  });

  it("does not overwrite an existing .bak (preserves the first backup)", async () => {
    const p = t.path("CLAUDE.md");
    await t.env.fs.writeFile(p, "v1");
    await backupIfNeeded(t.env, p);
    await t.env.fs.writeFile(p, "v2");
    const bak = await backupIfNeeded(t.env, p);
    expect(bak).toBe(`${p}.bak`);
    // 原始备份(v1)被保留,不被 v2 覆盖。
    expect(await t.env.fs.readFile(`${p}.bak`)).toBe("v1");
  });
});
