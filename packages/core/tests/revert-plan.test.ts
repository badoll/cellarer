import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply } from "../src/engine/apply.js";
import { plan } from "../src/engine/plan.js";
import {
  applyRevertMutationPlan,
  planRevert,
  planRevertMutation,
  revert,
} from "../src/engine/revert.js";
import { readStoreRevision } from "../src/protocol/store-revision.js";
import { loadLedger, makeLedger, saveLedger } from "../src/store/ledger.js";
import { importSkillArtifact, initStore, writeRuleArtifact } from "../src/store/store.js";
import { fingerprintTarget } from "../src/target-ownership.js";
import { createEncryptedTargetSnapshot } from "../src/target-snapshot.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const SNAPSHOT_PASSPHRASE = "revert-snapshot-passphrase";

describe("drift-aware revert", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });

  afterEach(() => t.cleanup());

  async function applyRule(): Promise<string> {
    await writeRuleArtifact(t.env, storeRoot, "style", "# managed");
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["rules"],
    });
    return t.path("home", ".claude", "CLAUDE.md");
  }

  async function applySkillOverExistingTarget(): Promise<{
    target: string;
    originalFile: string;
    snapshotPath: string;
    managedFingerprint: string;
  }> {
    const source = t.path("source", "demo");
    const target = t.path("home", ".claude", "skills", "demo");
    const originalFile = t.path("home", ".claude", "skills", "demo", "original.txt");
    await t.env.fs.mkdir(source, { recursive: true });
    await t.env.fs.writeFile(t.path("source", "demo", "SKILL.md"), "# managed");
    await importSkillArtifact(t.env, storeRoot, "demo", source);
    await t.env.fs.mkdir(target, { recursive: true });
    await t.env.fs.writeFile(originalFile, "original");
    const replacementToken = (
      await plan(t.env, {
        storeRoot,
        scope: "global",
        agents: ["claude-code"],
        capabilities: ["skills"],
      })
    ).conflicts[0]?.acknowledgement?.token;
    if (!replacementToken) throw new Error("expected replacement acknowledgement");
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["skills"],
      replaceUnowned: [replacementToken],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });
    const owner = (await loadLedger(t.env, storeRoot)).owners[0];
    const snapshotPath = owner?.receipt.backup;
    if (!snapshotPath) throw new Error("expected snapshot path");
    const managedFingerprint = await fingerprintTarget(t.env, target);
    if (!managedFingerprint) throw new Error("expected managed target fingerprint");
    return { target, originalFile, snapshotPath, managedFingerprint };
  }

  it("previews the expected receipt, current ownership, snapshot availability, and action", async () => {
    const target = await applyRule();
    const owner = (await loadLedger(t.env, storeRoot)).owners[0];
    if (!owner) throw new Error("expected owner");

    const result = await planRevert(t.env, { storeRoot, agents: ["claude-code"] });

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({
      target,
      expectedReceipt: owner.receipt,
      ownership: {
        classification: "owned-current",
        currentFingerprint: owner.receipt.fingerprint,
      },
      snapshot: { status: "none", path: null, encrypted: false },
      proposedAction: "remove-target",
      blocked: false,
    });
    expect(result.conflicts).toEqual([]);
    expect((await loadLedger(t.env, storeRoot)).owners).toHaveLength(1);
  });

  it("deduplicates multiple selected owners for one physical target and mutates it once", async () => {
    const target = await applyRule();
    const ledger = await loadLedger(t.env, storeRoot);
    const owner = ledger.owners[0];
    if (!owner) throw new Error("expected owner");
    await saveLedger(
      t.env,
      storeRoot,
      makeLedger([
        owner,
        { ...owner, agent: "historical-alias", artifactIds: ["rules/historical-style"] },
      ]),
    );
    let targetRemovals = 0;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
          if (path === target) targetRemovals += 1;
          return t.env.fs.rm(path, options);
        },
      },
    };

    const preview = await planRevert(env, {
      storeRoot,
      agents: ["claude-code", "historical-alias"],
    });
    expect(preview.targets).toHaveLength(1);
    expect(preview.targets[0]?.owners).toHaveLength(2);

    const result = await revert(env, {
      storeRoot,
      agents: ["claude-code", "historical-alias"],
    });
    expect(result.reverted).toHaveLength(2);
    expect(targetRemovals).toBe(1);
    expect((await loadLedger(t.env, storeRoot)).owners).toEqual([]);
  });

  it("revert --all uses each persisted project root for nested Skill gitignore actions", async () => {
    const source = t.path("source", "nested");
    const projectA = t.path("cwd", "project-a");
    const projectB = t.path("cwd", "project-b");
    await t.env.fs.mkdir(source, { recursive: true });
    await t.env.fs.writeFile(join(source, "SKILL.md"), "# nested");
    await importSkillArtifact(t.env, storeRoot, "nested", source);
    for (const dir of [projectA, projectB]) {
      await t.env.fs.mkdir(dir, { recursive: true });
      const result = await apply(t.env, {
        storeRoot,
        scope: "project",
        dir,
        agents: ["claude-code"],
        capabilities: ["skills"],
      });
      expect(result.failures).toEqual([]);
    }

    const owners = (await loadLedger(t.env, storeRoot)).owners;
    expect(owners.map((owner) => owner.projectRoot).sort()).toEqual([projectA, projectB]);
    const prepared = await planRevertMutation(t.env, {
      storeRoot,
      scope: "project",
      agents: ["claude-code"],
    });
    expect(
      prepared.mutationPlan.actions
        .filter((action) => action.kind === "sync-gitignore")
        .map((action) => action.target)
        .sort(),
    ).toEqual([join(projectA, ".gitignore"), join(projectB, ".gitignore")]);

    const result = await revert(t.env, {
      storeRoot,
      scope: "project",
      agents: ["claude-code"],
    });
    expect(result.failures).toEqual([]);
    expect(result.reverted).toHaveLength(2);
    for (const project of [projectA, projectB]) {
      await expect(t.env.fs.lstat(join(project, ".gitignore"))).rejects.toThrow();
      await expect(
        t.env.fs.lstat(join(project, ".claude", "skills", ".gitignore")),
      ).rejects.toThrow();
    }
  });

  it("fails closed when a pre-release project owner has no canonical project root", async () => {
    const project = t.path("cwd", "project");
    await t.env.fs.mkdir(project, { recursive: true });
    await writeRuleArtifact(t.env, storeRoot, "style", "# managed");
    await apply(t.env, {
      storeRoot,
      scope: "project",
      dir: project,
      agents: ["claude-code"],
      capabilities: ["rules"],
    });
    const ledger = await loadLedger(t.env, storeRoot);
    const owner = ledger.owners[0];
    if (!owner) throw new Error("expected project owner");
    const { projectRoot: _removed, ...preReleaseOwner } = owner;
    await t.env.fs.writeFile(
      join(storeRoot, "state.json"),
      `${JSON.stringify({ ...ledger, owners: [preReleaseOwner] }, null, 2)}\n`,
    );

    await expect(planRevert(t.env, { storeRoot, scope: "project" })).rejects.toThrow(
      /missing a canonical projectRoot.*move state\.json aside/,
    );
    await expect(t.env.fs.lstat(owner.target)).resolves.toBeDefined();
    await expect(t.env.fs.lstat(join(project, ".gitignore"))).resolves.toBeDefined();
  });

  it("plans duplicate owners as invalid and makes actual revert non-executable", async () => {
    const target = await applyRule();
    const targetBefore = await t.env.fs.readFile(target);
    const ledger = await loadLedger(t.env, storeRoot);
    const owner = ledger.owners[0];
    if (!owner) throw new Error("expected owner");
    const duplicateState = JSON.stringify({
      ...ledger,
      owners: [owner, { ...owner, artifactIds: ["rules/duplicate"] }],
    });
    const statePath = t.path("home", ".cellarer", "state.json");
    await t.env.fs.writeFile(statePath, duplicateState);

    const preview = await planRevert(t.env, { storeRoot, agents: ["claude-code"] });
    expect(preview.targets).toHaveLength(1);
    expect(preview.targets[0]).toMatchObject({
      blocked: true,
      ownership: { classification: "invalid-owner" },
    });
    expect(preview.conflicts[0]).toMatchObject({ code: "INVALID_TARGET_OWNER" });

    const result = await revert(t.env, { storeRoot, agents: ["claude-code"] });
    expect(result.reverted).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.plan.conflicts[0]).toMatchObject({ code: "INVALID_TARGET_OWNER" });
    expect(await t.env.fs.readFile(target)).toBe(targetBefore);
    expect(await t.env.fs.readFile(statePath)).toBe(duplicateState);
  });

  it("selectively reverts a valid target while preserving duplicate owner records verbatim", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# managed rule");
    const source = t.path("source", "demo");
    await t.env.fs.mkdir(source, { recursive: true });
    await t.env.fs.writeFile(join(source, "SKILL.md"), "# managed skill");
    await importSkillArtifact(t.env, storeRoot, "demo", source);
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["rules", "skills"],
    });
    const ledger = await loadLedger(t.env, storeRoot);
    const ruleOwner = ledger.owners.find((owner) => owner.capability === "rules");
    const skillOwner = ledger.owners.find((owner) => owner.capability === "skills");
    if (!ruleOwner || !skillOwner) throw new Error("expected Rules and Skill owners");
    const duplicateRule = { ...ruleOwner, artifactIds: ["rules/duplicate"] };
    const duplicateState = JSON.stringify({
      ...ledger,
      owners: [ruleOwner, duplicateRule, skillOwner],
    });
    const statePath = join(storeRoot, "state.json");
    await t.env.fs.writeFile(statePath, duplicateState);

    const preview = await planRevert(t.env, {
      storeRoot,
      artifactIds: ["skills/demo"],
    });
    expect(preview.targets).toEqual([
      expect.objectContaining({ target: skillOwner.target, blocked: false }),
    ]);
    expect(preview.conflicts).toEqual([]);

    const dryRun = await revert(t.env, {
      storeRoot,
      artifactIds: ["skills/demo"],
      dryRun: true,
    });
    expect(dryRun.reverted).toEqual([skillOwner]);
    expect(await t.env.fs.readFile(statePath)).toBe(duplicateState);

    const result = await revert(t.env, { storeRoot, artifactIds: ["skills/demo"] });
    expect(result.failures).toEqual([]);
    expect(result.reverted).toEqual([skillOwner]);
    await expect(t.env.fs.lstat(skillOwner.target)).rejects.toThrow();
    await expect(t.env.fs.lstat(ruleOwner.target)).resolves.toBeDefined();
    const remaining = JSON.parse(await t.env.fs.readFile(statePath));
    expect(remaining.owners).toEqual([ruleOwner, duplicateRule]);
  });

  it("blocks drift by default and accepts only the acknowledgement for the exact target receipt", async () => {
    const target = await applyRule();
    await t.env.fs.writeFile(target, "user edit");

    const preview = await planRevert(t.env, { storeRoot, agents: ["claude-code"] });
    expect(preview.targets[0]).toMatchObject({
      ownership: { classification: "owned-drifted" },
      proposedAction: "remove-target",
      blocked: true,
      acknowledgement: { kind: "revert-drift" },
    });
    expect(preview.conflicts[0]?.code).toBe("REVERT_TARGET_DRIFTED");
    const token = preview.targets[0]?.acknowledgement?.token;
    if (!token) throw new Error("expected drift acknowledgement");

    const blocked = await revert(t.env, { storeRoot, agents: ["claude-code"] });
    expect(blocked.reverted).toEqual([]);
    expect(await t.env.fs.readFile(target)).toBe("user edit");
    expect((await loadLedger(t.env, storeRoot)).owners).toHaveLength(1);

    const wrong = await revert(t.env, {
      storeRoot,
      agents: ["claude-code"],
      acknowledgements: ["sha256:wrong-target-or-receipt"],
    });
    expect(wrong.reverted).toEqual([]);
    expect(await t.env.fs.readFile(target)).toBe("user edit");

    const reverted = await revert(t.env, {
      storeRoot,
      agents: ["claude-code"],
      acknowledgements: [token],
    });
    expect(reverted.reverted).toHaveLength(1);
    expect(reverted.plan.targets[0]?.driftOverridden).toBe(true);
    await expect(t.env.fs.lstat(target)).rejects.toThrow();
  });

  it("restores a complete encrypted directory snapshot only with the supplied passphrase", async () => {
    const source = t.path("source", "demo");
    const target = t.path("home", ".claude", "skills", "demo");
    await t.env.fs.mkdir(source, { recursive: true });
    await t.env.fs.writeFile(t.path("source", "demo", "SKILL.md"), "# managed");
    await importSkillArtifact(t.env, storeRoot, "demo", source);
    await t.env.fs.mkdir(t.path("home", ".claude", "skills", "demo", "nested"), {
      recursive: true,
    });
    await t.env.fs.writeFile(
      t.path("home", ".claude", "skills", "demo", "original.txt"),
      "original",
    );
    await t.env.fs.writeFile(
      t.path("home", ".claude", "skills", "demo", "nested", "child.txt"),
      "child",
    );
    await t.env.fs.writeFileBytes(
      t.path("home", ".claude", "skills", "demo", "nested", "binary.bin"),
      new Uint8Array([0, 255, 1, 128]),
    );
    await t.env.fs.symlink("original.txt", t.path("home", ".claude", "skills", "demo", "link"));
    const beforeFingerprint = await fingerprintTarget(t.env, target);

    const blocked = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["skills"],
    });
    const replacementToken = blocked.conflicts[0]?.acknowledgement?.token;
    if (!replacementToken) throw new Error("expected replacement acknowledgement");
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["skills"],
      replaceUnowned: [replacementToken],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });

    const preview = await planRevert(t.env, { storeRoot, agents: ["claude-code"] });
    expect(preview.targets[0]).toMatchObject({
      snapshot: {
        status: "available",
        encrypted: true,
        digest: expect.stringMatching(/^sha256:/),
        mode: 0o600,
      },
      proposedAction: "restore-snapshot",
      blocked: false,
    });

    const missingPassphrase = await revert(t.env, {
      storeRoot,
      agents: ["claude-code"],
    });
    expect(missingPassphrase.failures[0]?.code).toBe("SNAPSHOT_PASSPHRASE_REQUIRED");
    expect((await loadLedger(t.env, storeRoot)).owners).toHaveLength(1);

    const restored = await revert(t.env, {
      storeRoot,
      agents: ["claude-code"],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });
    expect(restored.failures).toEqual([]);
    expect(await fingerprintTarget(t.env, target)).toBe(beforeFingerprint);
    expect(
      await t.env.fs.readFile(t.path("home", ".claude", "skills", "demo", "nested", "child.txt")),
    ).toBe("child");
    expect(
      Array.from(
        await t.env.fs.readFileBytes(
          t.path("home", ".claude", "skills", "demo", "nested", "binary.bin"),
        ),
      ),
    ).toEqual([0, 255, 1, 128]);
    expect(await t.env.fs.readlink(t.path("home", ".claude", "skills", "demo", "link"))).toBe(
      "original.txt",
    );
    expect((await loadLedger(t.env, storeRoot)).owners).toEqual([]);
  });

  it("rejects replacement by another valid snapshot after revert planning", async () => {
    const { target, snapshotPath, managedFingerprint } = await applySkillOverExistingTarget();
    const prepared = await planRevertMutation(t.env, {
      storeRoot,
      agents: ["claude-code"],
    });
    const alternateTarget = t.path("home", ".claude", "alternate-before");
    await t.env.fs.mkdir(alternateTarget, { recursive: true });
    await t.env.fs.writeFile(join(alternateTarget, "alternate.txt"), "alternate");
    const alternateFingerprint = await fingerprintTarget(t.env, alternateTarget);
    if (!alternateFingerprint) throw new Error("expected alternate fingerprint");
    const alternateSnapshot = await createEncryptedTargetSnapshot(
      t.env,
      storeRoot,
      alternateTarget,
      SNAPSHOT_PASSPHRASE,
      alternateFingerprint,
    );
    await t.env.fs.publishFileAtomically(
      snapshotPath,
      await t.env.fs.readFile(alternateSnapshot.path),
      { mode: 0o600 },
    );

    const result = await applyRevertMutationPlan(t.env, prepared.mutationPlan, {
      storeRoot,
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });

    expect(result.operation).toMatchObject({ ok: false, conflict: { code: "PARTIAL_FAILURE" } });
    await expect(fingerprintTarget(t.env, target)).resolves.toBe(managedFingerprint);
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
    expect((await loadLedger(t.env, storeRoot)).owners).toHaveLength(1);
  });

  it("restores the signed bytes read before a snapshot path swap and never deletes the replacement", async () => {
    const { target, snapshotPath } = await applySkillOverExistingTarget();
    const prepared = await planRevertMutation(t.env, {
      storeRoot,
      agents: ["claude-code"],
    });
    const alternateTarget = t.path("home", ".claude", "alternate-read-swap");
    await t.env.fs.mkdir(alternateTarget, { recursive: true });
    await t.env.fs.writeFile(join(alternateTarget, "alternate.txt"), "alternate");
    const alternateFingerprint = await fingerprintTarget(t.env, alternateTarget);
    if (!alternateFingerprint) throw new Error("expected alternate fingerprint");
    const alternateSnapshot = await createEncryptedTargetSnapshot(
      t.env,
      storeRoot,
      alternateTarget,
      SNAPSHOT_PASSPHRASE,
      alternateFingerprint,
    );
    const alternateBytes = await t.env.fs.readFile(alternateSnapshot.path);
    const readFile = t.env.fs.readFile;
    const rm = t.env.fs.rm;
    let swapped = false;
    let snapshotRmCalls = 0;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        readFile: async (path: string) => {
          const bytes = await readFile(path);
          if (!swapped && path === snapshotPath) {
            swapped = true;
            await t.env.fs.publishFileAtomically(snapshotPath, alternateBytes, { mode: 0o600 });
          }
          return bytes;
        },
        rm: async (path: string, opts?: { recursive?: boolean; force?: boolean }) => {
          if (path === snapshotPath) snapshotRmCalls += 1;
          await rm(path, opts);
        },
      },
    };

    const result = await applyRevertMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
      keepBackups: false,
    });

    expect(result.operation).toMatchObject({ ok: true, receipt: { outcome: "committed" } });
    await expect(t.env.fs.readFile(join(target, "original.txt"))).resolves.toBe("original");
    await expect(t.env.fs.lstat(join(target, "alternate.txt"))).rejects.toThrow();
    await expect(t.env.fs.readFile(snapshotPath)).resolves.toBe(alternateBytes);
    expect(snapshotRmCalls).toBe(0);
  });

  it("keeps the current target, owner, and snapshot when restore build fails", async () => {
    const { target, originalFile, snapshotPath, managedFingerprint } =
      await applySkillOverExistingTarget();
    const owner = (await loadLedger(t.env, storeRoot)).owners[0];
    const encrypted = await t.env.fs.readFile(snapshotPath);
    const baseFs = t.env.fs;
    const env = {
      ...t.env,
      fs: {
        ...baseFs,
        writeFileBytes: async (path: string, data: Uint8Array, options?: { mode?: number }) => {
          if (path.endsWith("original.txt")) throw new Error("injected restore build failure");
          return baseFs.writeFileBytes(path, data, options);
        },
      },
    };

    const result = await revert(env, {
      storeRoot,
      agents: ["claude-code"],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });
    expect(result.reverted).toEqual([]);
    expect(result.failures[0]?.code).toBe("REVERT_FAILED");
    expect(await fingerprintTarget(t.env, target)).toBe(managedFingerprint);
    expect(await t.env.fs.readFile(t.path("home", ".claude", "skills", "demo", "SKILL.md"))).toBe(
      "# managed",
    );
    await expect(t.env.fs.lstat(originalFile)).rejects.toThrow();
    expect((await loadLedger(t.env, storeRoot)).owners).toEqual([owner]);
    expect(await t.env.fs.readFile(snapshotPath)).toBe(encrypted);
  });

  it("keeps the current target, owner, and snapshot when restore staging verification fails", async () => {
    const { target, snapshotPath, managedFingerprint } = await applySkillOverExistingTarget();
    const owner = (await loadLedger(t.env, storeRoot)).owners[0];
    const encrypted = await t.env.fs.readFile(snapshotPath);
    const baseFs = t.env.fs;
    const env = {
      ...t.env,
      fs: {
        ...baseFs,
        readFileBytes: async (path: string) => {
          if (path.endsWith("original.txt")) {
            throw new Error("injected restore staging fingerprint failure");
          }
          return baseFs.readFileBytes(path);
        },
      },
    };

    const result = await revert(env, {
      storeRoot,
      agents: ["claude-code"],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });

    expect(result.reverted).toEqual([]);
    expect(result.failures[0]?.code).toBe("REVERT_FAILED");
    expect(await fingerprintTarget(t.env, target)).toBe(managedFingerprint);
    expect((await loadLedger(t.env, storeRoot)).owners).toEqual([owner]);
    expect(await t.env.fs.readFile(snapshotPath)).toBe(encrypted);
  });

  it("rolls back the current target and retains owner/snapshot when restore swap fails", async () => {
    const { target, snapshotPath, managedFingerprint } = await applySkillOverExistingTarget();
    const owner = (await loadLedger(t.env, storeRoot)).owners[0];
    const encrypted = await t.env.fs.readFile(snapshotPath);
    const baseFs = t.env.fs;
    const env = {
      ...t.env,
      fs: {
        ...baseFs,
        rename: async (oldPath: string, newPath: string) => {
          if (newPath === target && oldPath.includes(".cellarer-restore-stage-")) {
            throw new Error("injected restore swap failure");
          }
          return baseFs.rename(oldPath, newPath);
        },
      },
    };

    const result = await revert(env, {
      storeRoot,
      agents: ["claude-code"],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });

    expect(result.reverted).toEqual([]);
    expect(result.failures[0]?.code).toBe("REVERT_FAILED");
    expect(await fingerprintTarget(t.env, target)).toBe(managedFingerprint);
    expect((await loadLedger(t.env, storeRoot)).owners).toEqual([owner]);
    expect(await t.env.fs.readFile(snapshotPath)).toBe(encrypted);
  });

  it("retains restore recovery paths, owner, and snapshot when cleanup and rollback rename fail", async () => {
    const { target, snapshotPath } = await applySkillOverExistingTarget();
    const owner = (await loadLedger(t.env, storeRoot)).owners[0];
    const encrypted = await t.env.fs.readFile(snapshotPath);
    const baseFs = t.env.fs;
    const env = {
      ...t.env,
      fs: {
        ...baseFs,
        rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
          if (path.includes(".cellarer-restore-before-")) {
            throw new Error("injected restore cleanup failure");
          }
          return baseFs.rm(path, options);
        },
        rename: async (oldPath: string, newPath: string) => {
          if (oldPath.includes(".cellarer-restore-before-") && newPath === target) {
            throw new Error("injected restore rollback rename failure");
          }
          return baseFs.rename(oldPath, newPath);
        },
      },
    };

    const result = await revert(env, {
      storeRoot,
      agents: ["claude-code"],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });

    expect(result.reverted).toEqual([]);
    expect(result.failures[0]?.code).toBe("REVERT_FAILED");
    const parent = t.path("home", ".claude", "skills");
    const children = await t.env.fs.readdir(parent);
    const staged = children.find((name) => name.includes(".cellarer-restore-stage-"));
    const displaced = children.find((name) => name.includes(".cellarer-restore-before-"));
    expect(staged).toBeDefined();
    expect(displaced).toBeDefined();
    if (!staged || !displaced) throw new Error("expected retained restore recovery paths");
    const stagedPath = join(parent, staged);
    const displacedPath = join(parent, displaced);
    expect(result.failures[0]?.message).toContain(stagedPath);
    expect(result.failures[0]?.message).toContain(displacedPath);
    expect((await loadLedger(t.env, storeRoot)).owners).toEqual([owner]);
    expect(await t.env.fs.readFile(snapshotPath)).toBe(encrypted);
  });

  it("never deletes a snapshot path after commit when its ancestor is swapped", async () => {
    const { snapshotPath } = await applySkillOverExistingTarget();
    const snapshotsRoot = dirname(snapshotPath);
    const retainedRoot = t.path("retained-snapshots");
    const outsideRoot = t.path("outside-same-name");
    const outsideFile = join(outsideRoot, basename(snapshotPath));
    const revisionPath = t.path("home", ".cellarer", "revision.json");
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    const rm = t.env.fs.rm;
    let swapped = false;
    let snapshotRmCalls = 0;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path: string, data: string, opts?: { mode?: number }) => {
          await publishFileAtomically(path, data, opts);
          if (!swapped && path === revisionPath) {
            swapped = true;
            await t.env.fs.rename(snapshotsRoot, retainedRoot);
            await t.env.fs.mkdir(outsideRoot, { recursive: true });
            await t.env.fs.writeFile(outsideFile, "external same-name snapshot");
            await t.env.fs.symlink(outsideRoot, snapshotsRoot, "dir");
          }
        },
        rm: async (path: string, opts?: { recursive?: boolean; force?: boolean }) => {
          if (path === snapshotPath) snapshotRmCalls += 1;
          await rm(path, opts);
        },
      },
    };

    const result = await revert(env, {
      storeRoot,
      agents: ["claude-code"],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
      keepBackups: false,
    });

    expect(result.failures).toEqual([]);
    expect(result.reverted).toHaveLength(1);
    expect(snapshotRmCalls).toBe(0);
    await expect(t.env.fs.readFile(outsideFile)).resolves.toBe("external same-name snapshot");
    await expect(t.env.fs.readFile(join(retainedRoot, basename(snapshotPath)))).resolves.toContain(
      "BEGIN AGE ENCRYPTED FILE",
    );
    expect(result.warnings).toContainEqual(
      expect.stringContaining("automatic snapshot deletion is unsupported"),
    );
  });

  it("keeps the owner for a wrong passphrase and for a missing snapshot", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# managed");
    const target = t.path("home", ".claude", "CLAUDE.md");
    await t.env.fs.mkdir(t.path("home", ".claude"), { recursive: true });
    await t.env.fs.writeFile(target, "user original");
    const options = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["rules" as const],
    };
    const replacement = (await plan(t.env, options)).conflicts[0]?.acknowledgement?.token;
    if (!replacement) throw new Error("expected replacement acknowledgement");
    await apply(t.env, {
      ...options,
      replaceUnowned: [replacement],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });
    const snapshotPath = (await loadLedger(t.env, storeRoot)).owners[0]?.receipt.backup;
    if (!snapshotPath) throw new Error("expected snapshot path");

    const wrongPassphrase = await revert(t.env, {
      storeRoot,
      agents: ["claude-code"],
      snapshotPassphrase: "wrong-passphrase",
    });
    expect(wrongPassphrase.reverted).toEqual([]);
    expect(wrongPassphrase.failures[0]?.code).toBe("REVERT_FAILED");
    expect((await loadLedger(t.env, storeRoot)).owners).toHaveLength(1);
    expect(await t.env.fs.readFile(target)).toContain("# managed");

    await t.env.fs.rm(snapshotPath, { force: true });
    const missing = await planRevert(t.env, { storeRoot, agents: ["claude-code"] });
    expect(missing.targets[0]).toMatchObject({
      snapshot: { status: "missing", encrypted: true },
      blocked: true,
    });
    expect(missing.conflicts[0]?.code).toBe("REVERT_SNAPSHOT_UNAVAILABLE");
    const blocked = await revert(t.env, {
      storeRoot,
      agents: ["claude-code"],
      snapshotPassphrase: SNAPSHOT_PASSPHRASE,
    });
    expect(blocked.reverted).toEqual([]);
    expect((await loadLedger(t.env, storeRoot)).owners).toHaveLength(1);
    expect(await t.env.fs.readFile(target)).toContain("# managed");
  });

  it("rejects a tampered plaintext backup path without reading or deleting the external file", async () => {
    const target = await applyRule();
    const external = t.path("external-user-file.txt");
    await t.env.fs.writeFile(external, "must remain private");
    const ledger = await loadLedger(t.env, storeRoot);
    const owner = ledger.owners[0];
    if (!owner) throw new Error("expected owner");
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "state.json"),
      JSON.stringify({
        ...ledger,
        owners: [{ ...owner, receipt: { ...owner.receipt, backup: external } }],
      }),
    );
    let externalReads = 0;
    let externalRemovals = 0;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        readFile: async (path: string) => {
          if (path === external) externalReads += 1;
          return t.env.fs.readFile(path);
        },
        rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
          if (path === external) externalRemovals += 1;
          return t.env.fs.rm(path, options);
        },
      },
    };

    const preview = await planRevert(env, { storeRoot, agents: ["claude-code"] });
    expect(preview.targets[0]).toMatchObject({
      snapshot: { path: external, status: "invalid", encrypted: false },
      blocked: true,
    });
    const result = await revert(env, { storeRoot, agents: ["claude-code"] });

    expect(result.reverted).toEqual([]);
    expect(externalReads).toBe(0);
    expect(externalRemovals).toBe(0);
    expect(await t.env.fs.readFile(external)).toBe("must remain private");
    expect(await t.env.fs.readFile(target)).toContain("# managed");
  });

  it("rejects a snapshot path reached through a symlinked snapshots ancestor", async () => {
    await applyRule();
    const outside = t.path("outside-snapshots");
    const snapshotsRoot = t.path("home", ".cellarer", "snapshots");
    await t.env.fs.mkdir(outside, { recursive: true });
    await t.env.fs.mkdir(snapshotsRoot, { recursive: true });
    await t.env.fs.writeFile(t.path("outside-snapshots", "forged.age"), "external ciphertext");
    await t.env.fs.symlink(outside, t.path("home", ".cellarer", "snapshots", "escape"), "dir");
    const forged = t.path("home", ".cellarer", "snapshots", "escape", "forged.age");
    const ledger = await loadLedger(t.env, storeRoot);
    const owner = ledger.owners[0];
    if (!owner) throw new Error("expected owner");
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "state.json"),
      JSON.stringify({
        ...ledger,
        owners: [{ ...owner, receipt: { ...owner.receipt, backup: forged } }],
      }),
    );

    const preview = await planRevert(t.env, { storeRoot, agents: ["claude-code"] });

    expect(preview.targets[0]).toMatchObject({
      snapshot: { path: forged, status: "invalid", encrypted: true },
      blocked: true,
    });
  });
});
