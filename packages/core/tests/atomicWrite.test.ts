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

  it("leaves the original target intact and cleans up the temp file when the write fails (disk-full)", async () => {
    // 吸收参照实现 A 的故障注入角度,并真实创建半截临时文件:让 tmp 写入「先落盘再抛」(模拟
    // ENOSPC 写到一半),断言原目标完好 + 临时文件被清理(atomicWrite 失败路径 unlink)。
    const p = t.path("keep.txt");
    const realWrite = t.env.fs.writeFile.bind(t.env.fs);
    await realWrite(p, "ORIGINAL");
    t.env.fs.writeFile = async (path, data) => {
      if (path.includes(".cellarer-tmp-")) {
        await realWrite(path, data); // 真实创建半截临时文件
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return realWrite(path, data);
    };
    await expect(atomicWrite(t.env, p, "NEW")).rejects.toThrow(/ENOSPC/);
    t.env.fs.writeFile = realWrite;
    // 原目标内容未被破坏(rename 未发生)。
    expect(await t.env.fs.readFile(p)).toBe("ORIGINAL");
    // 半截临时文件已被失败路径清理,无残留 .cellarer-tmp-*。
    const entries = await t.env.fs.readdir(t.path());
    expect(entries.some((e) => e.includes(".cellarer-tmp-"))).toBe(false);
  });
});
