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
});
