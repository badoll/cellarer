import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { canonicalJson, createAuthorizedMutationPlan } from "../src/protocol/canonical.js";
import { readOperationJournal } from "../src/protocol/journal.js";
import { diagnoseMutationRecovery, recoverInterruptedOperation } from "../src/protocol/recovery.js";
import { sha256 } from "../src/store/checksum.js";
import { loadLedger } from "../src/store/ledger.js";
import {
  importSkillArtifact,
  initStore,
  writeMcpArtifact,
  writeRuleArtifact,
} from "../src/store/store.js";
import { createSyncProfile, updateSyncProfile } from "../src/sync/profiles.js";
import { applySyncProfilePlan, planSyncProfile } from "../src/sync/service.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("reconciliation transaction boundaries", () => {
  let t: TmpEnv;
  let storeRoot: string;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });
  afterEach(() => t.cleanup());
  const desired = {
    agentIds: ["codex"],
    scope: "global" as const,
    resourceIds: ["rules/a"],
    collectionIds: [],
    capabilities: ["rules" as const],
    method: "copy" as const,
    mergePolicy: "merge" as const,
  };
  it("rejects tampered and resealed intent before effects, and rejects a stale desired revision", async () => {
    await writeRuleArtifact(t.env, storeRoot, "a", "# A");
    await createSyncProfile(t.env, { storeRoot, profileId: "daily", desired });
    const opts = { storeRoot, profileId: "daily" };
    const planned = await planSyncProfile(t.env, opts);
    let reads = 0;
    const unreadable: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        readFile: async () => {
          reads++;
          throw new Error("unauthorized read");
        },
      },
    };
    const tampered = {
      ...planned.mutationPlan,
      normalizedInputs: { ...planned.mutationPlan.normalizedInputs, agents: ["attacker"] },
    };
    expect((await applySyncProfilePlan(unreadable, tampered, opts)).operation.ok).toBe(false);
    expect(reads).toBe(0);
    for (const field of ["target", "consumerAgents", "source"] as const) {
      const actions = structuredClone(planned.mutationPlan.actions);
      const payload = actions[0].payload.planAction as Record<string, unknown>;
      payload[field] = field === "consumerAgents" ? ["attacker"] : t.path("home", "unauthorized");
      const resealed = createAuthorizedMutationPlan(t.env, storeRoot, {
        ...planned.mutationPlan,
        planId: `forged-${field}`,
        actions,
      });
      expect((await applySyncProfilePlan(t.env, resealed, opts)).operation.ok).toBe(false);
    }
    await updateSyncProfile(t.env, { ...opts, desired: { ...desired, agentIds: ["claude-code"] } });
    const stale = await applySyncProfilePlan(t.env, planned.mutationPlan, opts);
    expect(stale.operation.ok).toBe(false);
    expect((await loadLedger(t.env, storeRoot)).owners).toEqual([]);
  }, 15_000);

  it("rejects a resealed MCP selector transition before any target write", async () => {
    await writeMcpArtifact(t.env, storeRoot, "a", { kind: "stdio", command: "alpha" });
    const opts = { storeRoot, profileId: "daily" };
    await createSyncProfile(t.env, {
      ...opts,
      desired: {
        ...desired,
        agentIds: ["claude-code"],
        resourceIds: ["mcp/a"],
        capabilities: ["mcp"],
      },
    });
    const planned = await planSyncProfile(t.env, opts);
    const forged = structuredClone(planned.mutationPlan);
    const transition = forged.normalizedInputs.reconciliation as unknown as {
      changes: { selector: string }[];
    };
    expect(transition.changes[0]?.selector).toBe("a");
    transition.changes[0]!.selector = "not-authorized";
    const resealed = createAuthorizedMutationPlan(t.env, storeRoot, forged);
    expect((await applySyncProfilePlan(t.env, resealed, opts)).operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });
    expect((await loadLedger(t.env, storeRoot)).owners).toEqual([]);
    for (const action of planned.mutationPlan.actions)
      await expect(t.env.fs.lstat(action.target)).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it.each(
    ["mcp", "rules", "skill-add", "skill-remove", "detach", "prune-mcp"].flatMap((effect) =>
      ["before", "after"].map((when) => ({ effect, when })),
    ),
  )("keeps $effect recovery evidence $when Deployment publication", async ({ effect, when }) => {
    if (["rules", "detach", "prune-mcp"].includes(effect))
      await writeRuleArtifact(t.env, storeRoot, "a", "# A");
    if (["mcp", "prune-mcp"].includes(effect))
      await writeMcpArtifact(t.env, storeRoot, "a", { kind: "stdio", command: "alpha" });
    for (const name of effect === "skill-remove"
      ? ["a", "b"]
      : effect === "skill-add"
        ? ["a"]
        : []) {
      const source = t.path("source", name);
      await t.env.fs.mkdir(source, { recursive: true });
      await t.env.fs.writeFile(`${source}/SKILL.md`, `# ${name}`);
      await importSkillArtifact(t.env, storeRoot, name, source);
    }
    const project = t.path("project");
    await t.env.fs.mkdir(project, { recursive: true });
    const selection = effect.startsWith("skill")
      ? {
          ...desired,
          resourceIds: effect === "skill-remove" ? ["skills/a", "skills/b"] : ["skills/a"],
          capabilities: ["skills" as const],
          method: "symlink" as const,
        }
      : effect === "mcp"
        ? { ...desired, resourceIds: ["mcp/a"], capabilities: ["mcp" as const] }
        : effect === "prune-mcp"
          ? {
              ...desired,
              resourceIds: ["mcp/a", "rules/a"],
              capabilities: ["mcp" as const, "rules" as const],
            }
          : effect === "detach"
            ? { ...desired, scope: "project" as const, agentIds: ["codex", "agents-md"] }
            : desired;
    await createSyncProfile(t.env, { storeRoot, profileId: "daily", desired: selection });
    const opts = {
      storeRoot,
      profileId: "daily",
      ...(effect === "detach" ? { workspaceRoot: project } : {}),
    };
    if (["skill-remove", "detach", "prune-mcp"].includes(effect)) {
      const initial = await planSyncProfile(t.env, opts);
      expect((await applySyncProfilePlan(t.env, initial.mutationPlan, opts)).operation.ok).toBe(
        true,
      );
      const next =
        effect === "skill-remove"
          ? { ...selection, resourceIds: ["skills/a"] }
          : effect === "detach"
            ? { ...selection, agentIds: ["codex"] }
            : { ...selection, resourceIds: ["rules/a"], capabilities: ["rules" as const] };
      await updateSyncProfile(t.env, { storeRoot, profileId: "daily", desired: next });
    }
    const beforeOwners = (await loadLedger(t.env, storeRoot)).owners.length;
    const planned = await planSyncProfile(t.env, opts);
    const statePath = `${storeRoot}/state.json`;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, options) => {
          if (path === statePath && when === "before") throw new Error("simulated crash");
          await t.env.fs.publishFileAtomically(path, data, options);
          if (path === statePath && when === "after") throw new Error("simulated crash");
        },
      },
    };
    await expect(applySyncProfilePlan(env, planned.mutationPlan, opts)).rejects.toThrow(
      "simulated crash",
    );
    const journal = await readOperationJournal(t.env, storeRoot);
    expect(journal?.plan.operation).toBe("sync-reconcile");
    expect(journal?.actions.length).toBe(planned.mutationPlan.actions.length);
    expect(journal?.actions.every((action) => action.status === "succeeded")).toBe(true);
    expect((await loadLedger(t.env, storeRoot)).owners.length).toBe(
      when === "before" ? beforeOwners : 1,
    );
    const diagnosis = await diagnoseMutationRecovery(
      { ...t.env, probeProcessLiveness: async () => "dead" },
      storeRoot,
    );
    // Durable apply-family journals omit executable source/selector payloads: the existing kernel
    // cannot independently authorize finalize or compensate and must preserve manual evidence.
    expect(diagnosis.status).toBe("manual-recovery-required");
    const beforeRetry = await t.env.fs.readFile(statePath).catch(() => null);
    expect(
      await recoverInterruptedOperation(
        { ...t.env, probeProcessLiveness: async () => "dead" },
        storeRoot,
        { operationId: journal!.operationId },
      ),
    ).toMatchObject({ ok: false, conflict: { code: "MANUAL_RECOVERY_REQUIRED" } });
    expect(await t.env.fs.readFile(statePath).catch(() => null)).toBe(beforeRetry);
    expect((await applySyncProfilePlan(t.env, planned.mutationPlan, opts)).operation.ok).toBe(
      false,
    );
    expect(await t.env.fs.readFile(statePath).catch(() => null)).toBe(beforeRetry);
  }, 20_000);

  it("adds and removes Skill entries and detaches a shared Agent without touching its source", async () => {
    const project = t.path("project");
    await t.env.fs.mkdir(project, { recursive: true });
    for (const name of ["a", "b"]) {
      const source = t.path("source", name);
      await t.env.fs.mkdir(source, { recursive: true });
      await t.env.fs.writeFile(`${source}/SKILL.md`, `# ${name}`);
      await importSkillArtifact(t.env, storeRoot, name, source);
    }
    const skillDesired = {
      ...desired,
      scope: "project" as const,
      agentIds: ["codex", "agents-md"],
      resourceIds: ["skills/a", "skills/b"],
      capabilities: ["skills" as const],
      method: "symlink" as const,
    };
    await createSyncProfile(t.env, { storeRoot, profileId: "daily", desired: skillDesired });
    const opts = { storeRoot, profileId: "daily", workspaceRoot: project };
    const first = await planSyncProfile(t.env, opts);
    expect((await applySyncProfilePlan(t.env, first.mutationPlan, opts)).operation.ok).toBe(true);
    const old = await loadLedger(t.env, storeRoot);
    const removed = old.owners.find((owner) => owner.artifactIds.includes("skills/b"))!;
    const source = await t.env.fs.realpath(removed.target);
    await updateSyncProfile(t.env, {
      storeRoot,
      profileId: "daily",
      desired: { ...skillDesired, agentIds: ["codex"], resourceIds: ["skills/a"] },
    });
    const next = await planSyncProfile(t.env, opts);
    expect(next.mutationPlan.normalizedInputs.reconciliation).toMatchObject({ blocked: [] });
    const forged = structuredClone(next.mutationPlan);
    const removal = (forged.normalizedInputs.reconciliation as any).removals[0];
    const oldTarget = removal.target;
    const outside = t.path("outside-authorized-root");
    removal.target = outside;
    const action = forged.actions.find((item) => item.kind === "remove-target")!;
    action.target = outside;
    action.payload.removal = removal;
    const oldId = action.actionId;
    action.actionId = sha256(canonicalJson(removal));
    const precondition = forged.targetPreconditions.find((item) => item.actionId === oldId)!;
    precondition.actionId = action.actionId;
    precondition.target = outside;
    let outsideReads = 0;
    const guarded: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        lstat: async (path) => {
          if (path === outside) {
            outsideReads++;
            throw new Error("unauthorized observation");
          }
          return t.env.fs.lstat(path);
        },
      },
    };
    const resealed = createAuthorizedMutationPlan(t.env, storeRoot, forged);
    expect((await applySyncProfilePlan(guarded, resealed, opts)).operation.ok).toBe(false);
    expect(outsideReads).toBe(0);
    expect((await t.env.fs.lstat(oldTarget)).isSymbolicLink()).toBe(true);

    expect((await applySyncProfilePlan(t.env, next.mutationPlan, opts)).operation).toMatchObject({
      ok: true,
    });
    expect(
      (await loadLedger(t.env, storeRoot)).owners.map((owner) => [owner.agent, owner.artifactIds]),
    ).toEqual([["codex", ["skills/a"]]]);
    await expect(t.env.fs.lstat(removed.target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await t.env.fs.readFile(`${source}/SKILL.md`)).toBe("# b");
  }, 20_000);
});
