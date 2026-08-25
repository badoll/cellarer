import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { add } from "../src/engine/add.js";
import { apply, applyMutationPlan, planApplyMutation } from "../src/engine/apply.js";
import { applyRevertMutationPlan, planRevertMutation } from "../src/engine/revert.js";
import type { Env, FsLike, SecretStore } from "../src/env.js";
import { mutationPlanDigest } from "../src/protocol/canonical.js";
import { operationJournalPath } from "../src/protocol/journal.js";
import type { MutationPlan } from "../src/protocol/models.js";
import { mutationLockPath } from "../src/protocol/mutation-lock.js";
import { diagnoseMutationRecovery } from "../src/protocol/recovery.js";
import { initStore, writeRuleArtifact } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

describe("scoped executable mutation authority", () => {
  it("rejects a captured legacy scan plan before authority use or product observation", async () => {
    const t = makeTmpEnv();
    try {
      await ensureBaseDirs(t);
      const storeRoot = t.path("home", ".cellarer");
      await initStore(t.env, storeRoot);
      await writeRuleArtifact(t.env, storeRoot, "captured", "captured bytes\n");
      const prepared = await planApplyMutation(t.env, {
        storeRoot,
        scope: "global",
        agents: ["claude-code"],
        capabilities: ["rules"],
      });
      const secretCanary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
      const capturedLegacyPlan = {
        ...prepared.mutationPlan,
        operation: "store-import",
        normalizedInputs: { mutationKind: "scan-import", secretCanary },
      } as MutationPlan;
      let authorityCalls = 0;
      let filesystemCalls = 0;
      const protectedEnv: Env = {
        ...t.env,
        mutationAuthority: new Proxy(t.env.mutationAuthority, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            return (..._args: unknown[]) => {
              authorityCalls += 1;
              throw new Error(`unexpected captured-plan authority use: ${String(property)}`);
            };
          },
        }),
        fs: new Proxy(t.env.fs, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            return (..._args: unknown[]) => {
              filesystemCalls += 1;
              throw new Error(`unexpected captured-plan observation: ${String(property)}`);
            };
          },
        }) as FsLike,
      };

      const rejected = await applyMutationPlan(protectedEnv, capturedLegacyPlan, { storeRoot });

      expect(rejected.operation).toMatchObject({
        ok: false,
        conflict: { code: "INVALID_PLAN" },
      });
      expect(JSON.stringify(rejected)).not.toContain(secretCanary);
      expect(authorityCalls).toBe(0);
      expect(filesystemCalls).toBe(0);
    } finally {
      await t.cleanup();
    }
  });

  it.each([
    [
      "apply",
      (env: Env, storeRoot: string) =>
        apply(env, {
          storeRoot,
          scope: "global",
          agents: ["claude-code"],
          capabilities: ["rules"],
        }),
    ],
    [
      "add",
      (env: Env, storeRoot: string, t: ReturnType<typeof makeTmpEnv>) =>
        add(env, { storeRoot, source: t.path("unobserved-source.md") }),
    ],
    [
      "recovery diagnosis",
      (env: Env, storeRoot: string) => diagnoseMutationRecovery(env, storeRoot),
    ],
  ])("15.1 rejects stale authority before every %s product observation", async (_label, run) => {
    const t = makeTmpEnv();
    try {
      await ensureBaseDirs(t);
      const storeRoot = t.path("home", ".cellarer");
      await initStore(t.env, storeRoot);
      const observations: string[] = [];
      const env: Env = {
        ...t.env,
        mutationAuthority: deterministicMutationAuthority({
          isCurrent: async () => false,
        }),
        fs: new Proxy(t.env.fs, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver) as unknown;
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              observations.push(`${String(property)}:${String(args[0] ?? "")}`);
              return (value as (...inner: unknown[]) => unknown).apply(target, args);
            };
          },
        }) as FsLike,
      };

      await expect(run(env, storeRoot, t)).rejects.toThrow(/authority.*current/i);
      expect(observations).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });

  it("15.3 reuses one authority lease from the add preflight through canonical execution", async () => {
    const t = makeTmpEnv();
    try {
      await ensureBaseDirs(t);
      const storeRoot = t.path("home", ".cellarer");
      await initStore(t.env, storeRoot);
      const source = t.path("one-lease.md");
      await t.env.fs.writeFile(source, "# one lease\n");
      let acquisitions = 0;
      let releases = 0;
      let active = false;
      const authority = deterministicMutationAuthority({
        onAcquireLease: () => {
          acquisitions += 1;
          if (active) throw new Error("nested authority lease acquisition");
          active = true;
        },
        onReleaseLease: () => {
          releases += 1;
          active = false;
        },
      });

      await expect(
        add({ ...t.env, mutationAuthority: authority }, { storeRoot, source }),
      ).resolves.toMatchObject({
        imported: [expect.objectContaining({ kind: "rules", name: "one-lease" })],
      });
      expect({ acquisitions, releases, active }).toEqual({
        acquisitions: 1,
        releases: 1,
        active: false,
      });
    } finally {
      await t.cleanup();
    }
  });

  it("rejects a stale long-running authority before canonical replanning or Store observation", async () => {
    const t = makeTmpEnv();
    try {
      await ensureBaseDirs(t);
      const storeRoot = t.path("home", ".cellarer");
      await initStore(t.env, storeRoot);
      await writeRuleArtifact(t.env, storeRoot, "style", "planned content");
      const options = {
        storeRoot,
        scope: "global" as const,
        agents: ["claude-code"],
        capabilities: ["rules" as const],
      };
      const prepared = await planApplyMutation(t.env, options);
      const reads: string[] = [];
      const stale = deterministicMutationAuthority({
        isCurrent: async () => false,
      });
      const env: Env = {
        ...t.env,
        mutationAuthority: stale,
        fs: new Proxy(t.env.fs, {
          get(target, property, receiver) {
            if (property === "readFile" || property === "readFileBytes" || property === "lstat") {
              return async (path: string, ...args: unknown[]) => {
                reads.push(path);
                return Reflect.apply(
                  Reflect.get(target, property, receiver) as (...callArgs: unknown[]) => unknown,
                  target,
                  [path, ...args],
                );
              };
            }
            return Reflect.get(target, property, receiver);
          },
        }),
      };

      const result = await applyMutationPlan(env, prepared.mutationPlan, {
        storeRoot,
        options,
      });

      expect(result.operation).toMatchObject({
        ok: false,
        conflict: { code: "INVALID_PLAN" },
      });
      expect(reads).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });

  it("rechecks currentness under the Store mutation lock and releases the stale lease", async () => {
    const t = makeTmpEnv();
    try {
      await ensureBaseDirs(t);
      const storeRoot = t.path("home", ".cellarer");
      await initStore(t.env, storeRoot);
      await writeRuleArtifact(t.env, storeRoot, "style", "planned content");
      const options = {
        storeRoot,
        scope: "global" as const,
        agents: ["claude-code"],
        capabilities: ["rules" as const],
      };
      const prepared = await planApplyMutation(t.env, options);
      const lockPath = mutationLockPath(storeRoot);
      const observedAfterRotation: string[] = [];
      let current = true;
      let releases = 0;
      const staleAfterLock = deterministicMutationAuthority({
        isCurrent: async () => current,
        onReleaseLease: () => {
          releases += 1;
        },
      });
      const fs = new Proxy(t.env.fs, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            if (!current && typeof args[0] === "string") observedAfterRotation.push(args[0]);
            const result = await (value as (...inner: unknown[]) => unknown).apply(target, args);
            if (property === "writeFileExclusive" && args[0] === lockPath && result === true) {
              current = false;
            }
            return result;
          };
        },
      }) as FsLike;
      const env: Env = { ...t.env, fs, mutationAuthority: staleAfterLock };

      const result = await applyMutationPlan(env, prepared.mutationPlan, { storeRoot, options });

      expect(result.operation).toEqual(invalidPlan());
      expect(new Set(observedAfterRotation)).toEqual(new Set([lockPath]));
      expect(releases).toBe(1);
      await expect(t.env.fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(t.env.fs.lstat(operationJournalPath(storeRoot))).rejects.toMatchObject({
        code: "ENOENT",
      });
      for (const action of prepared.plan.actions.filter((action) => action.op !== "skip")) {
        await expect(t.env.fs.lstat(action.target)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await t.cleanup();
    }
  });

  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
    await writeRuleArtifact(t.env, storeRoot, "authority", "authorized bytes\n");
  });

  afterEach(() => t.cleanup());

  const applyOptions = () => ({
    storeRoot,
    scope: "global" as const,
    agents: ["claude-code"],
    capabilities: ["rules" as const],
  });

  it("7.2 uses a deterministic, domain-separated HMAC capability that cannot serialize its key", () => {
    const rawKey = "raw-authority-key-never-observable";
    const authority = deterministicMutationAuthority({
      authorityId: "authority-v1",
      authorityEpoch: 7,
      key: rawKey,
    });
    const request = {
      schemaVersion: 1 as const,
      domain: "executable-plan-v1" as const,
      normalizedStoreRoot: storeRoot,
      operation: "apply" as const,
      baseRevision: 3,
      canonicalPayload: '{"exact":"payload"}',
    };

    const first = authority.seal(request);
    const second = authority.seal(request);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 1,
      domain: "executable-plan-v1",
      algorithm: "HMAC-SHA-256",
      authorityId: "authority-v1",
      authorityEpoch: 7,
    });
    expect(first.seal).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(authority.verify(request, first)).toBe(true);
    expect(authority.verify({ ...request, operation: "revert" }, first)).toBe(false);
    expect(JSON.stringify(authority)).toBe("{}");
    expect(JSON.stringify({ authority, envelope: first })).not.toContain(rawKey);
  });

  it("7.1 rejects same-options apply and revert plans changed and re-digested without a new seal", async () => {
    const applyPlan = (await planApplyMutation(t.env, applyOptions())).mutationPlan;
    const applyAction = applyPlan.actions[0];
    if (!applyAction) throw new Error("expected an apply action");
    const forgedApply = reDigest({
      ...applyPlan,
      actions: [
        {
          ...applyAction,
          target: t.path("outside", "same-options-apply-forgery"),
          payload: { ...applyAction.payload, forged: true },
        },
      ],
    });

    const applyObserved = trackedEnv(t.env);
    const rejectedApply = await applyMutationPlan(applyObserved.env, forgedApply, {
      storeRoot,
      options: applyOptions(),
    });
    expect(rejectedApply.operation).toEqual(invalidPlan());
    expect(applyObserved.calls()).toEqual({ fs: 0, provider: 0 });

    const acceptedApply = await applyMutationPlan(t.env, applyPlan, {
      storeRoot,
      options: applyOptions(),
    });
    expect(acceptedApply.operation).toMatchObject({ ok: true });
    const revertPlan = (await planRevertMutation(t.env, { storeRoot, agents: ["claude-code"] }))
      .mutationPlan;
    const revertAction = revertPlan.actions[0];
    if (!revertAction) throw new Error("expected a revert action");
    const forgedRevert = reDigest({
      ...revertPlan,
      actions: [
        {
          ...revertAction,
          target: t.path("outside", "same-options-revert-forgery"),
          payload: { ...revertAction.payload, forged: true },
        },
      ],
    });

    const revertObserved = trackedEnv(t.env);
    const rejectedRevert = await applyRevertMutationPlan(revertObserved.env, forgedRevert, {
      storeRoot,
      options: { storeRoot, agents: ["claude-code"] },
    });
    expect(rejectedRevert.operation).toEqual(invalidPlan());
    expect(revertObserved.calls()).toEqual({ fs: 0, provider: 0 });
  });

  it("7.1 rejects a plan sealed for another normalized Store before all interactions", async () => {
    const plan = (await planApplyMutation(t.env, applyOptions())).mutationPlan;
    const otherStoreRoot = t.path("home", "other-cellarer");
    const observed = trackedEnv(t.env);

    const rejected = await applyMutationPlan(observed.env, plan, {
      storeRoot: otherStoreRoot,
      options: { ...applyOptions(), storeRoot: otherStoreRoot },
    });

    expect(rejected.operation).toEqual(invalidPlan());
    expect(observed.calls()).toEqual({ fs: 0, provider: 0 });
  });

  it("7.1 rejects altered, malformed, or missing authorization envelopes identically", async () => {
    const plan = (await planApplyMutation(t.env, applyOptions())).mutationPlan;
    const envelope = plan.authorization;
    const candidates: MutationPlan[] = [
      { ...plan, authorization: { ...envelope, authorityId: "other-authority" } },
      { ...plan, authorization: { ...envelope, authorityEpoch: envelope.authorityEpoch + 1 } },
      { ...plan, authorization: { ...envelope, seal: "hmac-sha256:" + "0".repeat(64) } },
      { ...plan, authorization: { ...envelope, domain: "durable-plan-v1" } as never },
      { ...plan, authorization: { ...envelope, algorithm: "SHA-256" } as never },
      { ...plan, authorization: { ...envelope, schemaVersion: 99 } as never },
      { ...plan, authorization: undefined } as unknown as MutationPlan,
    ];

    for (const candidate of candidates) {
      const observed = trackedEnv(t.env);
      const rejected = await applyMutationPlan(observed.env, candidate, {
        storeRoot,
        options: applyOptions(),
      });
      expect(rejected.operation).toEqual(invalidPlan());
      expect(observed.calls()).toEqual({ fs: 0, provider: 0 });
      expect(JSON.stringify(rejected)).not.toMatch(
        /other-authority|durable-plan-v1|SHA-256|hmac-sha256/,
      );
    }
  });

  it("7.1 fails closed when authority is missing without config, registry, ledger, target, provider, lock, journal, activity, or presentation interaction", async () => {
    const plan = (await planApplyMutation(t.env, applyOptions())).mutationPlan;
    const observed = trackedEnv({ ...t.env, mutationAuthority: undefined });

    await expect(planApplyMutation(observed.env, applyOptions())).rejects.toThrow(
      "mutation authority is unavailable",
    );
    expect(observed.calls()).toEqual({ fs: 0, provider: 0 });

    const rejected = await applyMutationPlan(observed.env, plan, {
      storeRoot,
      options: applyOptions(),
    });

    expect(rejected.operation).toEqual(invalidPlan());
    expect(observed.calls()).toEqual({ fs: 0, provider: 0 });
    expect(JSON.stringify(rejected)).not.toMatch(
      new RegExp(`${plan.planId}|${plan.digest}|${plan.authorization.authorityId}`),
    );
  });
});

function reDigest(plan: MutationPlan): MutationPlan {
  return { ...plan, digest: mutationPlanDigest(plan) };
}

function invalidPlan() {
  return {
    ok: false,
    conflict: { code: "INVALID_PLAN", message: "mutation plan is invalid" },
  } as const;
}

function trackedEnv(env: Env): { env: Env; calls(): { fs: number; provider: number } } {
  let fsCalls = 0;
  let providerCalls = 0;
  const fs = new Proxy(env.fs, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        fsCalls += 1;
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as FsLike;
  const secretStore: SecretStore = {
    async get() {
      providerCalls += 1;
      return { found: false };
    },
    async set() {
      providerCalls += 1;
    },
    async delete() {
      providerCalls += 1;
      return false;
    },
  };
  return {
    env: { ...env, fs, secretStore },
    calls: () => ({ fs: fsCalls, provider: providerCalls }),
  };
}
