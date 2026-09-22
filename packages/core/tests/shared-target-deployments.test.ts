import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalDeploymentTarget,
  consumerKey,
  makeDeployment,
  projectDeployment,
  sameMaterialization,
  validateDeploymentState,
} from "../src/deployments/model.js";
import { apply, applyMutationPlan, planApplyMutation } from "../src/engine/apply.js";
import { dedupeCollisions } from "../src/engine/plan/collision.js";
import { plan } from "../src/engine/plan.js";
import {
  applyRevertMutationPlan,
  planRevert,
  planRevertMutation,
  revert,
} from "../src/engine/revert.js";
import type { DeploymentConsumer, PlanAction, TargetConflict } from "../src/model/index.js";
import { resourceDependencyReport } from "../src/resources/lifecycle.js";
import { addOwners, loadLedger, makeLedger, saveLedger } from "../src/store/ledger.js";
import { importSkillArtifact, initStore, writeRuleArtifact } from "../src/store/store.js";
import { ensureBaseDirs, FIXED_NOW, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("physical deployments", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    await t.env.fs.mkdir(t.path("project"), { recursive: true });
  });
  afterEach(() => t.cleanup());

  async function sharedOptions() {
    const storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
    await writeRuleArtifact(t.env, storeRoot, "demo", "# Shared rules\n");
    return {
      storeRoot,
      scope: "project" as const,
      dir: t.path("project"),
      agents: ["codex", "agents-md"],
      capabilities: ["rules" as const],
    };
  }

  it("plans and applies one shared physical action with two persisted consumers", async () => {
    const opts = await sharedOptions();
    const planned = await plan(t.env, opts);
    expect(planned.conflicts).toEqual([]);
    expect(planned.actions.filter((action) => action.op !== "skip")).toHaveLength(1);
    expect(planned.actions[0]?.consumerAgents).toEqual(["codex", "agents-md"]);
    const result = await apply(t.env, opts);
    expect(result.failures).toEqual([]);
    const state = JSON.parse(await t.env.fs.readFile(t.path("home", ".cellarer", "state.json")));
    expect(state.version).toBe(3);
    expect(state.deployments).toHaveLength(1);
    expect(state.deployments[0].consumers).toHaveLength(2);
    expect((await loadLedger(t.env, opts.storeRoot)).owners.map((owner) => owner.agent)).toEqual([
      "codex",
      "agents-md",
    ]);
    expect((await apply(t.env, opts)).failures).toEqual([]);
  });

  it("rejects inconsistent incoming shared receipts before merging consumers", async () => {
    const opts = await sharedOptions();
    await apply(t.env, opts);
    const ledger = await loadLedger(t.env, opts.storeRoot);
    const incoming = structuredClone(ledger.owners);
    incoming[1]!.receipt.fingerprint = "conflicting-receipt";
    expect(() => addOwners(ledger, incoming)).toThrow("inconsistent physical deployment");
  });

  it("blocks incompatible simultaneous consumers instead of picking a winner", () => {
    const action: PlanAction = {
      artifact: "rules/*",
      agent: "a",
      capability: "rules",
      scope: "global",
      target: "/home/target",
      method: "copy",
      op: "write",
      desiredEvidence: { method: "write", contentFingerprint: "a" },
    };
    for (const other of [
      {
        ...action,
        agent: "b",
        desiredEvidence: { method: "write" as const, contentFingerprint: "b" },
      },
      { ...action, agent: "b", capability: "mcp" as const },
    ]) {
      const actions = [{ ...action }, other];
      const conflicts: TargetConflict[] = [];
      dedupeCollisions(actions, conflicts);
      expect(conflicts[0]?.code).toBe("SHARED_TARGET_CONFLICT");
      expect(actions.every((entry) => entry.op !== "skip")).toBe(true);
    }
  });

  it("detaches one Agent with zero target writes, then removes the last consumer", async () => {
    const opts = await sharedOptions();
    await apply(t.env, opts);
    const target = t.path("project", "AGENTS.md");
    const before = await t.env.fs.readFile(target);
    const effects: string[] = [];
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        rm: async (...args: Parameters<typeof t.env.fs.rm>) => {
          if (args[0] === target) effects.push("rm");
          return t.env.fs.rm(...args);
        },
        publishFileAtomically: async (
          ...args: Parameters<typeof t.env.fs.publishFileAtomically>
        ) => {
          if (args[0] === target) effects.push("publish");
          return t.env.fs.publishFileAtomically(...args);
        },
      },
    };
    const first = await revert(env, {
      storeRoot: opts.storeRoot,
      dir: opts.dir,
      agents: ["codex"],
    });
    expect(first.failures).toEqual([]);
    expect(first.reverted).toHaveLength(1);
    expect(effects).toEqual([]);
    expect(await t.env.fs.readFile(target)).toBe(before);
    expect((await loadLedger(t.env, opts.storeRoot)).owners.map((owner) => owner.agent)).toEqual([
      "agents-md",
    ]);
    const dependencies = await resourceDependencyReport(t.env, {
      storeRoot: opts.storeRoot,
      resourceId: "rules/demo",
    });
    expect(dependencies.ownedTargets.map((owner) => owner.agent)).toEqual(["agents-md"]);
    const last = await revert(env, {
      storeRoot: opts.storeRoot,
      dir: opts.dir,
      agents: ["agents-md"],
    });
    expect(last.failures).toEqual([]);
    expect(last.reverted).toHaveLength(1);
    expect(effects).toEqual(["rm"]);
    expect((await loadLedger(t.env, opts.storeRoot)).version).toBe(3);
    expect((await loadLedger(t.env, opts.storeRoot)).owners).toEqual([]);
  });

  it("detaches and removes a shared Skill link without deleting its Store source", async () => {
    const opts = await sharedOptions();
    const source = t.path("source", "skill");
    await t.env.fs.mkdir(source, { recursive: true });
    await t.env.fs.writeFile(t.path("source", "skill", "SKILL.md"), "# Demo skill");
    await importSkillArtifact(t.env, opts.storeRoot, "demo", source);
    const result = await apply(t.env, { ...opts, capabilities: ["skills"], method: "symlink" });
    expect(result.failures).toEqual([]);
    expect(result.entries).toHaveLength(2);
    const target = result.entries[0]?.target;
    if (!target) throw new Error("missing Skill target");
    const storedSource = await t.env.fs.realpath(target);
    expect(
      (await revert(t.env, { storeRoot: opts.storeRoot, dir: opts.dir, agents: ["codex"] }))
        .reverted,
    ).toHaveLength(1);
    expect((await t.env.fs.lstat(target)).isSymbolicLink()).toBe(true);
    expect(
      (await revert(t.env, { storeRoot: opts.storeRoot, dir: opts.dir, agents: ["agents-md"] }))
        .reverted,
    ).toHaveLength(1);
    await expect(t.env.fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await t.env.fs.readFile(`${storedSource}/SKILL.md`)).toContain("# Demo skill");
  });

  it("rejects an old revert plan after another consumer binds without a revision bump", async () => {
    const opts = await sharedOptions();
    await apply(t.env, opts);
    const planned = await planRevertMutation(t.env, {
      storeRoot: opts.storeRoot,
      dir: opts.dir,
      agents: ["codex"],
    });
    const ledger = await loadLedger(t.env, opts.storeRoot);
    const first = ledger.owners[0];
    if (!first) throw new Error("missing owner");
    await saveLedger(
      t.env,
      opts.storeRoot,
      makeLedger([...ledger.owners, { ...first, agent: "another" }], 3),
    );
    const result = await applyRevertMutationPlan(t.env, planned.mutationPlan, {
      storeRoot: opts.storeRoot,
      options: { storeRoot: opts.storeRoot, dir: opts.dir, agents: ["codex"] },
    });
    expect(result.operation.ok).toBe(false);
    expect((await loadLedger(t.env, opts.storeRoot)).owners).toHaveLength(3);
    expect(await t.env.fs.readFile(t.path("project", "AGENTS.md"))).toContain("# Shared rules");
  });

  it("allows harmless detachment of a drifted target and blocks final removal", async () => {
    const opts = await sharedOptions();
    await apply(t.env, opts);
    const target = t.path("project", "AGENTS.md");
    await t.env.fs.writeFile(target, "user edit");
    const first = await revert(t.env, {
      storeRoot: opts.storeRoot,
      dir: opts.dir,
      agents: ["codex"],
    });
    expect(first.reverted).toHaveLength(1);
    const last = await planRevert(t.env, {
      storeRoot: opts.storeRoot,
      dir: opts.dir,
      agents: ["agents-md"],
    });
    expect(last.targets[0]?.blocked).toBe(true);
    expect(await t.env.fs.readFile(target)).toBe("user edit");
  });

  it("refuses a shared content change that leaves another consumer behind", async () => {
    const opts = await sharedOptions();
    await apply(t.env, opts);
    const before = await t.env.fs.readFile(t.path("project", "AGENTS.md"));
    await writeRuleArtifact(t.env, opts.storeRoot, "other", "# Different\n");
    const stateBefore = await t.env.fs.readFile(t.path("home", ".cellarer", "state.json"));
    const rejected = await apply(t.env, { ...opts, agents: ["codex"] });
    expect(rejected.entries).toEqual([]);
    expect(await t.env.fs.readFile(t.path("home", ".cellarer", "state.json"))).toBe(stateBefore);
    const planned = await plan(t.env, { ...opts, agents: ["codex"] });
    expect(planned.conflicts).toEqual([
      expect.objectContaining({ code: "SHARED_TARGET_CONFLICT" }),
    ]);
    expect(await t.env.fs.readFile(t.path("project", "AGENTS.md"))).toBe(before);
  });

  it("rejects consumer tampering in the exact sealed apply plan", async () => {
    const opts = await sharedOptions();
    const planned = await planApplyMutation(t.env, opts);
    const tampered = JSON.parse(JSON.stringify(planned.mutationPlan));
    tampered.actions[0].payload.planAction.consumerAgents.push("unauthorized");
    const result = await applyMutationPlan(t.env, tampered, {
      storeRoot: opts.storeRoot,
      options: opts,
    });
    expect(result.operation.ok).toBe(false);
    expect((await loadLedger(t.env, opts.storeRoot)).owners).toEqual([]);
  });

  function consumer(agent: string): DeploymentConsumer {
    return {
      agent,
      scope: "project",
      root: t.path("project"),
      capability: "rules",
      kind: "ad-hoc",
    };
  }
  async function deployment() {
    const identity = await canonicalDeploymentTarget(
      t.env,
      t.path("project", "AGENTS.md"),
      t.path("project"),
    );
    return makeDeployment({
      ...identity,
      capability: "rules",
      artifactIds: ["rules/demo"],
      consumers: [consumer("codex"), consumer("agents-md")],
      itemAttribution: "unknown",
      receipt: {
        method: "write",
        fingerprint: "sha256:abc",
        backup: null,
        generated: true,
        appliedAt: FIXED_NOW.toISOString(),
      },
    });
  }

  it("has one physical identity with independently queryable consumers", async () => {
    const record = await deployment();
    expect(record.consumers).toHaveLength(2);
    expect(projectDeployment(record, { agents: ["codex"] })).toHaveLength(1);
    expect(projectDeployment(record, { agents: ["agents-md"] })).toHaveLength(1);
    expect(projectDeployment(record, { profileId: "missing" })).toEqual([]);
    expect(consumerKey(consumer("codex"))).not.toBe(consumerKey(consumer("agents-md")));
    expect(validateDeploymentState({ version: 3, deployments: [record] }).deployments).toHaveLength(
      1,
    );
  });

  it("rejects duplicate physical records even for different Agents or capabilities", async () => {
    const record = await deployment();
    expect(() =>
      validateDeploymentState({
        version: 3,
        deployments: [record, { ...record, consumers: [consumer("other")] }],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      makeDeployment({ ...record, consumers: [{ ...consumer("other"), capability: "mcp" }] }),
    ).toThrow(/capability/);
  });

  it("shares only proven identical materializations, including symlink source identity", () => {
    expect(
      sameMaterialization(
        { method: "write", contentFingerprint: "a" },
        { method: "write", contentFingerprint: "a" },
      ),
    ).toBe(true);
    expect(
      sameMaterialization(
        { method: "write", contentFingerprint: "a" },
        { method: "write", contentFingerprint: "b" },
      ),
    ).toBe(false);
    expect(
      sameMaterialization(
        { method: "copy", sourceFingerprint: "a" },
        { method: "symlink", sourceFingerprint: "a" },
      ),
    ).toBe(false);
    expect(sameMaterialization({ method: "write" }, { method: "write" })).toBe(false);
    expect(
      sameMaterialization(
        { method: "symlink", sourceFingerprint: "a", sourceIdentity: "/a" },
        { method: "symlink", sourceFingerprint: "a", sourceIdentity: "/b" },
      ),
    ).toBe(false);
  });

  it("refuses duplicate consumers and cross-root bindings", async () => {
    const record = await deployment();
    expect(() =>
      makeDeployment({ ...record, consumers: [consumer("codex"), consumer("codex")] }),
    ).toThrow(/duplicate/);
    expect(() =>
      makeDeployment({ ...record, consumers: [{ ...consumer("codex"), root: t.path("home") }] }),
    ).toThrow(/root/);
  });

  it("identifies a Skill symlink by its directory entry without following the source", async () => {
    const source = t.path("store", "skills", "demo");
    const target = t.path("project", "demo");
    await t.env.fs.mkdir(source, { recursive: true });
    await t.env.fs.symlink(source, target, "dir");
    const identity = await canonicalDeploymentTarget(t.env, target, t.path("project"));
    expect(identity.target).toBe(target);
    expect(identity.key).not.toContain(source);
  });

  it("rejects ancestor symlinks, root aliases, and targets outside the managed root", async () => {
    const root = t.path("project");
    const alias = t.path("alias");
    await t.env.fs.symlink(root, alias, "dir");
    await t.env.fs.symlink(t.path("home"), t.path("project", "linked"), "dir");
    await expect(
      canonicalDeploymentTarget(t.env, t.path("alias", "AGENTS.md"), alias),
    ).rejects.toThrow(/canonical/);
    await expect(
      canonicalDeploymentTarget(t.env, t.path("project", "linked", "AGENTS.md"), root),
    ).rejects.toThrow(/symlink/);
    await expect(
      canonicalDeploymentTarget(t.env, t.path("home", "AGENTS.md"), root),
    ).rejects.toThrow(/outside/);
    await expect(canonicalDeploymentTarget(t.env, root, root)).rejects.toThrow(/root/);
  });

  it("keeps profile revision evidence separate from stable consumer identity", async () => {
    const base = consumer("codex");
    const first: DeploymentConsumer = {
      ...base,
      kind: "profile",
      profile: {
        profileId: "demo",
        profileRevision: `sha256:${"a".repeat(64)}`,
        resolvedResources: [],
      },
    };
    if (!first.profile) throw new Error("missing test profile");
    const next: DeploymentConsumer = {
      ...first,
      profile: { ...first.profile, profileRevision: `sha256:${"b".repeat(64)}` },
    };
    expect(consumerKey(first)).toBe(consumerKey(next));
    const record = makeDeployment({ ...(await deployment()), consumers: [first] });
    expect(projectDeployment(record, { profileId: "demo" })[0]?.syncProfile).toEqual(first.profile);
  });
});
