import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertNotSymbolicLink,
  assertPathInside,
  isPathInside,
  isWithinRoot,
  relativeInside,
} from "../src/fs/safety.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("fs/safety", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  describe("isPathInside", () => {
    it("returns true for a child path", () => {
      expect(isPathInside(t.path("root", "a", "b.txt"), t.path("root"))).toBe(true);
    });
    it("returns false for the root itself", () => {
      expect(isPathInside(t.path("root"), t.path("root"))).toBe(false);
    });
    it("returns false for a sibling / traversal", () => {
      expect(isPathInside(t.path("other", "x"), t.path("root"))).toBe(false);
      expect(isPathInside(t.path("root", "..", "evil"), t.path("root"))).toBe(false);
    });
    it("returns true for a child whose first segment merely starts with '..' (e.g. ..config)", () => {
      // 回归:不能用 rel.startsWith("..") 判越界,否则 ..config 被误判在 root 外。
      expect(isPathInside(t.path("root", "..config", "rules.md"), t.path("root"))).toBe(true);
      expect(isPathInside(t.path("root", "..hidden"), t.path("root"))).toBe(true);
    });

    it("requires absolute inputs when no Env cwd is available", () => {
      expect(() => relativeInside("relative-root", "relative-root/child")).toThrow(
        /must be absolute/,
      );
    });

    it("normalizes POSIX and Windows aliases and rejects Windows cross-drive children", () => {
      expect(relativeInside("/managed/./root", "/managed/root/dir/../rule.md")).toBe("rule.md");
      expect(relativeInside("C:\\Store\\Root", "c:/store/root/dir/../rule.md")).toBe("rule.md");
      expect(relativeInside("C:\\Store\\Root", "D:\\Store\\Root\\rule.md")).toBeNull();
    });
  });

  describe("assertPathInside", () => {
    it("does not throw for a child", () => {
      expect(() => assertPathInside(t.path("root", "a"), t.path("root"), "x")).not.toThrow();
    });
    it("throws for an outside path", () => {
      expect(() => assertPathInside(t.path("evil"), t.path("root"), "target")).toThrow(/target/);
    });
  });

  describe("isWithinRoot (inclusive)", () => {
    it("returns true for a child path", () => {
      expect(isWithinRoot(t.path("root"), t.path("root", "a", "b.txt"))).toBe(true);
    });
    it("returns true for the root itself (unlike isPathInside)", () => {
      expect(isWithinRoot(t.path("root"), t.path("root"))).toBe(true);
      expect(isPathInside(t.path("root"), t.path("root"))).toBe(false);
    });
    it("returns false for a sibling / traversal", () => {
      expect(isWithinRoot(t.path("root"), t.path("other", "x"))).toBe(false);
      expect(isWithinRoot(t.path("root"), t.path("root", "..", "evil"))).toBe(false);
    });
    it("returns true for a child whose first segment merely starts with '..'", () => {
      expect(isWithinRoot(t.path("root"), t.path("root", "..config", "r.md"))).toBe(true);
    });
  });

  describe("assertNotSymbolicLink", () => {
    it("passes when the path does not exist", async () => {
      await expect(assertNotSymbolicLink(t.env, t.path("nope"))).resolves.toBeUndefined();
    });
    it("passes for a regular file", async () => {
      const p = t.path("file.txt");
      await t.env.fs.writeFile(p, "x");
      await expect(assertNotSymbolicLink(t.env, p)).resolves.toBeUndefined();
    });
    it("throws when the path is a symlink", async () => {
      const target = t.path("real.txt");
      const link = t.path("link.txt");
      await t.env.fs.writeFile(target, "x");
      await t.env.fs.symlink(target, link, "file");
      await expect(assertNotSymbolicLink(t.env, link)).rejects.toThrow(/symlink/i);
    });
  });
});
