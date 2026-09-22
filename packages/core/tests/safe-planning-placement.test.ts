import { Buffer } from "node:buffer";
import { basename, join } from "node:path";
import { Encrypter } from "age-encryption";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apply } from "../src/engine/apply.js";
import { plan } from "../src/engine/plan.js";
import { planRevert, revert } from "../src/engine/revert.js";
import { status } from "../src/engine/status.js";
import { loadConfig, saveConfig } from "../src/store/config.js";
import { loadLedger, saveLedger } from "../src/store/ledger.js";
import {
  importSkillArtifact,
  initStore,
  writeMcpArtifact,
  writeRuleArtifact,
} from "../src/store/store.js";
import { decryptTargetSnapshot } from "../src/target-snapshot.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const SNAPSHOT_PASSPHRASE = "snapshot-test-passphrase";
const UNMANAGED_SECRET = "ghp_unmanaged_plaintext_0123456789abcdef";

describe("safe target planning and placement", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await t.cleanup();
  });

  async function addSkill(name: string, content: string): Promise<void> {
    const source = t.path("sources", name);
    await t.env.fs.mkdir(source, { recursive: true });
    await t.env.fs.writeFile(t.path("sources", name, "SKILL.md"), content);
    await importSkillArtifact(t.env, storeRoot, name, source);
  }

  async function readStoredText(path = storeRoot): Promise<string> {
    const stat = await t.env.fs.lstat(path);
    if (stat.isFile()) return t.env.fs.readFile(path);
    if (!stat.isDirectory()) return "";
    const children = await t.env.fs.readdir(path);
    return (await Promise.all(children.map((child) => readStoredText(join(path, child))))).join(
      "\n",
    );
  }

  it("emits one target-keyed Rules, MCP, and Skill action with ownership evidence", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await writeMcpArtifact(t.env, storeRoot, "context", { kind: "stdio", command: "npx" });
    await addSkill("demo", "# demo");

    const result = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["rules", "mcp", "skills"],
    });

    const actions = result.actions.filter((action) => action.op !== "skip");
    expect(actions).toHaveLength(3);
    expect(new Set(actions.map((action) => action.ownership?.key)).size).toBe(3);
    expect(actions.map((action) => action.ownership?.classification)).toEqual([
      "absent",
      "absent",
      "absent",
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("updates one aggregate MCP owner when the selected artifacts change", async () => {
    await writeMcpArtifact(t.env, storeRoot, "alpha", { kind: "stdio", command: "alpha" });
    await writeMcpArtifact(t.env, storeRoot, "beta", { kind: "stdio", command: "beta" });
    const config = await loadConfig(t.env, storeRoot);
    config.collections.alpha = { description: "alpha fixture" };
    config.collections.beta = { description: "beta fixture" };
    config.artifacts["mcp/alpha"] = { collections: ["alpha"] };
    config.artifacts["mcp/beta"] = { collections: ["beta"] };
    await saveConfig(t.env, storeRoot, config);

    const base = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["mcp" as const],
      mcpStrategy: "overwrite" as const,
    };
    await apply(t.env, { ...base, collections: ["alpha"] });
    const firstLedger = await loadLedger(t.env, storeRoot);
    expect(firstLedger.owners).toHaveLength(1);
    expect(firstLedger.owners[0]?.artifactIds).toEqual(["mcp/alpha"]);

    const second = await apply(t.env, { ...base, collections: ["beta"] });
    expect(second.plan.actions).toHaveLength(1);
    expect(second.plan.actions[0]?.ownership?.classification).toBe("owned-current");
    expect(second.entries[0]?.artifactIds).toEqual(["mcp/beta"]);

    const target = t.path("home", ".claude.json");
    const rendered = JSON.parse(await t.env.fs.readFile(target));
    expect(Object.keys(rendered.mcpServers)).toEqual(["beta"]);
    const secondLedger = await loadLedger(t.env, storeRoot);
    expect(secondLedger.owners).toHaveLength(1);
    expect(secondLedger.owners[0]).toMatchObject({
      target,
      artifactIds: ["mcp/beta"],
      receipt: { backup: null },
    });
  });

  it("hides an ownership-blocked MCP merge preview derived from existing secret fields", async () => {
    await writeMcpArtifact(t.env, storeRoot, "managed", { kind: "stdio", command: "managed" });
    const target = t.path("home", ".claude.json");
    const existing = JSON.stringify({
      password: "ordinary-password",
      mcpServers: {
        existing: {
          command: "existing",
          metadata: { credentials: { token: "nested-ordinary-token" } },
        },
      },
    });
    await t.env.fs.mkdir(t.path("home", ".claude"), { recursive: true });
    await t.env.fs.writeFile(target, existing);

    const blocked = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["mcp"],
    });

    expect(blocked.actions[0]).toMatchObject({
      op: "skip",
      ownership: {
        classification: "unowned-existing",
        currentFingerprint: expect.stringMatching(/^sha256:/),
      },
    });
    expect(blocked.actions[0]?.preview).toBeUndefined();
    expect(JSON.stringify(blocked)).not.toContain("ordinary-password");
    expect(JSON.stringify(blocked)).not.toContain("nested-ordinary-token");
  });

  it("blocks an unmanaged same-named Skill until its exact replacement is approved", async () => {
    await addSkill("demo", "# managed");
    const target = t.path("home", ".claude", "skills", "demo");
    await t.env.fs.mkdir(target, { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".claude", "skills", "demo", "SKILL.md"),
      UNMANAGED_SECRET,
    );

    const blocked = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["skills"],
    });
    const conflict = blocked.conflicts[0];
    expect(blocked.actions[0]).toMatchObject({
      op: "skip",
      ownership: { classification: "unowned-existing", target },
    });
    expect(conflict).toMatchObject({
      code: "UNOWNED_TARGET",
      target,
      acknowledgement: { kind: "replace-unowned" },
    });
    if (!conflict?.acknowledgement) throw new Error("expected replacement acknowledgement");

    const ordinary = await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["skills"],
    });
    expect(ordinary.entries).toEqual([]);
    expect(await t.env.fs.readFile(t.path("home", ".claude", "skills", "demo", "SKILL.md"))).toBe(
      UNMANAGED_SECRET,
    );

    const wrongInput = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["skills"],
      replaceUnowned: ["sha256:wrong-target-receipt"],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });
    expect(wrongInput.actions[0]?.op).toBe("skip");

    const missingEncryption = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["skills"],
      replaceUnowned: [conflict.acknowledgement.token],
    });
    expect(missingEncryption.conflicts[0]?.code).toBe("SNAPSHOT_ENCRYPTION_REQUIRED");

    const approved = await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["skills"],
      replaceUnowned: [conflict.acknowledgement.token],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });

    expect(approved.failures).toEqual([]);
    expect(approved.entries).toHaveLength(1);
    expect(await t.env.fs.readFile(t.path("home", ".claude", "skills", "demo", "SKILL.md"))).toBe(
      "# managed",
    );
    const ledger = await loadLedger(t.env, storeRoot);
    const snapshotPath = ledger.owners[0]?.receipt.backup;
    expect(snapshotPath).toMatch(/snapshots[/\\].+\.age$/);
    if (!snapshotPath) throw new Error("expected encrypted snapshot path");
    const encrypted = await t.env.fs.readFile(snapshotPath);
    expect(encrypted).toContain("BEGIN AGE ENCRYPTED FILE");
    expect(encrypted).not.toContain(UNMANAGED_SECRET);
    expect(JSON.stringify(ledger)).not.toContain(UNMANAGED_SECRET);
    expect(JSON.stringify(approved.plan)).not.toContain(UNMANAGED_SECRET);
    expect((await t.env.fs.lstat(t.path("home", ".cellarer", "snapshots"))).mode & 0o777).toBe(
      0o700,
    );
    expect((await t.env.fs.lstat(snapshotPath)).mode & 0o777).toBe(0o600);

    const snapshot = await decryptTargetSnapshot(encrypted, SNAPSHOT_PASSPHRASE);
    const skillFile = snapshot.entries.find((entry) => entry.path === "SKILL.md");
    expect(skillFile?.kind).toBe("file");
    if (skillFile?.kind !== "file") throw new Error("expected snapshotted Skill file");
    expect(Buffer.from(skillFile.data, "base64").toString("utf8")).toBe(UNMANAGED_SECRET);
  }, 30_000);

  it("refuses replacement when the snapshot root is a symlink to an external directory", async () => {
    await addSkill("demo", "# managed");
    const target = t.path("home", ".claude", "skills", "demo");
    const original = join(target, "SKILL.md");
    await t.env.fs.mkdir(target, { recursive: true });
    await t.env.fs.writeFile(original, UNMANAGED_SECRET);

    const options = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["skills" as const],
    };
    const token = (await plan(t.env, options)).conflicts[0]?.acknowledgement?.token;
    if (!token) throw new Error("expected replacement acknowledgement");

    const ledgerBefore = await loadLedger(t.env, storeRoot);
    await saveLedger(t.env, storeRoot, ledgerBefore);
    const statePath = join(storeRoot, "state.json");
    const stateBefore = await t.env.fs.readFile(statePath);
    const outside = t.path("outside-snapshots");
    await t.env.fs.mkdir(outside, { recursive: true });
    await t.env.fs.symlink(outside, join(storeRoot, "snapshots"), "dir");

    const result = await apply(t.env, {
      ...options,
      replaceUnowned: [token],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });

    expect(result.entries).toEqual([]);
    expect(result.failures).toMatchObject([{ code: "SNAPSHOT_FAILED", target }]);
    expect(await t.env.fs.readFile(original)).toBe(UNMANAGED_SECRET);
    expect(await t.env.fs.readFile(statePath)).toBe(stateBefore);
    expect(await t.env.fs.readdir(outside)).toEqual([]);
  });

  it("refuses a canonical snapshot root outside the canonical store root", async () => {
    await addSkill("demo", "# managed");
    const target = t.path("home", ".claude", "skills", "demo");
    const original = join(target, "SKILL.md");
    await t.env.fs.mkdir(target, { recursive: true });
    await t.env.fs.writeFile(original, UNMANAGED_SECRET);
    const options = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["skills" as const],
    };
    const token = (await plan(t.env, options)).conflicts[0]?.acknowledgement?.token;
    if (!token) throw new Error("expected replacement acknowledgement");

    const snapshotsRoot = join(storeRoot, "snapshots");
    const outside = t.path("outside-snapshots");
    await t.env.fs.mkdir(outside, { recursive: true });
    const baseFs = t.env.fs;
    const env = {
      ...t.env,
      fs: {
        ...baseFs,
        realpath: async (path: string) =>
          path === snapshotsRoot ? outside : baseFs.realpath(path),
      },
    };

    const result = await apply(env, {
      ...options,
      replaceUnowned: [token],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });

    expect(result.entries).toEqual([]);
    expect(result.failures).toMatchObject([{ code: "SNAPSHOT_FAILED", target }]);
    expect(result.failures[0]?.message).toContain("resolves outside snapshot store root");
    expect(await t.env.fs.readFile(original)).toBe(UNMANAGED_SECRET);
    expect((await loadLedger(t.env, storeRoot)).owners).toEqual([]);
    expect(await t.env.fs.readdir(outside)).toEqual([]);
    expect(await t.env.fs.readdir(snapshotsRoot)).toEqual([]);
  });

  // This real transaction must finish before fixture teardown; Vitest timeouts do not cancel it.
  it("keeps a generated target generated across repeated drift overrides", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# managed");
    const opts = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["rules" as const],
    };
    await apply(t.env, opts);
    const target = t.path("home", ".claude", "CLAUDE.md");
    for (const edit of ["first drift", "second drift"]) {
      await t.env.fs.writeFile(target, edit);
      const blocked = await plan(t.env, opts);
      const token = blocked.conflicts[0]?.acknowledgement?.token;
      if (!token) throw new Error("expected drift acknowledgement");

      const approved = await apply(t.env, {
        ...opts,
        overrideDrift: [token],
        snapshotPassphrase: SNAPSHOT_PASSPHRASE,
      });
      expect(approved.entries).toHaveLength(1);
      expect((await loadLedger(t.env, storeRoot)).owners[0]?.receipt).toMatchObject({
        backup: null,
        generated: true,
      });
    }

    const retainedSnapshots = await t.env.fs.readdir(join(storeRoot, "snapshots"));
    expect(retainedSnapshots).toHaveLength(2);
    const reverted = await revert(t.env, { storeRoot, agents: ["claude-code"] });
    expect(reverted.reverted).toHaveLength(1);
    await expect(t.env.fs.lstat(target)).rejects.toThrow();
    expect(await t.env.fs.readdir(join(storeRoot, "snapshots"))).toEqual(retainedSnapshots);
  }, 30_000);

  // This real transaction must finish before fixture teardown; Vitest timeouts do not cancel it.
  it("never deletes a transient apply snapshot after an ancestor swap at commit", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# managed");
    const opts = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["rules" as const],
    };
    await apply(t.env, opts);
    const target = t.path("home", ".claude", "CLAUDE.md");
    await t.env.fs.writeFile(target, "drift before override");
    const token = (await plan(t.env, opts)).conflicts[0]?.acknowledgement?.token;
    if (!token) throw new Error("expected drift acknowledgement");
    const snapshotsRoot = join(storeRoot, "snapshots");
    const retainedRoot = t.path("retained-apply-snapshots");
    const outsideRoot = t.path("outside-apply-same-name");
    const revisionPath = join(storeRoot, "revision.json");
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    const rm = t.env.fs.rm;
    let swappedName: string | undefined;
    let snapshotRmCalls = 0;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path: string, data: string, mode?: { mode?: number }) => {
          await publishFileAtomically(path, data, mode);
          if (!swappedName && path === revisionPath) {
            [swappedName] = await t.env.fs.readdir(snapshotsRoot);
            if (!swappedName) throw new Error("expected transient apply snapshot");
            await t.env.fs.rename(snapshotsRoot, retainedRoot);
            await t.env.fs.mkdir(outsideRoot, { recursive: true });
            await t.env.fs.writeFile(join(outsideRoot, swappedName), "external same-name snapshot");
            await t.env.fs.symlink(outsideRoot, snapshotsRoot, "dir");
          }
        },
        rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
          if (path.startsWith(`${snapshotsRoot}/`)) snapshotRmCalls += 1;
          await rm(path, options);
        },
      },
    };

    const result = await apply(env, {
      ...opts,
      overrideDrift: [token],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });

    expect(result.failures).toEqual([]);
    expect(snapshotRmCalls).toBe(0);
    if (!swappedName) throw new Error("expected snapshot ancestor swap");
    await expect(t.env.fs.readFile(join(outsideRoot, swappedName))).resolves.toBe(
      "external same-name snapshot",
    );
    await expect(t.env.fs.readFile(join(retainedRoot, swappedName))).resolves.toContain(
      "BEGIN AGE ENCRYPTED FILE",
    );
  }, 30_000);

  it("preserves the original unmanaged baseline across repeated drift overrides", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# managed");
    const target = t.path("home", ".claude", "CLAUDE.md");
    await t.env.fs.mkdir(t.path("home", ".claude"), { recursive: true });
    await t.env.fs.writeFile(target, "original unmanaged content");
    const opts = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["rules" as const],
    };
    const replacement = await plan(t.env, opts);
    const replacementToken = replacement.conflicts[0]?.acknowledgement?.token;
    if (!replacementToken) throw new Error("expected replacement acknowledgement");
    await apply(t.env, {
      ...opts,
      replaceUnowned: [replacementToken],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });
    const baseline = (await loadLedger(t.env, storeRoot)).owners[0]?.receipt.backup;
    if (!baseline) throw new Error("expected original recovery baseline");

    for (const edit of ["first drift", "second drift"]) {
      await t.env.fs.writeFile(target, edit);
      const drift = await plan(t.env, opts);
      const token = drift.conflicts[0]?.acknowledgement?.token;
      if (!token) throw new Error("expected drift acknowledgement");
      await apply(t.env, {
        ...opts,
        overrideDrift: [token],
        snapshotPassphrase: SNAPSHOT_PASSPHRASE,
      });
      expect((await loadLedger(t.env, storeRoot)).owners[0]?.receipt.backup).toBe(baseline);
    }

    const retainedSnapshots = await t.env.fs.readdir(join(storeRoot, "snapshots"));
    expect(retainedSnapshots).toHaveLength(3);
    expect(retainedSnapshots).toContain(basename(baseline));
    const reverted = await revert(t.env, {
      storeRoot,
      agents: ["claude-code"],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });
    expect(reverted.reverted).toHaveLength(1);
    expect(await t.env.fs.readFile(target)).toBe("original unmanaged content");
    expect(await t.env.fs.readdir(join(storeRoot, "snapshots"))).toEqual(retainedSnapshots);
  }, 10_000);

  it("retains the drift recovery snapshot when the owner receipt cannot be saved", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# managed");
    const opts = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["rules" as const],
    };
    await apply(t.env, opts);
    const target = t.path("home", ".claude", "CLAUDE.md");
    const statePath = join(storeRoot, "state.json");
    const stateBefore = await t.env.fs.readFile(statePath);
    await t.env.fs.writeFile(target, "drift that needs recovery");
    const token = (await plan(t.env, opts)).conflicts[0]?.acknowledgement?.token;
    if (!token) throw new Error("expected drift acknowledgement");
    const baseFs = t.env.fs;
    const env = {
      ...t.env,
      fs: {
        ...baseFs,
        publishFileAtomically: async (
          path: string,
          data: string,
          publishOpts?: { mode?: number },
        ) => {
          if (path === statePath) throw new Error("injected state save failure");
          return baseFs.publishFileAtomically(path, data, publishOpts);
        },
      },
    };

    await expect(
      apply(env, {
        ...opts,
        overrideDrift: [token],
        snapshotPassphrase: SNAPSHOT_PASSPHRASE,
      }),
    ).rejects.toThrow(/injected state save failure/);
    expect(await t.env.fs.readFile(statePath)).toBe(stateBefore);
    const recoveryAssets = await t.env.fs.readdir(join(storeRoot, "snapshots"));
    expect(recoveryAssets).toHaveLength(1);
    await expect(
      t.env.fs.readFile(join(storeRoot, "snapshots", recoveryAssets[0] ?? "")),
    ).resolves.toContain("BEGIN AGE ENCRYPTED FILE");
  });

  it("does not let one invalid adapter target block another legal action", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# managed");
    const outside = t.path("outside");
    await t.env.fs.mkdir(outside, { recursive: true });
    await t.env.fs.symlink(outside, t.path("home", ".claude"), "dir");
    const options = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code", "codex"],
      capabilities: ["rules" as const],
    };

    const preview = await plan(t.env, options);
    expect(preview.invalidLedger).toBeUndefined();
    expect(preview.conflicts).toContainEqual(
      expect.objectContaining({
        code: "INVALID_TARGET_OWNER",
        target: t.path("home", ".claude", "CLAUDE.md"),
      }),
    );
    expect(preview.actions.find((action) => action.agent === "codex")).toMatchObject({
      op: "write",
      ownership: { classification: "absent" },
    });

    const result = await apply(t.env, options);
    expect(result.entries.map((entry) => entry.agent)).toEqual(["codex"]);
    expect(await t.env.fs.readFile(t.path("home", ".codex", "AGENTS.md"))).toContain("# managed");
    await expect(t.env.fs.lstat(join(outside, "CLAUDE.md"))).rejects.toThrow();
  });

  it("leaves target and store unchanged when snapshot encryption fails", async () => {
    await addSkill("demo", "# managed");
    const target = t.path("home", ".claude", "skills", "demo");
    await t.env.fs.mkdir(target, { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".claude", "skills", "demo", "SKILL.md"),
      UNMANAGED_SECRET,
    );

    const blocked = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["skills"],
    });
    const token = blocked.conflicts[0]?.acknowledgement?.token;
    if (!token) throw new Error("expected replacement acknowledgement");

    vi.spyOn(Encrypter.prototype, "encrypt").mockRejectedValueOnce(
      new Error("injected snapshot encryption failure"),
    );

    const result = await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["skills"],
      replaceUnowned: [token],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });

    expect(result.entries).toEqual([]);
    expect(result.failures).toMatchObject([{ code: "SNAPSHOT_FAILED", target }]);
    expect(result.failures[0]?.message).toContain("injected snapshot encryption failure");
    expect(await t.env.fs.readFile(t.path("home", ".claude", "skills", "demo", "SKILL.md"))).toBe(
      UNMANAGED_SECRET,
    );
    expect((await loadLedger(t.env, storeRoot)).owners).toEqual([]);
    expect(JSON.stringify(result.plan)).not.toContain(UNMANAGED_SECRET);
    expect(await readStoredText()).not.toContain(UNMANAGED_SECRET);
    await expect(t.env.fs.lstat(t.path("home", ".cellarer", "snapshots"))).rejects.toThrow();
  });

  it("blocks both apply planning and revert when a copied Skill node mode drifts", async () => {
    await addSkill("demo", "# managed");
    const options = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["skills" as const],
      method: "copy" as const,
    };
    const applied = await apply(t.env, options);
    expect(applied.entries).toHaveLength(1);
    const target = t.path("home", ".claude", "skills", "demo", "SKILL.md");
    await t.env.fs.chmod(target, 0o600);

    const applyPreview = await plan(t.env, options);
    expect(applyPreview.conflicts[0]).toMatchObject({
      code: "OWNED_TARGET_DRIFTED",
      ownership: { classification: "owned-drifted" },
    });
    const revertPreview = await planRevert(t.env, { storeRoot, agents: ["claude-code"] });
    expect(revertPreview.conflicts[0]).toMatchObject({
      code: "REVERT_TARGET_DRIFTED",
      ownership: { classification: "owned-drifted" },
    });
  });

  it("uses one top-level symlink fingerprint across apply, plan, status, and revert", async () => {
    await addSkill("demo", "# managed");
    const options = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["skills" as const],
    };
    const applied = await apply(t.env, options);
    const owner = applied.entries[0];
    if (!owner) throw new Error("expected applied Skill owner");
    const target = t.path("home", ".claude", "skills", "demo");
    const originalSource = t.path("home", ".cellarer", "store", "skills", "demo");
    const sameContentSource = t.path("same-content", "demo");
    await t.env.fs.cp(originalSource, sameContentSource, { recursive: true });

    const initial = await plan(t.env, options);
    expect(initial.actions[0]?.ownership).toMatchObject({
      classification: "owned-current",
      currentFingerprint: owner.receipt.fingerprint,
    });
    expect((await status(t.env, { storeRoot }))[0]?.status).toBe("ok");
    expect((await planRevert(t.env, { storeRoot })).targets[0]).toMatchObject({
      blocked: false,
      ownership: { classification: "owned-current" },
    });

    await t.env.fs.rm(target, { recursive: true, force: true });
    await t.env.fs.symlink(sameContentSource, target, "dir");

    expect((await plan(t.env, options)).conflicts[0]).toMatchObject({
      code: "OWNED_TARGET_DRIFTED",
      ownership: { classification: "owned-drifted" },
    });
    expect((await status(t.env, { storeRoot }))[0]?.status).toBe("drifted");
    expect((await planRevert(t.env, { storeRoot })).conflicts[0]).toMatchObject({
      code: "REVERT_TARGET_DRIFTED",
      ownership: { classification: "owned-drifted" },
    });
  });

  // Vitest does not cancel the asynchronous transaction or fixture teardown when a case times out.
  it.each([
    false,
    true,
  ])("restores an unmanaged root symlink after referent drift and honors keepBackups=%s", async (keepBackups) => {
    await addSkill("demo", "# managed");
    const options = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["skills" as const],
    };
    const target = t.path("home", ".claude", "skills", "demo");
    const externalReferent = t.path("external", "demo");
    await t.env.fs.mkdir(externalReferent, { recursive: true });
    await t.env.fs.writeFile(join(externalReferent, "SKILL.md"), "# unmanaged original");
    await t.env.fs.mkdir(t.path("home", ".claude", "skills"), { recursive: true });
    await t.env.fs.symlink(externalReferent, target, "dir");
    const originalLinkTarget = await t.env.fs.readlink(target);
    const originalMode = (await t.env.fs.lstat(target)).mode & 0o7777;

    const blocked = await plan(t.env, options);
    expect(blocked.conflicts[0]).toMatchObject({
      code: "UNOWNED_TARGET",
      ownership: { classification: "unowned-existing" },
    });
    const replacement = blocked.conflicts[0]?.acknowledgement?.token;
    if (!replacement) throw new Error("expected replacement acknowledgement");

    const applied = await apply(t.env, {
      ...options,
      replaceUnowned: [replacement],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });
    expect(applied.failures).toEqual([]);
    const snapshotPath = applied.entries[0]?.receipt.backup;
    if (!snapshotPath) throw new Error("expected root symlink snapshot");

    await t.env.fs.writeFile(join(externalReferent, "SKILL.md"), "# unmanaged referent drift");
    await t.env.fs.writeFile(
      join(storeRoot, "store", "skills", "demo", "SKILL.md"),
      "# managed referent drift",
    );

    expect((await plan(t.env, options)).conflicts[0]).toMatchObject({
      code: "OWNED_TARGET_DRIFTED",
      ownership: { classification: "owned-drifted" },
    });
    expect((await status(t.env, { storeRoot }))[0]?.status).toBe("drifted");
    const revertPreview = await planRevert(t.env, { storeRoot });
    expect(revertPreview.conflicts[0]).toMatchObject({
      code: "REVERT_TARGET_DRIFTED",
      ownership: { classification: "owned-drifted" },
    });
    const driftAcknowledgement = revertPreview.targets[0]?.acknowledgement?.token;
    if (!driftAcknowledgement) throw new Error("expected revert drift acknowledgement");

    const restored = await revert(t.env, {
      storeRoot,
      acknowledgements: [driftAcknowledgement],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
      keepBackups,
    });

    expect(restored.failures).toEqual([]);
    expect(restored.reverted).toHaveLength(1);
    expect(await t.env.fs.readlink(target)).toBe(originalLinkTarget);
    expect((await t.env.fs.lstat(target)).mode & 0o7777).toBe(originalMode);
    expect(await t.env.fs.readFile(join(target, "SKILL.md"))).toBe("# unmanaged referent drift");
    expect((await loadLedger(t.env, storeRoot)).owners).toEqual([]);
    await expect(t.env.fs.readFile(snapshotPath)).resolves.toContain("BEGIN AGE ENCRYPTED FILE");
    if (!keepBackups) {
      expect(restored.warnings).toContainEqual(
        expect.stringContaining("automatic snapshot deletion is unsupported"),
      );
    }
  }, 30_000);

  it("records a new receipt without changing recovery baseline when approved symlink drift keeps the same link", async () => {
    await addSkill("demo", "# original");
    const options = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["skills" as const],
    };
    const first = await apply(t.env, options);
    const firstOwner = first.entries[0];
    if (!firstOwner) throw new Error("expected initial Skill owner");

    const target = t.path("home", ".claude", "skills", "demo");
    const sourceFile = t.path("home", ".cellarer", "store", "skills", "demo", "SKILL.md");
    const linkTarget = await t.env.fs.readlink(target);
    await t.env.fs.writeFile(sourceFile, "# changed through the same source path");

    const blocked = await plan(t.env, options);
    const acknowledgement = blocked.conflicts[0]?.acknowledgement;
    expect(blocked.conflicts[0]).toMatchObject({
      code: "OWNED_TARGET_DRIFTED",
      ownership: { classification: "owned-drifted" },
    });
    if (!acknowledgement) throw new Error("expected drift acknowledgement");

    const replaced = await apply(t.env, {
      ...options,
      overrideDrift: [acknowledgement.token],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });
    const replacedOwner = replaced.entries[0];
    if (!replacedOwner) throw new Error("expected replacement Skill owner");
    expect(await t.env.fs.readlink(target)).toBe(linkTarget);
    expect(replacedOwner.artifactIds).toEqual(firstOwner.artifactIds);
    expect(replacedOwner.receipt.fingerprint).not.toBe(firstOwner.receipt.fingerprint);
    expect(replacedOwner.receipt.backup).toBeNull();
    expect(await t.env.fs.readdir(join(storeRoot, "snapshots"))).toHaveLength(1);

    expect((await plan(t.env, options)).actions[0]?.ownership).toMatchObject({
      classification: "owned-current",
      currentFingerprint: replacedOwner.receipt.fingerprint,
    });
    expect((await status(t.env, { storeRoot }))[0]?.status).toBe("ok");
    expect((await planRevert(t.env, { storeRoot })).targets[0]).toMatchObject({
      blocked: false,
      ownership: {
        classification: "owned-current",
        currentFingerprint: replacedOwner.receipt.fingerprint,
      },
      snapshot: { status: "none", path: null },
    });

    const reverted = await revert(t.env, {
      storeRoot,
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });
    expect(reverted.failures).toEqual([]);
    expect(reverted.reverted).toHaveLength(1);
    expect((await loadLedger(t.env, storeRoot)).owners).toEqual([]);
    await expect(t.env.fs.lstat(target)).rejects.toThrow();
  });

  it("preserves an unmanaged Skill and retains its encrypted snapshot when staged copy fails", async () => {
    await addSkill("demo", "# managed");
    const target = t.path("home", ".claude", "skills", "demo");
    const original = t.path("home", ".claude", "skills", "demo", "SKILL.md");
    await t.env.fs.mkdir(target, { recursive: true });
    await t.env.fs.writeFile(original, UNMANAGED_SECRET);
    const options = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["skills" as const],
      method: "copy" as const,
    };
    const token = (await plan(t.env, options)).conflicts[0]?.acknowledgement?.token;
    if (!token) throw new Error("expected replacement acknowledgement");
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        writeFileBytes: async (path: string, data: Uint8Array, options?: { mode?: number }) => {
          if (path.includes(".cellarer-snapshot-")) {
            throw new Error("injected staged copy failure");
          }
          await t.env.fs.writeFileBytes(path, data, options);
        },
      },
    };

    await expect(
      apply(env, {
        ...options,
        replaceUnowned: [token],
        snapshotPassphrase: SNAPSHOT_PASSPHRASE,
      }),
    ).rejects.toThrow("injected staged copy failure");

    expect(await t.env.fs.readFile(original)).toBe(UNMANAGED_SECRET);
    expect((await loadLedger(t.env, storeRoot)).owners).toEqual([]);
    expect(await t.env.fs.readdir(t.path("home", ".cellarer", "snapshots"))).toHaveLength(1);
    expect(await readStoredText()).not.toContain(UNMANAGED_SECRET);
  });

  it("preserves an unmanaged Skill and retains its encrypted snapshot when staged symlink fails", async () => {
    await addSkill("demo", "# managed");
    const target = t.path("home", ".claude", "skills", "demo");
    const original = t.path("home", ".claude", "skills", "demo", "SKILL.md");
    await t.env.fs.mkdir(target, { recursive: true });
    await t.env.fs.writeFile(original, UNMANAGED_SECRET);
    const options = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["skills" as const],
    };
    const token = (await plan(t.env, options)).conflicts[0]?.acknowledgement?.token;
    if (!token) throw new Error("expected replacement acknowledgement");
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        symlink: async () => {
          throw new Error("injected staged symlink failure");
        },
      },
    };

    await expect(
      apply(env, {
        ...options,
        replaceUnowned: [token],
        snapshotPassphrase: SNAPSHOT_PASSPHRASE,
      }),
    ).rejects.toThrow("injected staged symlink failure");

    expect(await t.env.fs.readFile(original)).toBe(UNMANAGED_SECRET);
    expect((await loadLedger(t.env, storeRoot)).owners).toEqual([]);
    expect(await t.env.fs.readdir(t.path("home", ".cellarer", "snapshots"))).toHaveLength(1);
    expect(await readStoredText()).not.toContain(UNMANAGED_SECRET);
  });

  it("finishes Skill replacement without a fallible source hash read after the staged swap", async () => {
    await addSkill("demo", "# managed");
    const target = t.path("home", ".claude", "skills", "demo");
    const original = t.path("home", ".claude", "skills", "demo", "SKILL.md");
    const source = t.path("home", ".cellarer", "store", "skills", "demo");
    await t.env.fs.mkdir(target, { recursive: true });
    await t.env.fs.writeFile(original, UNMANAGED_SECRET);
    const options = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["skills" as const],
      method: "copy" as const,
    };
    const token = (await plan(t.env, options)).conflicts[0]?.acknowledgement?.token;
    if (!token) throw new Error("expected replacement acknowledgement");

    const baseFs = t.env.fs;
    let swapped = false;
    const env = {
      ...t.env,
      fs: {
        ...baseFs,
        rename: async (oldPath: string, newPath: string) => {
          await baseFs.rename(oldPath, newPath);
          if (newPath === target && oldPath.includes(".cellarer-snapshot-")) swapped = true;
        },
        readFileBytes: async (path: string) => {
          if (swapped && path.startsWith(source)) {
            throw new Error("injected post-swap source hash EIO");
          }
          return baseFs.readFileBytes(path);
        },
      },
    };

    const result = await apply(env, {
      ...options,
      replaceUnowned: [token],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });

    expect(swapped).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(await t.env.fs.readFile(original)).toBe("# managed");
    const ledger = await loadLedger(t.env, storeRoot);
    expect(ledger.owners).toHaveLength(1);
    const snapshotPath = ledger.owners[0]?.receipt.backup;
    expect(snapshotPath).toMatch(/snapshots[/\\].+\.age$/);
    if (!snapshotPath) throw new Error("expected snapshot ledger reference");
    await expect(t.env.fs.readFile(snapshotPath)).resolves.toContain("BEGIN AGE ENCRYPTED FILE");
  });

  it("maps duplicate physical owners to a blocked typed conflict in the public plan", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# managed");
    const options = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["rules" as const],
    };
    await apply(t.env, options);
    const ledger = await loadLedger(t.env, storeRoot);
    const owner = ledger.owners[0];
    if (!owner) throw new Error("expected owner");
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "state.json"),
      JSON.stringify({
        version: 2,
        owners: [owner, { ...owner, artifactIds: ["rules/duplicate"] }].map(
          ({
            deploymentId: _id,
            deploymentRoot: _root,
            itemAttribution: _attribution,
            contributions: _contributions,
            ...legacy
          }) => legacy,
        ),
      }),
    );

    const preview = await plan(t.env, options);

    expect(preview.actions[0]).toMatchObject({
      op: "skip",
      ownership: { classification: "invalid-owner" },
    });
    expect(preview.conflicts[0]).toMatchObject({
      code: "INVALID_TARGET_OWNER",
      ownership: { classification: "invalid-owner" },
    });
  });

  it("returns a blocked apply result without mutation for duplicate physical owners", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# managed");
    const options = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["rules" as const],
    };
    await apply(t.env, options);
    const target = t.path("home", ".claude", "CLAUDE.md");
    const targetBefore = await t.env.fs.readFile(target);
    const ledger = await loadLedger(t.env, storeRoot);
    const owner = ledger.owners[0];
    if (!owner) throw new Error("expected owner");
    const duplicateState = JSON.stringify({
      version: 2,
      owners: [owner, { ...owner, artifactIds: ["rules/duplicate"] }].map(
        ({
          deploymentId: _id,
          deploymentRoot: _root,
          itemAttribution: _attribution,
          contributions: _contributions,
          ...legacy
        }) => legacy,
      ),
    });
    const statePath = t.path("home", ".cellarer", "state.json");
    await t.env.fs.writeFile(statePath, duplicateState);
    await writeRuleArtifact(t.env, storeRoot, "style", "# replacement must stay unapplied");

    const result = await apply(t.env, options);

    expect(result.entries).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.plan.conflicts[0]).toMatchObject({ code: "INVALID_TARGET_OWNER" });
    expect(await t.env.fs.readFile(target)).toBe(targetBefore);
    expect(await t.env.fs.readFile(statePath)).toBe(duplicateState);
  });

  it("blocks apply for an unselected duplicate owner without invalidating the selected target", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# managed rule");
    await addSkill("demo", "# managed skill");
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["rules"],
    });
    const ledger = await loadLedger(t.env, storeRoot);
    const ruleOwner = ledger.owners[0];
    if (!ruleOwner) throw new Error("expected Rules owner");
    const duplicateState = JSON.stringify({
      version: 2,
      owners: [ruleOwner, { ...ruleOwner, artifactIds: ["rules/duplicate"] }].map(
        ({
          deploymentId: _id,
          deploymentRoot: _root,
          itemAttribution: _attribution,
          contributions: _contributions,
          ...legacy
        }) => legacy,
      ),
    });
    const statePath = join(storeRoot, "state.json");
    await t.env.fs.writeFile(statePath, duplicateState);

    const options = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["skills" as const],
    };
    const preview = await plan(t.env, options);
    expect(preview.invalidLedger).toBe(true);
    expect(preview.actions[0]).toMatchObject({
      capability: "skills",
      ownership: { classification: "absent" },
    });
    expect(preview.conflicts).toContainEqual(
      expect.objectContaining({
        code: "INVALID_TARGET_OWNER",
        target: ruleOwner.target,
        ownership: expect.objectContaining({ key: expect.any(String) }),
      }),
    );

    const result = await apply(t.env, options);
    expect(result.entries).toEqual([]);
    expect(await t.env.fs.readFile(statePath)).toBe(duplicateState);
    await expect(t.env.fs.lstat(t.path("home", ".claude", "skills", "demo"))).rejects.toThrow();
  });
});
