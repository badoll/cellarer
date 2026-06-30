import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstatOrNull, readdirOrEmpty, readFileOrNull } from "../src/fs/probe.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

// 构造一个会抛指定 code 错误的 fs.readFile/lstat/readdir。
function failingFs(code: string) {
  const err = Object.assign(new Error(`mock ${code}`), { code });
  return {
    readFile: () => Promise.reject(err),
    lstat: () => Promise.reject(err),
    readdir: () => Promise.reject(err),
  };
}

describe("fs/probe", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  it("readFileOrNull returns null for a missing file (ENOENT)", async () => {
    expect(await readFileOrNull(t.env, t.path("nope.txt"))).toBeNull();
  });

  it("readFileOrNull returns content for an existing file", async () => {
    await t.env.fs.writeFile(t.path("a.txt"), "hi");
    expect(await readFileOrNull(t.env, t.path("a.txt"))).toBe("hi");
  });

  it("readFileOrNull RETHROWS a non-ENOENT error (e.g. EACCES) — must not mask as absent", async () => {
    const env = { ...t.env, fs: { ...t.env.fs, ...failingFs("EACCES") } };
    await expect(readFileOrNull(env, "/whatever")).rejects.toThrow(/EACCES/);
  });

  it("lstatOrNull rethrows non-ENOENT errors", async () => {
    const env = { ...t.env, fs: { ...t.env.fs, ...failingFs("EIO") } };
    await expect(lstatOrNull(env, "/whatever")).rejects.toThrow(/EIO/);
  });

  it("readdirOrEmpty returns [] for a missing dir but rethrows EACCES", async () => {
    expect(await readdirOrEmpty(t.env, t.path("no-such-dir"))).toEqual([]);
    const env = { ...t.env, fs: { ...t.env.fs, ...failingFs("EACCES") } };
    await expect(readdirOrEmpty(env, "/whatever")).rejects.toThrow(/EACCES/);
  });
});
