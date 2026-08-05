import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRealEnv } from "../src/index.js";
import { ensureBaseDirs, FIXED_NOW, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("test base (fake Env via tmpdir)", () => {
  let t: TmpEnv;
  beforeEach(() => {
    t = makeTmpEnv();
  });
  afterEach(() => t.cleanup());

  it("provides isolated tmp root with injectable now/platform/env", () => {
    expect(t.env.now()).toEqual(FIXED_NOW);
    expect(t.env.platform).toBe("darwin");
    expect(t.env.homedir().startsWith(t.root)).toBe(true);
    expect(t.env.cwd().startsWith(t.root)).toBe(true);
  });

  it("can read/write files through injected fs", async () => {
    await ensureBaseDirs(t);
    const p = t.path("home", "hello.txt");
    await t.env.fs.writeFile(p, "hi");
    expect(await t.env.fs.readFile(p)).toBe("hi");
  });
});

describe("createRealEnv", () => {
  it("exposes platform/homedir/cwd/now", () => {
    const env = createRealEnv();
    expect(typeof env.homedir()).toBe("string");
    expect(typeof env.cwd()).toBe("string");
    expect(env.now() instanceof Date).toBe(true);
    expect(typeof env.platform).toBe("string");
  });

  it("probes the current Node process as alive and invalid PIDs as unknown", async () => {
    const env = createRealEnv();

    await expect(env.probeProcessLiveness(env.processId())).resolves.toBe("alive");
    await expect(env.probeProcessLiveness(0)).resolves.toBe("unknown");
  });

  it("keeps captured bytes bound to opened handles and rejects a replaced root on revalidation", async () => {
    const t = makeTmpEnv();
    await ensureBaseDirs(t);
    try {
      const source = t.path("source");
      const displaced = t.path("source-before");
      await t.env.fs.mkdir(t.path("source", "nested"), { recursive: true });
      await t.env.fs.writeFile(t.path("source", "nested", "value.txt"), "original");

      const snapshot = await t.env.fs.snapshotTreeNoFollow(source);
      await t.env.fs.rename(source, displaced);
      await t.env.fs.mkdir(source, { recursive: true });
      await t.env.fs.writeFile(t.path("source", "replacement.txt"), "replacement");

      const captured = snapshot.nodes.find((node) => node.relativePath === "nested/value.txt");
      expect(new TextDecoder().decode(captured?.data)).toBe("original");
      await expect(t.env.fs.verifyTreeSnapshot(snapshot)).resolves.toBe(false);
    } finally {
      await t.cleanup();
    }
  });
});
