import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkOrCopy } from "../src/fs/linkOrCopy.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("fs/linkOrCopy", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  describe("symlink method (POSIX)", () => {
    it("creates a file symlink and reports method symlink", async () => {
      const src = t.path("src.md");
      const dest = t.path("dest.md");
      await t.env.fs.writeFile(src, "content");
      const r = await linkOrCopy(t.env, src, dest, { method: "symlink", kind: "file" });
      expect(r.method).toBe("symlink");
      expect((await t.env.fs.lstat(dest)).isSymbolicLink()).toBe(true);
      expect(await t.env.fs.readFile(dest)).toBe("content");
    });

    it("is idempotent: a symlink already pointing at src is a no-op skip", async () => {
      const src = t.path("src.md");
      const dest = t.path("dest.md");
      await t.env.fs.writeFile(src, "content");
      await linkOrCopy(t.env, src, dest, { method: "symlink", kind: "file" });
      const r = await linkOrCopy(t.env, src, dest, { method: "symlink", kind: "file" });
      expect(r.method).toBe("symlink");
      expect(r.skipped).toBe(true);
    });

    it("replaces an existing regular file at dest with a symlink", async () => {
      const src = t.path("src.md");
      const dest = t.path("dest.md");
      await t.env.fs.writeFile(src, "new");
      await t.env.fs.writeFile(dest, "old");
      const r = await linkOrCopy(t.env, src, dest, { method: "symlink", kind: "file" });
      expect(r.method).toBe("symlink");
      expect((await t.env.fs.lstat(dest)).isSymbolicLink()).toBe(true);
      expect(await t.env.fs.readFile(dest)).toBe("new");
    });

    it("creates parent directories for dest", async () => {
      const src = t.path("src.md");
      const dest = t.path("deep", "nested", "dest.md");
      await t.env.fs.writeFile(src, "x");
      const r = await linkOrCopy(t.env, src, dest, { method: "symlink", kind: "file" });
      expect(r.method).toBe("symlink");
      expect(await t.env.fs.readFile(dest)).toBe("x");
    });

    it("symlinks a directory", async () => {
      const src = t.path("srcdir");
      const dest = t.path("destdir");
      await t.env.fs.mkdir(src, { recursive: true });
      await t.env.fs.writeFile(t.path("srcdir", "a.txt"), "inside");
      const r = await linkOrCopy(t.env, src, dest, { method: "symlink", kind: "dir" });
      expect(r.method).toBe("symlink");
      expect(await t.env.fs.readFile(t.path("destdir", "a.txt"))).toBe("inside");
    });
  });

  describe("copy method", () => {
    it("copies a file and reports method copy", async () => {
      const src = t.path("src.md");
      const dest = t.path("dest.md");
      await t.env.fs.writeFile(src, "content");
      const r = await linkOrCopy(t.env, src, dest, { method: "copy", kind: "file" });
      expect(r.method).toBe("copy");
      expect((await t.env.fs.lstat(dest)).isSymbolicLink()).toBe(false);
      expect(await t.env.fs.readFile(dest)).toBe("content");
    });

    it("copies a directory recursively", async () => {
      const src = t.path("srcdir");
      const dest = t.path("destdir");
      await t.env.fs.mkdir(src, { recursive: true });
      await t.env.fs.writeFile(t.path("srcdir", "a.txt"), "inside");
      const r = await linkOrCopy(t.env, src, dest, { method: "copy", kind: "dir" });
      expect(r.method).toBe("copy");
      expect(await t.env.fs.readFile(t.path("destdir", "a.txt"))).toBe("inside");
    });
  });

  describe("windows fallback (simulated platform)", () => {
    it("uses junction for directories on win32", async () => {
      const w = makeTmpEnv({ platform: "win32" });
      await ensureBaseDirs(w);
      try {
        const src = w.path("srcdir");
        const dest = w.path("destdir");
        await w.env.fs.mkdir(src, { recursive: true });
        const r = await linkOrCopy(w.env, src, dest, { method: "symlink", kind: "dir" });
        // junction 在非 Windows 主机上由 node 实现为目录软链;关键是 method 被记为 junction。
        expect(r.method).toBe("junction");
      } finally {
        await w.cleanup();
      }
    });
  });
});
