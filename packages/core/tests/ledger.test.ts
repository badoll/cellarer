import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LedgerEntry } from "../src/model/index.js";
import { sha256 } from "../src/store/checksum.js";
import { addEntries, emptyLedger, loadLedger, saveLedger } from "../src/store/ledger.js";
import { ensureBaseDirs, FIXED_NOW, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

function sampleEntry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    artifact: "rules/coding-style",
    agent: "claude-code",
    scope: "global",
    capability: "rules",
    target: "/home/.claude/CLAUDE.md",
    method: "write",
    checksum: "sha256:abc",
    backup: null,
    generated: true,
    appliedAt: FIXED_NOW.toISOString(),
    ...over,
  };
}

describe("store/checksum", () => {
  it("produces a stable sha256:<hex> digest", () => {
    expect(sha256("hello")).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
  it("differs for different content", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });
});

describe("store/ledger", () => {
  let t: TmpEnv;
  let storeRoot: string;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("store");
    await t.env.fs.mkdir(storeRoot, { recursive: true });
  });
  afterEach(() => t.cleanup());

  it("returns an empty ledger when state.json is absent", async () => {
    const led = await loadLedger(t.env, storeRoot);
    expect(led).toEqual(emptyLedger());
    expect(led.version).toBe(1);
    expect(led.entries).toEqual([]);
  });

  it("round-trips entries through save/load", async () => {
    const led = addEntries(emptyLedger(), [sampleEntry()]);
    await saveLedger(t.env, storeRoot, led);
    const loaded = await loadLedger(t.env, storeRoot);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0]?.target).toBe("/home/.claude/CLAUDE.md");
  });

  it("addEntries replaces entries with the same (artifact, agent, scope, target)", () => {
    const base = addEntries(emptyLedger(), [sampleEntry({ checksum: "sha256:old" })]);
    const next = addEntries(base, [sampleEntry({ checksum: "sha256:new" })]);
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]?.checksum).toBe("sha256:new");
  });

  it("addEntries keeps distinct targets", () => {
    const led = addEntries(emptyLedger(), [
      sampleEntry({ target: "/a" }),
      sampleEntry({ target: "/b" }),
    ]);
    expect(led.entries).toHaveLength(2);
  });

  it("rejects a malformed state.json", async () => {
    await t.env.fs.writeFile(t.path("store", "state.json"), `{"version": 99}`);
    await expect(loadLedger(t.env, storeRoot)).rejects.toThrow();
  });
});
