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
});
