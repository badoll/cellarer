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

    it("replaces an existing regular file only when the caller explicitly allows it", async () => {
      const src = t.path("src.md");
      const dest = t.path("dest.md");
      await t.env.fs.writeFile(src, "new");
      await t.env.fs.writeFile(dest, "old");
      await expect(
        linkOrCopy(t.env, src, dest, { method: "symlink", kind: "file" }),
      ).rejects.toThrow(/replacement was not approved/);
      expect(await t.env.fs.readFile(dest)).toBe("old");
      const r = await linkOrCopy(t.env, src, dest, {
        method: "symlink",
        kind: "file",
        replaceExisting: true,
      });
      expect(r.method).toBe("symlink");
      expect((await t.env.fs.lstat(dest)).isSymbolicLink()).toBe(true);
      expect(await t.env.fs.readFile(dest)).toBe("new");
    });

    it("retains both recovery paths when replacement cleanup and rollback rename fail", async () => {
      const src = t.path("src.md");
      const dest = t.path("dest.md");
      await t.env.fs.writeFile(src, "new");
      await t.env.fs.writeFile(dest, "old");
      const baseFs = t.env.fs;
      const env = {
        ...t.env,
        fs: {
          ...baseFs,
          rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
            if (path.includes(".cellarer-before-")) {
              throw new Error("injected displaced cleanup failure");
            }
            return baseFs.rm(path, options);
          },
          rename: async (oldPath: string, newPath: string) => {
            if (oldPath.includes(".cellarer-before-") && newPath === dest) {
              throw new Error("injected rollback rename failure");
            }
            return baseFs.rename(oldPath, newPath);
          },
        },
      };

      let failure: unknown;
      try {
        await linkOrCopy(env, src, dest, {
          method: "symlink",
          kind: "file",
          replaceExisting: true,
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      const children = await t.env.fs.readdir(t.root);
      const staged = children.find((name) => name.includes(".cellarer-stage-"));
      const displaced = children.find((name) => name.includes(".cellarer-before-"));
      expect(staged).toBeDefined();
      expect(displaced).toBeDefined();
      if (!staged || !displaced || !(failure instanceof Error)) {
        throw new Error("expected retained replacement recovery paths");
      }
      const stagedPath = t.path(staged);
      const displacedPath = t.path(displaced);
      expect(await t.env.fs.readFile(stagedPath)).toBe("new");
      expect(await t.env.fs.readFile(displacedPath)).toBe("old");
      expect(failure.message).toContain(stagedPath);
      expect(failure.message).toContain(displacedPath);
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

    it("falls back to copy when a win32 file symlink fails (no Developer Mode)", async () => {
      const w = makeTmpEnv({ platform: "win32" });
      await ensureBaseDirs(w);
      try {
        const src = w.path("src.md");
        const dest = w.path("dest.md");
        await w.env.fs.writeFile(src, "content");
        // 注入:文件软链抛错(模拟 Windows 无特权/无 Developer Mode),应回退 copy。
        const realSymlink = w.env.fs.symlink.bind(w.env.fs);
        w.env.fs.symlink = async (target, path, type) => {
          if (type === "file") throw Object.assign(new Error("EPERM"), { code: "EPERM" });
          return realSymlink(target, path, type);
        };
        const r = await linkOrCopy(w.env, src, dest, { method: "symlink", kind: "file" });
        expect(r.method).toBe("copy");
        expect((await w.env.fs.lstat(dest)).isSymbolicLink()).toBe(false);
        expect(await w.env.fs.readFile(dest)).toBe("content");
      } finally {
        await w.cleanup();
      }
    });

    it("falls back to copy when a win32 directory junction fails (cross-volume/permission)", async () => {
      const w = makeTmpEnv({ platform: "win32" });
      await ensureBaseDirs(w);
      try {
        const src = w.path("srcdir");
        const dest = w.path("destdir");
        await w.env.fs.mkdir(src, { recursive: true });
        await w.env.fs.writeFile(w.path("srcdir", "a.txt"), "inside");
        // 注入:junction 抛错(模拟跨卷/权限),应回退 copy 而非抛错(§11 硬约束)。
        const realSymlink = w.env.fs.symlink.bind(w.env.fs);
        w.env.fs.symlink = async (target, path, type) => {
          if (type === "junction") throw Object.assign(new Error("EPERM"), { code: "EPERM" });
          return realSymlink(target, path, type);
        };
        const r = await linkOrCopy(w.env, src, dest, { method: "symlink", kind: "dir" });
        expect(r.method).toBe("copy");
        expect((await w.env.fs.lstat(dest)).isSymbolicLink()).toBe(false);
        expect(await w.env.fs.readFile(w.path("destdir", "a.txt"))).toBe("inside");
      } finally {
        await w.cleanup();
      }
    });
  });
});
