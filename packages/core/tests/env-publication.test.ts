import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("Env exclusive lock and durable publication primitives", () => {
  let t: TmpEnv;

  beforeEach(async () => {
    t = makeTmpEnv();
    await t.env.fs.mkdir(t.path("store"), { recursive: true });
  });

  afterEach(() => t.cleanup());

  it("creates a lock file exclusively without replacing owner evidence", async () => {
    const lockPath = t.path("store", "mutation.lock");

    await expect(t.env.fs.writeFileExclusive(lockPath, "owner-one\n")).resolves.toBe(true);
    await expect(t.env.fs.writeFileExclusive(lockPath, "owner-two\n")).resolves.toBe(false);
    await expect(t.env.fs.readFile(lockPath)).resolves.toBe("owner-one\n");
  });

  it("atomically publishes and replaces durable content", async () => {
    const statePath = t.path("store", "state.json");
    await t.env.fs.writeFile(statePath, "old\n");

    await t.env.fs.publishFileAtomically(statePath, "new\n");

    await expect(t.env.fs.readFile(statePath)).resolves.toBe("new\n");
    await expect(t.env.fs.readdir(t.path("store"))).resolves.toEqual(["state.json"]);
  });
});
