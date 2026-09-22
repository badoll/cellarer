import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apply,
  applyMutationPlan,
  applySyncProfileMutationPlan,
  applySyncProfilePlan,
  applySyncProfileUninstallPlan,
  createSyncProfile,
  deleteSyncProfile,
  listSyncProfiles,
  loadConfig,
  planApplyMutation,
  planSyncProfile,
  planSyncProfileUninstall,
  showSyncProfile,
  syncProfileSchema,
  updateSyncProfile,
  verifySyncProfile,
} from "../src/index.js";
import { createAuthorizedMutationPlan } from "../src/protocol/canonical.js";
import { saveConfig } from "../src/store/config.js";
import { initStore, writeRuleArtifact } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

const desired = {
  agentIds: ["codex"],
  scope: "global" as const,
  resourceIds: ["rules/style"],
  collectionIds: [] as string[],
  capabilities: ["rules" as const],
  method: "copy" as const,
  mergePolicy: "merge" as const,
};

describe("versioned sync profiles", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
    await writeRuleArtifact(t.env, storeRoot, "style", "# Style\n");
  });

  afterEach(() => t.cleanup());

  it("rejects secrets, absolute workspace paths, and persistent destructive acknowledgements", () => {
    const safe = {
      schemaVersion: 1,
      profileId: "daily",
      revision: "sha256:" + "0".repeat(64),
      createdAt: "2026-06-30T08:00:00.000Z",
      updatedAt: "2026-06-30T08:00:00.000Z",
      desired,
    };
    expect(syncProfileSchema.safeParse(safe).success).toBe(true);
    for (const forbidden of [
      { workspaceRoot: "/tmp/project" },
      { replaceUnowned: ["sha256:" + "1".repeat(64)] },
      { overrideDrift: ["sha256:" + "2".repeat(64)] },
      { force: true },
      { secretMode: "vault" },
      { token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
    ]) {
      expect(
        syncProfileSchema.safeParse({
          ...safe,
          desired: { ...desired, ...forbidden },
        }).success,
      ).toBe(false);
    }
  });

  it("lists, shows, creates, updates, and deletes through revisioned transactions", async () => {
    const dryRun = await createSyncProfile(t.env, {
      storeRoot,
      profileId: "daily",
      desired,
      dryRun: true,
    });
    expect(dryRun).toMatchObject({
      profile: {
        schemaVersion: 1,
        profileId: "daily",
        revision: expect.stringMatching(/^sha256:/),
      },
      plan: { operation: "settings", baseRevision: 0 },
    });
    await expect(listSyncProfiles(t.env, { storeRoot })).resolves.toEqual([]);

    const created = await applySyncProfileMutationPlan(t.env, dryRun.plan, { storeRoot });
    expect(created.operation).toMatchObject({
      ok: true,
      receipt: { outcome: "committed", resultingRevision: 1 },
    });
    expect((await showSyncProfile(t.env, { storeRoot, profileId: "daily" })).profile).toEqual(
      dryRun.profile,
    );

    const updated = await updateSyncProfile(t.env, {
      storeRoot,
      profileId: "daily",
      desired: { ...desired, agentIds: ["claude-code", "codex"] },
    });
    expect(updated.operation).toMatchObject({ ok: true });
    expect(updated.profile.revision).not.toBe(dryRun.profile.revision);
    expect(updated.profile.desired.agentIds).toEqual(["claude-code", "codex"]);
    expect(
      (await listSyncProfiles(t.env, { storeRoot })).map((profile) => profile.profileId),
    ).toEqual(["daily"]);

    await expect(
      createSyncProfile(t.env, {
        storeRoot,
        profileId: "missing-dependencies",
        desired: { ...desired, agentIds: ["removed-adapter"] },
      }),
    ).rejects.toMatchObject({ code: "MISSING_PROFILE_DEPENDENCY" });
    await expect(
      updateSyncProfile(t.env, {
        storeRoot,
        profileId: "daily",
        desired: { ...desired, resourceIds: ["rules/missing"] },
      }),
    ).rejects.toMatchObject({ code: "MISSING_PROFILE_DEPENDENCY" });

    const deleted = await deleteSyncProfile(t.env, { storeRoot, profileId: "daily" });
    expect(deleted.operation).toMatchObject({ ok: true });
    await expect(showSyncProfile(t.env, { storeRoot, profileId: "daily" })).resolves.toEqual({
      profile: null,
    });
  }, 20_000);

  it("binds profile timestamps into the plan when the real clock advances before apply", async () => {
    let tick = 0;
    t.env.now = () => new Date(`2026-06-30T08:00:0${tick++}.000Z`);

    const created = await createSyncProfile(t.env, {
      storeRoot,
      profileId: "advancing-clock",
      desired,
    });

    expect(created).toMatchObject({
      profile: {
        profileId: "advancing-clock",
        createdAt: "2026-06-30T08:00:00.000Z",
        updatedAt: "2026-06-30T08:00:00.000Z",
      },
      operation: { ok: true },
    });
  });

  it.each([
    ["missing", undefined],
    ["stale", deterministicMutationAuthority({ isCurrent: async () => false })],
  ] as const)("guards profile CRUD observation with %s authority", async (_label, mutationAuthority) => {
    await createSyncProfile(t.env, { storeRoot, profileId: "daily", desired });
    const updatePlan = await updateSyncProfile(t.env, {
      storeRoot,
      profileId: "daily",
      desired: { ...desired, collectionIds: ["default"] },
      dryRun: true,
    });
    const productReads: string[] = [];
    let clockReads = 0;
    const originalFs = t.env.fs;
    t.env.fs = new Proxy(originalFs, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (..._args: unknown[]) => {
          productReads.push(String(property));
          throw new Error(`unexpected product read: ${String(property)}`);
        };
      },
    });
    t.env.now = () => {
      clockReads += 1;
      throw new Error("unexpected clock read");
    };
    t.env.mutationAuthority = mutationAuthority;

    const invocations = [
      () => createSyncProfile(t.env, { storeRoot, profileId: "new", desired }),
      () => updateSyncProfile(t.env, { storeRoot, profileId: "daily", desired }),
      () => deleteSyncProfile(t.env, { storeRoot, profileId: "daily" }),
      () => applySyncProfileMutationPlan(t.env, updatePlan.plan, { storeRoot }),
    ];
    for (const invoke of invocations) {
      await expect(invoke()).rejects.toThrow(/mutation authority/i);
      expect(productReads).toEqual([]);
      expect(clockReads).toBe(0);
    }
  });

  it("does not accept a structural or expired caller lease for profile apply", async () => {
    const planned = await createSyncProfile(t.env, {
      storeRoot,
      profileId: "daily",
      desired,
      dryRun: true,
    });
    const authority = t.env.mutationAuthority;
    if (!authority) throw new Error("expected mutation authority");
    const expiredLease = await authority.acquireLease();
    await expiredLease.release();
    const fakeLease = Object.freeze({
      isCurrent: async () => true,
      release: async () => undefined,
    });
    const productEffects: string[] = [];
    let clockReads = 0;
    const originalFs = t.env.fs;
    t.env.fs = new Proxy(originalFs, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (..._args: unknown[]) => {
          productEffects.push(String(property));
          throw new Error(`unexpected product effect: ${String(property)}`);
        };
      },
    });
    t.env.now = () => {
      clockReads += 1;
      throw new Error("unexpected clock read");
    };
    t.env.mutationAuthority = deterministicMutationAuthority({ isCurrent: async () => false });

    for (const injectedLease of [fakeLease, expiredLease]) {
      await expect(
        Reflect.apply(applySyncProfileMutationPlan, undefined, [
          t.env,
          planned.plan,
          { storeRoot },
          { authorityLease: injectedLease },
        ]),
      ).rejects.toThrow(/mutation authority/i);
      expect(productEffects).toEqual([]);
      expect(clockReads).toBe(0);
    }
  });

  it("releases one nested profile plan/apply authority scope exactly once", async () => {
    const authority = deterministicMutationAuthority();
    let releases = 0;
    t.env.mutationAuthority = {
      seal: authority.seal,
      verify: authority.verify,
      isCurrent: authority.isCurrent,
      publishJournalTip: authority.publishJournalTip,
      matchesJournalTip: authority.matchesJournalTip,
      acquireLease: async () => {
        const lease = await authority.acquireLease();
        return {
          isCurrent: () => lease.isCurrent(),
          release: async () => {
            releases += 1;
            if (releases > 1) throw new Error("authority lease released twice");
            await lease.release();
          },
        };
      },
    };

    await expect(
      createSyncProfile(t.env, { storeRoot, profileId: "single-release", desired }),
    ).resolves.toMatchObject({ operation: { ok: true } });
    expect(releases).toBe(1);
  });

  // Vitest timeouts do not cancel async work, so finish this transaction before fixture teardown.
  it("resolves collections, immutable revisions, agents, workspace root, and targets deterministically", async () => {
    await writeRuleArtifact(t.env, storeRoot, "safety", "# Safety\n");
    const config = await loadConfig(t.env, storeRoot);
    config.collections.work = { description: "work" };
    config.artifacts["rules/safety"] = { collections: ["work"] };
    await saveConfig(t.env, storeRoot, config);
    await createSyncProfile(t.env, {
      storeRoot,
      profileId: "project",
      desired: {
        ...desired,
        scope: "project",
        resourceIds: ["rules/style"],
        collectionIds: ["work"],
      },
    });

    await expect(planSyncProfile(t.env, { storeRoot, profileId: "project" })).rejects.toMatchObject(
      {
        code: "WORKSPACE_ROOT_REQUIRED",
      },
    );
    const workspaceRoot = t.path("workspace");
    await t.env.fs.mkdir(workspaceRoot, { recursive: true });
    const first = await planSyncProfile(t.env, { storeRoot, profileId: "project", workspaceRoot });
    const second = await planSyncProfile(t.env, { storeRoot, profileId: "project", workspaceRoot });

    expect(first.workspaceRoot).toBe(workspaceRoot);
    expect(first.resolvedResources.map(({ resourceId }) => resourceId)).toEqual([
      "rules/safety",
      "rules/style",
    ]);
    expect(first.resolvedResources.every(({ revision }) => revision.startsWith("sha256:"))).toBe(
      true,
    );
    expect(first.resolvedAgents).toEqual(["codex"]);
    expect(first.plan.actions.map(({ target }) => target)).toEqual(
      second.plan.actions.map(({ target }) => target),
    );
    expect(first.plan.actions.every(({ target }) => target.startsWith(workspaceRoot))).toBe(true);
    expect(first.plan.actions.flatMap(({ artifactIds }) => artifactIds ?? [])).toEqual([
      "rules/safety",
      "rules/style",
    ]);

    const missingCollection = await loadConfig(t.env, storeRoot);
    delete missingCollection.collections.work;
    await saveConfig(t.env, storeRoot, missingCollection);
    await expect(
      planSyncProfile(t.env, { storeRoot, profileId: "project", workspaceRoot }),
    ).rejects.toMatchObject({
      code: "MISSING_PROFILE_DEPENDENCY",
      details: { collections: ["work"] },
    });
  }, 30_000);

  // These real transactions must finish before fixture teardown; Vitest timeouts do not cancel them.
  it.each([
    ["missing", undefined],
    ["stale", deterministicMutationAuthority({ isCurrent: async () => false })],
  ] as const)(
    "rejects %s authority before any sync profile product read",
    async (_label, mutationAuthority) => {
      await createSyncProfile(t.env, { storeRoot, profileId: "daily", desired });
      const planned = await planSyncProfile(t.env, { storeRoot, profileId: "daily" });
      await applySyncProfilePlan(t.env, planned.mutationPlan, {
        storeRoot,
        profileId: "daily",
      });
      const uninstall = await planSyncProfileUninstall(t.env, {
        storeRoot,
        profileId: "daily",
      });

      const productReads: string[] = [];
      const originalFs = t.env.fs;
      t.env.fs = new Proxy(originalFs, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          return (..._args: unknown[]) => {
            productReads.push(String(property));
            throw new Error(`unexpected product read: ${String(property)}`);
          };
        },
      });
      t.env.mutationAuthority = mutationAuthority;

      const invocations = [
        () => planSyncProfile(t.env, { storeRoot, profileId: "daily" }),
        () =>
          applySyncProfilePlan(t.env, planned.mutationPlan, {
            storeRoot,
            profileId: "daily",
          }),
        () => planSyncProfileUninstall(t.env, { storeRoot, profileId: "daily" }),
        () =>
          applySyncProfileUninstallPlan(t.env, uninstall.mutationPlan, {
            storeRoot,
            profileId: "daily",
            targetKeys: uninstall.targetKeys,
          }),
      ];
      for (const invoke of invocations) {
        await expect(invoke()).rejects.toThrow(/mutation authority/i);
        expect(productReads).toEqual([]);
      }
    },
    30_000,
  );

  it("rejects tampered sync-profile apply plans before product-state observation", async () => {
    await createSyncProfile(t.env, { storeRoot, profileId: "daily", desired });
    const planned = await planSyncProfile(t.env, { storeRoot, profileId: "daily" });
    await applySyncProfilePlan(t.env, planned.mutationPlan, {
      storeRoot,
      profileId: "daily",
    });
    const uninstall = await planSyncProfileUninstall(t.env, {
      storeRoot,
      profileId: "daily",
    });
    const tamperedApply = { ...planned.mutationPlan, planId: "plan-tampered-apply" };
    const tamperedUninstall = {
      ...uninstall.mutationPlan,
      planId: "plan-tampered-uninstall",
    };

    const productReads: string[] = [];
    const originalFs = t.env.fs;
    t.env.fs = new Proxy(originalFs, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (..._args: unknown[]) => {
          productReads.push(String(property));
          throw new Error(`unexpected product read: ${String(property)}`);
        };
      },
    });

    const applied = await applySyncProfilePlan(t.env, tamperedApply, {
      storeRoot,
      profileId: "daily",
    });
    expect(applied.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });
    expect(productReads).toEqual([]);

    const removed = await applySyncProfileUninstallPlan(t.env, tamperedUninstall, {
      storeRoot,
      profileId: "daily",
      targetKeys: uninstall.targetKeys,
    });
    expect(removed.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });
    expect(productReads).toEqual([]);
  }, 30_000);

  // This real transaction must finish before fixture teardown; Vitest timeouts do not cancel it.
  it("holds one current authority lease across canonical profile resolution and sync planning", async () => {
    await createSyncProfile(t.env, { storeRoot, profileId: "daily", desired });
    let acquisitions = 0;
    let releases = 0;
    let leaseHeld = false;
    t.env.mutationAuthority = deterministicMutationAuthority({
      onAcquireLease: () => {
        acquisitions += 1;
        leaseHeld = true;
      },
      onReleaseLease: () => {
        releases += 1;
        leaseHeld = false;
      },
    });
    const originalFs = t.env.fs;
    t.env.fs = new Proxy(originalFs, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (!leaseHeld)
            throw new Error(`product read outside authority lease: ${String(property)}`);
          return Reflect.apply(value, target, args);
        };
      },
    });

    await planSyncProfile(t.env, { storeRoot, profileId: "daily" });

    expect(acquisitions).toBe(1);
    expect(releases).toBe(1);
    expect(leaseHeld).toBe(false);
  }, 30_000);

  // This real transaction must finish before fixture teardown; Vitest timeouts do not cancel it.
  it("applies, verifies, dry-runs, and applies uninstall without removing profile or resources", async () => {
    await createSyncProfile(t.env, { storeRoot, profileId: "daily", desired });
    const planned = await planSyncProfile(t.env, { storeRoot, profileId: "daily" });
    const applied = await applySyncProfilePlan(t.env, planned.mutationPlan, {
      storeRoot,
      profileId: "daily",
    });
    expect(applied.operation).toMatchObject({ ok: true });
    expect(applied.entries).toHaveLength(1);

    const verification = await verifySyncProfile(t.env, { storeRoot, profileId: "daily" });
    expect(verification).toMatchObject({
      healthy: true,
      profileRevision: planned.profile.revision,
    });

    const uninstall = await planSyncProfileUninstall(t.env, {
      storeRoot,
      profileId: "daily",
    });
    expect(uninstall.targets).toHaveLength(1);
    expect(uninstall.targets[0]).toMatchObject({ blocked: false });
    expect(await t.env.fs.readFile(uninstall.targets[0]!.target)).toContain("# Style");

    const removed = await applySyncProfileUninstallPlan(t.env, uninstall.mutationPlan, {
      storeRoot,
      profileId: "daily",
      targetKeys: uninstall.targetKeys,
    });
    expect(removed.operation).toMatchObject({ ok: true });
    await expect(t.env.fs.lstat(uninstall.targets[0]!.target)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await showSyncProfile(t.env, { storeRoot, profileId: "daily" })).profile,
    ).not.toBeNull();
    expect(await t.env.fs.readFile(t.path("home", ".cellarer", "store", "rules", "style.md"))).toBe(
      "# Style\n",
    );
  }, 30_000);

  it("rejects caller-forged sync profile owner evidence and binds canonical registry provenance", async () => {
    await createSyncProfile(t.env, { storeRoot, profileId: "daily", desired });
    const forged = {
      storeRoot,
      scope: "global" as const,
      agents: ["codex"],
      resourceIds: ["rules/style"],
      capabilities: ["rules" as const],
      method: "copy" as const,
      mcpStrategy: "merge" as const,
      syncProfile: {
        profileId: "forged",
        profileRevision: `sha256:${"f".repeat(64)}`,
        resolvedResources: [
          {
            resourceId: "rules/style",
            revision: `sha256:${"e".repeat(64)}`,
            capability: "rules" as const,
          },
        ],
      },
    };

    await expect(apply(t.env, forged)).rejects.toThrow(/sync profile/i);

    const planned = await planSyncProfile(t.env, { storeRoot, profileId: "daily" });
    expect(planned.mutationPlan.normalizedInputs.storeProvenance).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: join(storeRoot, "profiles.json") })]),
    );
  });

  // Vitest timeouts do not cancel async work, so finish this transaction before fixture teardown.
  it("rebuilds canonical profile evidence under lock and rejects forged or stale sealed plans", async () => {
    await createSyncProfile(t.env, { storeRoot, profileId: "daily", desired });
    const planned = await planSyncProfile(t.env, { storeRoot, profileId: "daily" });
    const forgedEvidence = {
      profileId: "daily",
      profileRevision: `sha256:${"f".repeat(64)}`,
      resolvedResources: planned.resolvedResources,
    };
    const forged = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: planned.mutationPlan.schemaVersion,
      planId: "plan-forged-profile-evidence",
      operation: planned.mutationPlan.operation,
      baseRevision: planned.mutationPlan.baseRevision,
      normalizedInputs: {
        ...planned.mutationPlan.normalizedInputs,
        syncProfile: forgedEvidence,
      },
      targetPreconditions: planned.mutationPlan.targetPreconditions,
      actions: planned.mutationPlan.actions,
      expires: planned.mutationPlan.expires,
    });
    const forgedResult = await applyMutationPlan(t.env, forged, { storeRoot });
    expect(forgedResult.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });

    const generic = await planApplyMutation(t.env, {
      storeRoot,
      scope: "global",
      agents: ["codex"],
      resourceIds: ["rules/style"],
      capabilities: ["rules"],
      method: "copy",
      mcpStrategy: "merge",
    });
    const omittedResult = await applySyncProfilePlan(t.env, generic.mutationPlan, {
      storeRoot,
      profileId: "daily",
    });
    expect(omittedResult.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });

    await updateSyncProfile(t.env, {
      storeRoot,
      profileId: "daily",
      desired: { ...desired, collectionIds: ["default"] },
    });
    const staleResult = await applyMutationPlan(t.env, planned.mutationPlan, { storeRoot });
    expect(staleResult.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });
  }, 30_000);

  // Vitest timeouts do not cancel async work, so finish this transaction before fixture teardown.
  it("diverges when exact target bytes match but sync profile owner provenance differs", async () => {
    await createSyncProfile(t.env, { storeRoot, profileId: "profile-a", desired });
    await createSyncProfile(t.env, { storeRoot, profileId: "profile-b", desired });
    const planB = await planSyncProfile(t.env, { storeRoot, profileId: "profile-b" });
    await applySyncProfilePlan(t.env, planB.mutationPlan, {
      storeRoot,
      profileId: "profile-b",
    });

    const verification = await verifySyncProfile(t.env, {
      storeRoot,
      profileId: "profile-a",
    });
    expect(verification.healthy).toBe(false);
    expect(verification.desiredVsApplied).toMatchObject({
      status: "diverged",
      items: [
        expect.objectContaining({
          status: "provenance-mismatch",
          comparisons: expect.objectContaining({ provenance: "mismatched" }),
        }),
      ],
    });
  }, 30_000);

  it("keeps a drifted profile target unchanged and returns its exact uninstall acknowledgement", async () => {
    await createSyncProfile(t.env, { storeRoot, profileId: "daily", desired });
    const planned = await planSyncProfile(t.env, { storeRoot, profileId: "daily" });
    const applied = await applySyncProfilePlan(t.env, planned.mutationPlan, {
      storeRoot,
      profileId: "daily",
    });
    const target = applied.entries[0]!.target;
    await t.env.fs.writeFile(target, "user drift\n");

    const uninstall = await planSyncProfileUninstall(t.env, {
      storeRoot,
      profileId: "daily",
    });
    expect(uninstall.targets).toEqual([
      expect.objectContaining({
        target,
        blocked: true,
        classification: "owned-drifted",
        acknowledgement: {
          kind: "uninstall-drift",
          token: expect.stringMatching(/^sha256:/),
        },
      }),
    ]);
    expect(uninstall.conflicts).toEqual([
      expect.objectContaining({ code: "UNINSTALL_TARGET_DRIFTED", target }),
    ]);
    await expect(t.env.fs.readFile(target)).resolves.toBe("user drift\n");
  }, 20_000);

  it("detaches one profile while another profile and ad-hoc consumer keep the shared target", async () => {
    await createSyncProfile(t.env, { storeRoot, profileId: "profile-a", desired });
    await createSyncProfile(t.env, { storeRoot, profileId: "profile-b", desired });

    const planA = await planSyncProfile(t.env, { storeRoot, profileId: "profile-a" });
    await applySyncProfilePlan(t.env, planA.mutationPlan, {
      storeRoot,
      profileId: "profile-a",
    });
    const planB = await planSyncProfile(t.env, { storeRoot, profileId: "profile-b" });
    await applySyncProfilePlan(t.env, planB.mutationPlan, {
      storeRoot,
      profileId: "profile-b",
    });

    const uninstallA = await planSyncProfileUninstall(t.env, {
      storeRoot,
      profileId: "profile-a",
    });
    expect(uninstallA.conflicts).toEqual([]);
    expect(uninstallA.targets[0]?.proposedAction).toBe("detach-consumer");
    const sharedTarget = uninstallA.targets[0];
    if (!sharedTarget) throw new Error("expected shared target");
    const detached = await applySyncProfileUninstallPlan(t.env, uninstallA.mutationPlan, {
      storeRoot,
      profileId: "profile-a",
      targetKeys: uninstallA.targetKeys,
    });
    expect(detached.operation.ok).toBe(true);
    await expect(t.env.fs.readFile(sharedTarget.target)).resolves.toContain("# Style");

    const direct = await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["codex"],
      resourceIds: ["rules/style"],
      capabilities: ["rules"],
      method: "copy",
      mcpStrategy: "merge",
    });
    expect(direct.failures).toEqual([]);
    const uninstallB = await planSyncProfileUninstall(t.env, {
      storeRoot,
      profileId: "profile-b",
    });
    expect(uninstallB.conflicts).toEqual([]);
    expect(uninstallB.targets[0]?.proposedAction).toBe("detach-consumer");
    const detachedB = await applySyncProfileUninstallPlan(t.env, uninstallB.mutationPlan, {
      storeRoot,
      profileId: "profile-b",
      targetKeys: uninstallB.targetKeys,
    });
    expect(detachedB.operation.ok).toBe(true);
    await expect(t.env.fs.readFile(sharedTarget.target)).resolves.toContain("# Style");
  }, 20_000);

  it("blocks profile update and delete while old exact profile owners remain uninstallable", async () => {
    await writeRuleArtifact(t.env, storeRoot, "safety", "# Safety\n");
    await createSyncProfile(t.env, { storeRoot, profileId: "daily", desired });
    const planned = await planSyncProfile(t.env, { storeRoot, profileId: "daily" });
    await applySyncProfilePlan(t.env, planned.mutationPlan, {
      storeRoot,
      profileId: "daily",
    });

    const replacement = {
      ...desired,
      agentIds: ["claude-code"],
      resourceIds: ["rules/safety"],
    };
    await expect(
      updateSyncProfile(t.env, {
        storeRoot,
        profileId: "daily",
        desired: replacement,
      }),
    ).rejects.toMatchObject({
      code: "PROFILE_TARGETS_OWNED",
      details: { profileId: "daily", targetKeys: [expect.any(String)] },
    });
    await expect(deleteSyncProfile(t.env, { storeRoot, profileId: "daily" })).rejects.toMatchObject(
      {
        code: "PROFILE_TARGETS_OWNED",
        details: { profileId: "daily", targetKeys: [expect.any(String)] },
      },
    );

    const uninstall = await planSyncProfileUninstall(t.env, {
      storeRoot,
      profileId: "daily",
    });
    expect(uninstall.profile.revision).toBe(planned.profile.revision);
    const removed = await applySyncProfileUninstallPlan(t.env, uninstall.mutationPlan, {
      storeRoot,
      profileId: "daily",
      targetKeys: uninstall.targetKeys,
    });
    expect(removed.operation).toMatchObject({ ok: true });

    const updated = await updateSyncProfile(t.env, {
      storeRoot,
      profileId: "daily",
      desired: replacement,
    });
    expect(updated.operation).toMatchObject({ ok: true });

    const replacementPlan = await planSyncProfile(t.env, { storeRoot, profileId: "daily" });
    await applySyncProfilePlan(t.env, replacementPlan.mutationPlan, {
      storeRoot,
      profileId: "daily",
    });
    await expect(deleteSyncProfile(t.env, { storeRoot, profileId: "daily" })).rejects.toMatchObject(
      { code: "PROFILE_TARGETS_OWNED" },
    );
    const replacementUninstall = await planSyncProfileUninstall(t.env, {
      storeRoot,
      profileId: "daily",
    });
    await applySyncProfileUninstallPlan(t.env, replacementUninstall.mutationPlan, {
      storeRoot,
      profileId: "daily",
      targetKeys: replacementUninstall.targetKeys,
    });
    const deleted = await deleteSyncProfile(t.env, { storeRoot, profileId: "daily" });
    expect(deleted.operation).toMatchObject({ ok: true });
  }, 40_000);
});
