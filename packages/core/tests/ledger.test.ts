import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TargetOwner } from "../src/model/index.js";
import { sha256 } from "../src/store/checksum.js";
import {
  addOwners,
  emptyLedger,
  loadLedger,
  loadLedgerForPlanning,
  saveLedger,
  saveLedgerAfterSelectiveRevert,
  serializeLedger,
  targetKey,
} from "../src/store/ledger.js";
import { ensureBaseDirs, FIXED_NOW, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

function sampleOwner(over: Partial<TargetOwner> = {}): TargetOwner {
  return {
    agent: "claude-code",
    scope: "global",
    capability: "rules",
    target: "/home/.claude/CLAUDE.md",
    artifactIds: ["rules/coding-style"],
    receipt: {
      method: "write",
      fingerprint: "sha256:abc",
      backup: null,
      generated: true,
      appliedAt: FIXED_NOW.toISOString(),
    },
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
    expect(led.version).toBe(2);
    expect(led.owners).toEqual([]);
  });

  it("round-trips target owners, contributing artifacts, and receipts", async () => {
    const led = addOwners(emptyLedger(), [sampleOwner()]);
    await saveLedger(t.env, storeRoot, led);
    const loaded = await loadLedger(t.env, storeRoot);
    expect(loaded.owners).toEqual([sampleOwner()]);
  });

  it("preserves secretRefs only through the exact validated durable-ledger serializer", () => {
    const ledger = addOwners(emptyLedger(), [sampleOwner({ secretRefs: ["API_KEY"] })]);

    expect(JSON.parse(serializeLedger(ledger))).toEqual(ledger);
  });

  it.each([
    [
      "near-miss secretRefs type",
      { version: 2, owners: [{ ...sampleOwner(), secretRefs: "tiny" }] },
    ],
    ["extra root key", { version: 2, owners: [sampleOwner()], extra: true }],
    ["extra owner key", { version: 2, owners: [{ ...sampleOwner(), extra: true }] }],
    [
      "extra receipt key",
      {
        version: 2,
        owners: [
          sampleOwner({
            receipt: { ...sampleOwner().receipt, secretRefs: ["NOT_ALLOWED"] } as never,
          }),
        ],
      },
    ],
  ])("rejects %s instead of broadening the durable secretRefs exception", (_label, value) => {
    expect(() => serializeLedger(value as never)).toThrow();
  });

  it("keys current ownership by normalized physical target rather than artifact", () => {
    const base = addOwners(emptyLedger(), [sampleOwner()]);
    const next = addOwners(base, [
      sampleOwner({
        target: "/home/.claude/../.claude/CLAUDE.md",
        artifactIds: ["rules/security"],
        receipt: { ...sampleOwner().receipt, fingerprint: "sha256:new" },
      }),
    ]);

    expect(next.owners).toHaveLength(1);
    expect(next.owners[0]?.artifactIds).toEqual(["rules/security"]);
    expect(next.owners[0]?.receipt.fingerprint).toBe("sha256:new");
    const [owner] = next.owners;
    expect(owner).toBeDefined();
    if (!owner) throw new Error("expected a current owner");
    expect(targetKey(owner)).toBe(targetKey(sampleOwner()));
  });

  it("keeps distinct physical targets", () => {
    const led = addOwners(emptyLedger(), [
      sampleOwner({ target: "/a" }),
      sampleOwner({ target: "/b" }),
    ]);
    expect(led.owners).toHaveLength(2);
  });

  it("rejects duplicate physical owners in version 2 state", async () => {
    const duplicate = {
      version: 2,
      owners: [
        sampleOwner(),
        sampleOwner({ target: "/home/.claude/./CLAUDE.md", artifactIds: ["rules/other"] }),
      ],
    };
    await t.env.fs.writeFile(t.path("store", "state.json"), JSON.stringify(duplicate));

    await expect(loadLedger(t.env, storeRoot)).rejects.toThrow(/duplicate physical owner/i);
  });

  it("selective recovery refuses duplicate or inexact successful owner removals", async () => {
    const duplicateA = sampleOwner();
    const duplicateB = sampleOwner({ artifactIds: ["rules/other"] });
    const unique = sampleOwner({
      agent: "codex",
      target: "/home/.codex/AGENTS.md",
      artifactIds: ["rules/codex"],
    });
    await t.env.fs.writeFile(
      t.path("store", "state.json"),
      JSON.stringify({ version: 2, owners: [duplicateA, duplicateB, unique] }),
    );
    const original = await loadLedgerForPlanning(t.env, storeRoot);

    await expect(
      saveLedgerAfterSelectiveRevert(t.env, storeRoot, original, [duplicateA]),
    ).rejects.toThrow(/cannot remove duplicate physical owner/i);
    await expect(
      saveLedgerAfterSelectiveRevert(t.env, storeRoot, original, [
        { ...unique, artifactIds: ["rules/not-the-original"] },
      ]),
    ).rejects.toThrow(/not an exact unique ledger record/i);
  });

  it("selective recovery refuses to rewrite changed duplicate evidence", async () => {
    const duplicateA = sampleOwner();
    const duplicateB = sampleOwner({ artifactIds: ["rules/other"] });
    const unique = sampleOwner({
      agent: "codex",
      target: "/home/.codex/AGENTS.md",
      artifactIds: ["rules/codex"],
    });
    const statePath = t.path("store", "state.json");
    await t.env.fs.writeFile(
      statePath,
      JSON.stringify({ version: 2, owners: [duplicateA, duplicateB, unique] }),
    );
    const original = await loadLedgerForPlanning(t.env, storeRoot);
    const changedState = JSON.stringify({
      version: 2,
      owners: [duplicateA, { ...duplicateB, artifactIds: ["rules/changed"] }, unique],
    });
    await t.env.fs.writeFile(statePath, changedState);

    await expect(
      saveLedgerAfterSelectiveRevert(t.env, storeRoot, original, [unique]),
    ).rejects.toThrow(/state changed after revert planning/i);
    expect(await t.env.fs.readFile(statePath)).toBe(changedState);
  });

  it("rejects ambiguous legacy state with an explicit pre-release reset requirement", async () => {
    const legacyEntry = {
      artifact: "mcp/alpha",
      agent: "codex",
      scope: "global",
      capability: "mcp",
      target: "/home/.codex/config.toml",
      method: "write",
      checksum: "sha256:old",
      backup: null,
      generated: false,
      appliedAt: FIXED_NOW.toISOString(),
    };
    await t.env.fs.writeFile(
      t.path("store", "state.json"),
      JSON.stringify({
        version: 1,
        entries: [legacyEntry, { ...legacyEntry, artifact: "mcp/beta" }],
      }),
    );

    await expect(loadLedger(t.env, storeRoot)).rejects.toThrow(/legacy.*reset/i);
  });

  it("rejects a malformed state.json with an actionable message", async () => {
    await t.env.fs.writeFile(t.path("store", "state.json"), `{"version": 99}`);
    await expect(loadLedger(t.env, storeRoot)).rejects.toThrow(/corrupt ledger/);
  });

  it("rejects non-JSON state.json with an actionable message (not a raw SyntaxError stack)", async () => {
    await t.env.fs.writeFile(t.path("store", "state.json"), `{not json`);
    await expect(loadLedger(t.env, storeRoot)).rejects.toThrow(/corrupt ledger at .*state\.json/);
  });
});
