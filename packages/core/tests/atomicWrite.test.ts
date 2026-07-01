import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWrite } from "../src/fs/atomicWrite.js";
import { makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("fs/atomicWrite", () => {
  let t: TmpEnv;
  beforeEach(() => {
    t = makeTmpEnv();
  });
  afterEach(() => t.cleanup());

  it("creates parent directories and writes content", async () => {
    const p = t.path("a", "b", "c.txt");
    await atomicWrite(t.env, p, "hello");
    expect(await t.env.fs.readFile(p)).toBe("hello");
  });

  it("overwrites existing content", async () => {
    const p = t.path("x.txt");
    await atomicWrite(t.env, p, "one");
    await atomicWrite(t.env, p, "two");
    expect(await t.env.fs.readFile(p)).toBe("two");
  });

  it("leaves no stray temp files in the directory", async () => {
    const dir = t.path("d");
    const p = t.path("d", "f.txt");
    await atomicWrite(t.env, p, "x");
    const entries = await t.env.fs.readdir(dir);
    expect(entries).toEqual(["f.txt"]);
  });

  it("leaves the original target intact when the temp write fails (disk-full)", async () => {
    // 吸收参照实现 A 的故障注入角度:注入 writeFile 对临时文件抛错(模拟 ENOSPC),
    // 断言原目标文件完好、无残留临时文件(先写 tmp 再 rename 的原子性)。
    const p = t.path("keep.txt");
    const realWrite = t.env.fs.writeFile.bind(t.env.fs);
    await realWrite(p, "ORIGINAL");
    t.env.fs.writeFile = async (path, data) => {
      if (path.includes(".cellarer-tmp-")) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return realWrite(path, data);
    };
    await expect(atomicWrite(t.env, p, "NEW")).rejects.toThrow(/ENOSPC/);
    t.env.fs.writeFile = realWrite;
    // 原目标内容未被破坏(rename 未发生;失败的是 tmp 写)。
    expect(await t.env.fs.readFile(p)).toBe("ORIGINAL");
    // 目录里没有残留的 .cellarer-tmp-* 文件。
    const entries = await t.env.fs.readdir(t.path());
    expect(entries.some((e) => e.includes(".cellarer-tmp-"))).toBe(false);
  });
});
