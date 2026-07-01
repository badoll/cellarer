import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashDir } from "../src/fs/hashDir.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("fs/hashDir", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  async function seedDir(dir: string, files: Record<string, string>): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
      const full = t.path(dir, ...rel.split("/"));
      await t.env.fs.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await t.env.fs.writeFile(full, content);
    }
  }

  it("is stable for identical directory contents", async () => {
    await seedDir("a", { "SKILL.md": "hello", "sub/x.txt": "world" });
    await seedDir("b", { "SKILL.md": "hello", "sub/x.txt": "world" });
    expect(await hashDir(t.env, t.path("a"))).toBe(await hashDir(t.env, t.path("b")));
  });

  it("changes when a file content changes", async () => {
    await seedDir("a", { "SKILL.md": "hello" });
    const before = await hashDir(t.env, t.path("a"));
    await t.env.fs.writeFile(t.path("a", "SKILL.md"), "HELLO");
    expect(await hashDir(t.env, t.path("a"))).not.toBe(before);
  });

  it("changes when a file is added or removed", async () => {
    await seedDir("a", { "SKILL.md": "hello" });
    const one = await hashDir(t.env, t.path("a"));
    await t.env.fs.writeFile(t.path("a", "extra.txt"), "x");
    const two = await hashDir(t.env, t.path("a"));
    expect(two).not.toBe(one);
    await t.env.fs.rm(t.path("a", "extra.txt"), { force: true });
    expect(await hashDir(t.env, t.path("a"))).toBe(one);
  });

  it("distinguishes content moved between path and body (no separator collision)", async () => {
    await seedDir("a", { "ab.txt": "cd" });
    await seedDir("b", { "a.txt": "bcd" });
    expect(await hashDir(t.env, t.path("a"))).not.toBe(await hashDir(t.env, t.path("b")));
  });

  it("does not collide when file content contains NUL bytes", async () => {
    const NUL = String.fromCharCode(0);
    // 回归:曾用 NUL 同时做记录内/记录间分隔,内容含 NUL 时 A/B 可产出同哈希。
    // A:单文件内容 `a\0y\0b`;B:两文件 x=a、y=b。定长逐文件哈希后不应相同。
    await seedDir("a", { x: `a${NUL}y${NUL}b` });
    await seedDir("b", { x: "a", y: "b" });
    expect(await hashDir(t.env, t.path("a"))).not.toBe(await hashDir(t.env, t.path("b")));
  });
});
