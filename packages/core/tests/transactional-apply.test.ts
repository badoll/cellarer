import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply, applyMutationPlan, planApplyMutation } from "../src/engine/apply.js";
import { applyRevertMutationPlan, planRevertMutation } from "../src/engine/revert.js";
import type { Env } from "../src/env.js";
import type { PlanAction } from "../src/model/index.js";
import {
  createAuthorizedMutationPlan,
  createMutationPlan,
  mutationPlanDigest,
  verifyMutationPlanDigest,
} from "../src/protocol/canonical.js";
import {
  operationJournalPath,
  operationReceiptPath,
  readOperationJournal,
  readOperationReceipt,
} from "../src/protocol/journal.js";
import type { CanonicalJsonObject, MutationPlan } from "../src/protocol/models.js";
import {
  acquireStoreMutationLock,
  mutationLockPath,
  recoveryLockPath,
} from "../src/protocol/mutation-lock.js";
import {
  publishStoreRevision,
  readStoreRevision,
  storeRevisionPath,
} from "../src/protocol/store-revision.js";
import { createProviderScope, withProviderScope } from "../src/secrets/active-values.js";
import { observableKnownValues, serializeObservable } from "../src/secrets/observable.js";
import { resolveActiveSecretValues } from "../src/secrets/provider-runtime.js";
import { environmentSecretReference } from "../src/secrets/reference.js";
import { sha256 } from "../src/store/checksum.js";
import { saveLedger } from "../src/store/ledger.js";
import { initStore, writeRuleArtifact } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("exclusive planned apply and revert", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
    await writeRuleArtifact(t.env, storeRoot, "style", "planned content");
  });
  afterEach(() => t.cleanup());

  const options = () => ({
    storeRoot,
    scope: "global" as const,
    agents: ["claude-code"],
    capabilities: ["rules" as const],
  });
  const target = () => t.path("home", ".claude", "CLAUDE.md");
  const applyReceipt = (mutationPlan: Parameters<typeof applyMutationPlan>[1]) =>
    applyMutationPlan(t.env, mutationPlan, { storeRoot, options: options() });
  const revertReceipt = (mutationPlan: Parameters<typeof applyRevertMutationPlan>[1]) =>
    applyRevertMutationPlan(t.env, mutationPlan, {
      storeRoot,
      options: { storeRoot, agents: ["claude-code"] },
    });

  it("rejects a tampered plan digest before target mutation", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const tampered = { ...prepared.mutationPlan, baseRevision: 99 };

    const result = await applyReceipt(tampered);

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });
    await expect(t.env.fs.lstat(target())).rejects.toThrow();
  });

  it("attaches one redaction scope to runtime, digest, and decode failures", async () => {
    const secret = "tiny-early-scope";
    const scope = createProviderScope({ secretMode: "env" });
    const operationEnv = withProviderScope(
      { ...t.env, env: { ...t.env.env, EARLY_SCOPE_SECRET: secret } },
      scope,
    );
    await resolveActiveSecretValues(
      operationEnv,
      storeRoot,
      [environmentSecretReference("EARLY_SCOPE_SECRET")],
      { secretMode: "env" },
    );
    const prepared = await planApplyMutation(t.env, options());
    const runtimeInvalid = {
      ...prepared.mutationPlan,
      schemaVersion: secret,
    } as unknown as MutationPlan;
    const digestInvalid = {
      ...prepared.mutationPlan,
      baseRevision: prepared.mutationPlan.baseRevision + 1,
    } as MutationPlan;
    const action = prepared.mutationPlan.actions[0];
    if (!action) throw new Error("expected an apply action");
    const decodeInvalid = createMutationPlan({
      ...prepared.mutationPlan,
      actions: [
        {
          ...action,
          actionId: `invalid-${secret}`,
          payload: { planAction: "malformed" },
        },
      ],
    });

    for (const invalid of [runtimeInvalid, decodeInvalid]) {
      const rejected = await applyMutationPlan(operationEnv, invalid, {
        storeRoot,
        options: options(),
      });
      expect(rejected.operation).toMatchObject({
        ok: false,
        conflict: { code: "INVALID_PLAN" },
      });
      expect(observableKnownValues(rejected)).toBe(scope.knownValues);
      expect(
        serializeObservable("error", rejected, {
          knownValues: observableKnownValues(rejected),
        }),
      ).not.toContain(secret);
    }

    const rejected = await applyMutationPlan(operationEnv, digestInvalid, {
      storeRoot,
      options: options(),
    });
    expect(rejected.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });
    expect(observableKnownValues(rejected)).toBe(scope.knownValues);
    expect(
      serializeObservable("cli", rejected, {
        knownValues: observableKnownValues(rejected),
      }),
    ).not.toContain(secret);
  });

  it("rejects untrusted early apply plans without provider reads, lock effects, or raw-value echoes", async () => {
    const secret = "tiny-raw-plan";
    await writeRuleArtifact(
      t.env,
      storeRoot,
      "style",
      "use $" + "{CELLARER_SECRET:EARLY_PLAN_SECRET}",
    );
    const prepared = await planApplyMutation(t.env, options());
    const action = prepared.mutationPlan.actions[0];
    if (!action) throw new Error("expected an apply action");
    const rawPlanAction = action.payload.planAction;
    if (typeof rawPlanAction !== "object" || rawPlanAction === null) {
      throw new Error("expected an executable plan action");
    }
    const invalidPlans: MutationPlan[] = [
      {
        ...prepared.mutationPlan,
        schemaVersion: secret,
      } as unknown as MutationPlan,
      {
        ...prepared.mutationPlan,
        planId: secret,
        digest: secret,
      },
      createMutationPlan({
        ...prepared.mutationPlan,
        actions: [{ ...action, actionId: secret, payload: { planAction: "malformed" } }],
      }),
      createMutationPlan({
        ...prepared.mutationPlan,
        operation: secret,
      } as Parameters<typeof createMutationPlan>[0]),
      createMutationPlan({
        ...prepared.mutationPlan,
        actions: [
          {
            ...action,
            kind: secret,
            payload: { planAction: { ...rawPlanAction, op: secret } },
          },
        ],
      } as Parameters<typeof createMutationPlan>[0]),
    ];
    let providerReads = 0;
    let lockAttempts = 0;
    const writeFileExclusive = t.env.fs.writeFileExclusive;
    const env: Env = {
      ...t.env,
      secretStore: {
        async get() {
          providerReads += 1;
          return { found: true, value: secret };
        },
        async set() {},
        async delete() {
          return false;
        },
      },
      fs: {
        ...t.env.fs,
        async writeFileExclusive(path, data, opts) {
          lockAttempts += 1;
          return writeFileExclusive(path, data, opts);
        },
      },
    };

    for (const invalid of invalidPlans) {
      let observed: unknown;
      try {
        observed = await applyMutationPlan(env, invalid, {
          storeRoot,
          options: options(),
          secretMode: "keychain",
        });
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeDefined();
      expect(JSON.stringify(observed)).not.toContain(secret);
      if (observed instanceof Error) expect(observed.message).not.toContain(secret);
    }

    expect(providerReads).toBe(0);
    expect(lockAttempts).toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
  });

  it("rejects every malformed executable apply op before provider, lock, journal, or target effects", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const originalAction = prepared.mutationPlan.actions[0];
    if (!originalAction) throw new Error("expected an apply action");
    const targetRoot = t.path("home", ".strict-actions");
    const fingerprint = (character: string) => `sha256:${character.repeat(64)}`;
    const ownership = (
      agent: string,
      scope: PlanAction["scope"],
      capability: PlanAction["capability"],
      actionTarget: string,
    ) => ({
      key: JSON.stringify([agent, scope, capability, actionTarget]),
      classification: "absent" as const,
      target: actionTarget,
      currentFingerprint: null,
      expectedReceipt: null,
    });
    const common = (
      capability: PlanAction["capability"],
      name: string,
    ): Pick<PlanAction, "agent" | "scope" | "capability" | "target" | "ownership" | "reason"> => {
      const actionTarget = t.path("home", ".strict-actions", name);
      return {
        agent: "claude-code",
        scope: "global",
        capability,
        target: actionTarget,
        ownership: ownership("claude-code", "global", capability, actionTarget),
        reason: `${capability}/${name}`,
      };
    };
    const fixtures: PlanAction[] = [
      {
        ...common("rules", "write"),
        artifact: "rules/*",
        artifactIds: ["rules/style"],
        reason: "rules/style",
        method: "symlink",
        op: "write",
        preview: { after: "strict write" },
        desiredEvidence: {
          method: "write",
          contentFingerprint: sha256("strict write"),
        },
      },
      ...(["merge", "overwrite"] as const).map((op) => ({
        ...common("mcp", op),
        artifact: "mcp/context",
        artifactIds: ["mcp/context"],
        reason: "mcp/context",
        method: "copy" as const,
        op,
        preview: { after: "{}" },
        desiredEvidence: { method: "write" as const, contentFingerprint: fingerprint("a") },
        secretRefs: [],
        accidentalPlaintext: false,
      })),
      ...(["symlink", "copy"] as const).map((op) => ({
        ...common("skills", op),
        artifact: "skills/demo",
        artifactIds: ["skills/demo"],
        reason: "skills/demo",
        source: t.path("home", ".cellarer", "store", "skills", "demo"),
        method: op,
        op,
        desiredEvidence: {
          method: op,
          sourceFingerprint: fingerprint("b"),
          sourceIdentity: fingerprint("c"),
        },
      })),
    ];
    const forgedOutsideTarget = t.path("outside-managed-root", "forged-target");
    const mutations: Array<{
      name: string;
      alter(action: Record<string, unknown>): void;
    }> = [
      {
        name: "missing agent",
        alter: (action) => {
          delete action.agent;
        },
      },
      {
        name: "wrong agent type",
        alter: (action) => {
          action.agent = 42;
        },
      },
      {
        name: "forged agent",
        alter: (action) => {
          action.agent = "attacker";
        },
      },
      {
        name: "unknown scope",
        alter: (action) => {
          action.scope = "workspace";
        },
      },
      {
        name: "inconsistent capability",
        alter: (action) => {
          action.capability = action.capability === "rules" ? "mcp" : "rules";
        },
      },
      {
        name: "inconsistent method",
        alter: (action) => {
          action.method =
            action.op === "write" ? "write" : action.method === "copy" ? "symlink" : "copy";
        },
      },
      {
        name: "forged artifact ids",
        alter: (action) => {
          action.artifactIds = ["rules/forged"];
        },
      },
      {
        name: "forged target outside the managed root",
        alter: (action) => {
          action.target = forgedOutsideTarget;
          action.ownership = ownership(
            String(action.agent),
            action.scope as PlanAction["scope"],
            action.capability as PlanAction["capability"],
            forgedOutsideTarget,
          );
        },
      },
      {
        name: "forged source outside the store",
        alter: (action) => {
          action.source = t.path("outside-store", "source");
        },
      },
      {
        name: "invalid preview",
        alter: (action) => {
          action.preview = action.capability === "skills" ? { after: "forged" } : "not-an-object";
        },
      },
      {
        name: "invalid desired evidence",
        alter: (action) => {
          action.desiredEvidence =
            action.capability === "skills"
              ? { method: action.method, sourceFingerprint: 7, sourceIdentity: fingerprint("c") }
              : action.capability === "mcp"
                ? { method: "copy", contentFingerprint: fingerprint("d") }
                : { method: "write", contentFingerprint: fingerprint("d") };
        },
      },
      {
        name: "unknown field",
        alter: (action) => {
          action.untrusted = true;
        },
      },
    ];
    const normalizedInputs = JSON.parse(
      JSON.stringify(prepared.mutationPlan.normalizedInputs),
    ) as Record<string, unknown>;
    normalizedInputs.capabilities = ["rules", "mcp", "skills"];
    let providerReads = 0;
    let lockAttempts = 0;
    let journalWrites = 0;
    let targetEffects = 0;
    const targets = new Set([...fixtures.map((action) => action.target), forgedOutsideTarget]);
    const originalFs = t.env.fs;
    const env: Env = {
      ...t.env,
      secretStore: {
        async get() {
          providerReads += 1;
          return { found: false };
        },
        async set() {},
        async delete() {
          return false;
        },
      },
      fs: {
        ...originalFs,
        async writeFileExclusive(path, data, opts) {
          lockAttempts += 1;
          return originalFs.writeFileExclusive(path, data, opts);
        },
        async publishFileAtomically(path, data, opts) {
          if (path === operationJournalPath(storeRoot)) journalWrites += 1;
          if (targets.has(path)) targetEffects += 1;
          return originalFs.publishFileAtomically(path, data, opts);
        },
        async writeFile(path, data, opts) {
          if (targets.has(path)) targetEffects += 1;
          return originalFs.writeFile(path, data, opts);
        },
        async symlink(source, path, type) {
          if (targets.has(path)) targetEffects += 1;
          return originalFs.symlink(source, path, type);
        },
        async cp(source, path, opts) {
          if (targets.has(path)) targetEffects += 1;
          return originalFs.cp(source, path, opts);
        },
      },
    };

    for (const fixture of fixtures) {
      for (const mutation of mutations) {
        const action = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
        mutation.alter(action);
        const mutationAction = {
          ...originalAction,
          actionId: `action-${fixture.op}-${mutation.name}`,
          kind: fixture.op,
          target: String(action.target),
          payload: { planAction: action },
        };
        const invalidPlan = createMutationPlan({
          ...prepared.mutationPlan,
          normalizedInputs: normalizedInputs as CanonicalJsonObject,
          actions: [mutationAction],
          targetPreconditions: [
            {
              actionId: mutationAction.actionId,
              target: mutationAction.target,
              expected: { state: "absent" },
            },
          ],
        });

        const result = await applyMutationPlan(env, invalidPlan, {
          storeRoot,
          options: options(),
          secretMode: "keychain",
        });
        expect(result.operation, `${fixture.op}: ${mutation.name}`).toMatchObject({
          ok: false,
          conflict: { code: "INVALID_PLAN" },
        });
      }
    }

    expect(providerReads).toBe(0);
    expect(lockAttempts).toBe(0);
    expect(journalWrites).toBe(0);
    expect(targetEffects).toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(t.env.fs.lstat(targetRoot)).rejects.toThrow();
  });

  it("rejects malformed sync-gitignore actions before provider, lock, journal, or target effects", async () => {
    const projectOptions = {
      ...options(),
      scope: "project" as const,
      dir: t.env.cwd(),
    };
    const prepared = await planApplyMutation(t.env, projectOptions);
    const gitignoreIndex = prepared.mutationPlan.actions.findIndex(
      (action) => action.kind === "sync-gitignore",
    );
    const signedGitignore = prepared.mutationPlan.actions[gitignoreIndex];
    if (!signedGitignore) throw new Error("expected a sync-gitignore action");
    const cases: Array<{
      name: string;
      alter(action: Record<string, unknown>): void;
    }> = [
      {
        name: "unknown envelope field",
        alter: (action) => {
          action.extra = true;
        },
      },
      {
        name: "missing payload field",
        alter: (action) => {
          delete (action.payload as Record<string, unknown>).projectDir;
        },
      },
      {
        name: "wrong payload type",
        alter: (action) => {
          (action.payload as Record<string, unknown>).mode = "0644";
        },
      },
      {
        name: "unknown effect enum",
        alter: (action) => {
          (action.payload as Record<string, unknown>).effect = "append";
        },
      },
      {
        name: "forged semantic digest",
        alter: (action) => {
          (action.payload as Record<string, unknown>).digest = `sha256:${"f".repeat(64)}`;
        },
      },
      {
        name: "forged action id",
        alter: (action) => {
          action.actionId = "forged";
        },
      },
    ];
    let providerReads = 0;
    let lockAttempts = 0;
    let journalWrites = 0;
    let targetEffects = 0;
    const originalFs = t.env.fs;
    const productTarget = prepared.mutationPlan.actions[0]?.target;
    const targets = new Set([productTarget, signedGitignore.target]);
    const env: Env = {
      ...t.env,
      secretStore: {
        async get() {
          providerReads += 1;
          return { found: false };
        },
        async set() {},
        async delete() {
          return false;
        },
      },
      fs: {
        ...originalFs,
        async writeFileExclusive(path, data, opts) {
          lockAttempts += 1;
          return originalFs.writeFileExclusive(path, data, opts);
        },
        async publishFileAtomically(path, data, opts) {
          if (path === operationJournalPath(storeRoot)) journalWrites += 1;
          if (targets.has(path)) targetEffects += 1;
          return originalFs.publishFileAtomically(path, data, opts);
        },
        async writeFile(path, data, opts) {
          if (targets.has(path)) targetEffects += 1;
          return originalFs.writeFile(path, data, opts);
        },
      },
    };

    for (const testCase of cases) {
      const altered = JSON.parse(JSON.stringify(signedGitignore)) as Record<string, unknown>;
      testCase.alter(altered);
      const actions = [...prepared.mutationPlan.actions];
      actions[gitignoreIndex] = altered as unknown as (typeof actions)[number];
      const actionId = String(altered.actionId);
      const target = String(altered.target);
      const targetPreconditions = prepared.mutationPlan.targetPreconditions.map((precondition) =>
        precondition.actionId === signedGitignore.actionId
          ? { ...precondition, actionId, target }
          : precondition,
      );
      const invalidPlan = createMutationPlan({
        ...prepared.mutationPlan,
        actions,
        targetPreconditions,
      });

      const result = await applyMutationPlan(env, invalidPlan, {
        storeRoot,
        options: projectOptions,
        secretMode: "keychain",
      });
      expect(result.operation, testCase.name).toMatchObject({
        ok: false,
        conflict: { code: "INVALID_PLAN" },
      });
    }

    expect(providerReads).toBe(0);
    expect(lockAttempts).toBe(0);
    expect(journalWrites).toBe(0);
    expect(targetEffects).toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
  });

  it.each([
    {
      name: "future schema version",
      alter: (plan: MutationPlan) => ({ ...plan, schemaVersion: 2 }),
      diagnostic: /unsupported mutation plan schema version; supported version is 1/i,
    },
    {
      name: "unknown expiry policy",
      alter: (plan: MutationPlan) => ({
        ...plan,
        expires: { policy: "after-approval" },
      }),
      diagnostic: /unsupported mutation plan expiry policy; supported policies/i,
    },
    {
      name: "an invalid expires-at calendar date",
      alter: (plan: MutationPlan) => ({
        ...plan,
        expires: { policy: "expires-at", expiresAt: "2027-02-29T00:00:00.000Z" },
      }),
      diagnostic: /expires-at policy requires a canonical ISO UTC timestamp with a valid date/i,
    },
  ])("rejects a digest-valid plan with $name before any product mutation", async (testCase) => {
    const prepared = await planApplyMutation(t.env, options());
    const altered = testCase.alter(prepared.mutationPlan) as unknown as MutationPlan;
    const unsupported = {
      ...altered,
      digest: mutationPlanDigest(altered),
    } as MutationPlan;
    expect(verifyMutationPlanDigest(unsupported)).toBe(true);

    let lockAttempts = 0;
    const writeFileExclusive = t.env.fs.writeFileExclusive;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        writeFileExclusive: async (
          path: string,
          data: string,
          opts?: { mode?: number },
        ): Promise<boolean> => {
          lockAttempts += 1;
          return writeFileExclusive(path, data, opts);
        },
      },
    };

    const result = await applyMutationPlan(env, unsupported, {
      storeRoot,
      options: options(),
    });
    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });

    expect(lockAttempts).toBe(0);
    await expect(t.env.fs.lstat(target())).rejects.toThrow();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
    await expect(t.env.fs.lstat(t.path("home", ".cellarer", "mutation.lock"))).rejects.toThrow();
  });

  it("accepts a canonical leap-day expires-at timestamp", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const leapDayPlan = createAuthorizedMutationPlan(t.env, storeRoot, {
      ...prepared.mutationPlan,
      expires: { policy: "expires-at", expiresAt: "2028-02-29T00:00:00.000Z" },
    });

    const result = await applyReceipt(leapDayPlan);

    expect(result.operation).toMatchObject({ ok: true });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
  });

  it("validates authority before the lock and before decoding malformed apply payloads", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const malformedInputs = {
      ...prepared.mutationPlan,
      normalizedInputs: { storeRoot: 42 },
    };
    const malformedAction = {
      ...prepared.mutationPlan,
      actions: prepared.mutationPlan.actions.map((action, index) =>
        index === 0 ? { ...action, payload: { planAction: "malformed" } } : action,
      ),
    };

    for (const tampered of [malformedInputs, malformedAction]) {
      const result = await applyReceipt(tampered);
      expect(result.operation).toMatchObject({
        ok: false,
        conflict: { code: "INVALID_PLAN" },
      });
      await expect(t.env.fs.lstat(target())).rejects.toThrow();
      await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
      await expect(t.env.fs.lstat(t.path("home", ".cellarer", "mutation.lock"))).rejects.toThrow();
    }
  });

  it("rejects plans whose canonical Store inputs changed after planning", async () => {
    const first = await planApplyMutation(t.env, options());
    const stale = await planApplyMutation(t.env, options());
    await writeRuleArtifact(t.env, storeRoot, "style", "changed after planning");
    const committed = await applyReceipt(first.mutationPlan);
    const rejected = await applyReceipt(stale.mutationPlan);

    expect(committed.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });
    expect(rejected.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });
    await expect(t.env.fs.lstat(target())).rejects.toThrow();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
  });

  it.each([
    "global",
    "project",
  ] as const)("binds every requested %s capability root into normalized inputs", async (scope) => {
    const scopedOptions = {
      ...options(),
      scope,
      ...(scope === "project" ? { dir: t.env.cwd() } : {}),
      capabilities: ["rules", "mcp", "skills"] as const,
    };

    const prepared = await planApplyMutation(t.env, scopedOptions);
    const inputs = prepared.mutationPlan.normalizedInputs as Record<string, unknown>;
    const descriptors = inputs.capabilityRootProvenance as
      | readonly { capability: string; path: string; expected: { state: string } }[]
      | undefined;

    expect(descriptors?.map(({ capability }) => capability)).toEqual(["mcp", "rules", "skills"]);
    expect(descriptors?.map(({ path }) => path)).toEqual([
      t.path("home", ".cellarer", "store", "mcp"),
      t.path("home", ".cellarer", "store", "rules"),
      t.path("home", ".cellarer", "store", "skills"),
    ]);
    expect(descriptors?.every(({ expected }) => expected.state === "present")).toBe(true);
  });

  it.each([
    [
      "new rule appears",
      ["rules"] as const,
      async () => writeRuleArtifact(t.env, storeRoot, "late", "late content"),
    ],
    [
      "MCP root changes in a multi-capability plan",
      ["rules", "mcp"] as const,
      async () =>
        t.env.fs.writeFile(
          t.path("home", ".cellarer", "store", "mcp", "late.json"),
          '{"command":"late"}\n',
        ),
    ],
    [
      "empty root becomes missing",
      ["mcp"] as const,
      async () => t.env.fs.rm(t.path("home", ".cellarer", "store", "mcp"), { recursive: true }),
    ],
    [
      "root ownership metadata changes",
      ["rules"] as const,
      async () => t.env.fs.chmod(t.path("home", ".cellarer", "store", "rules"), 0o700),
    ],
  ] as const)("rejects capability-root provenance drift when %s", async (_name, capabilities, drift) => {
    const prepared = await planApplyMutation(t.env, {
      ...options(),
      capabilities: [...capabilities],
    });
    await drift();

    const result = await applyMutationPlan(t.env, prepared.mutationPlan, {
      storeRoot,
      options: { ...options(), capabilities: [...capabilities] },
    });

    expect(result.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(t.env.fs.lstat(target())).rejects.toThrow();
  });

  it("rejects a missing capability root that appears after planning", async () => {
    const mcpRoot = t.path("home", ".cellarer", "store", "mcp");
    await t.env.fs.rm(mcpRoot, { recursive: true });
    const mcpOptions = { ...options(), capabilities: ["mcp" as const] };
    const prepared = await planApplyMutation(t.env, mcpOptions);
    const descriptor = (prepared.mutationPlan.normalizedInputs as Record<string, unknown>)
      .capabilityRootProvenance as
      | readonly { capability: string; expected: { state: string } }[]
      | undefined;
    expect(descriptor).toEqual([
      expect.objectContaining({ capability: "mcp", expected: { state: "absent" } }),
    ]);

    await t.env.fs.mkdir(mcpRoot, { recursive: true });
    const result = await applyMutationPlan(t.env, prepared.mutationPlan, {
      storeRoot,
      options: mcpOptions,
    });

    expect(result.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
  });

  it("preflights serialized-plan provenance before recovery, revision, target, lock, or journal observation", async () => {
    const prepared = await planApplyMutation(t.env, options());
    await writeRuleArtifact(t.env, storeRoot, "late", "late content");
    const recoveryPath = recoveryLockPath(storeRoot);
    const journalPath = operationJournalPath(storeRoot);
    const revisionPath = storeRevisionPath(storeRoot);
    const lockPath = mutationLockPath(storeRoot);
    const targetPath = target();
    const counts = { recovery: 0, journal: 0, revision: 0, target: 0, lock: 0 };
    const baseFs = t.env.fs;
    const env: Env = {
      ...t.env,
      fs: {
        ...baseFs,
        async readFile(path) {
          if (path === recoveryPath) counts.recovery += 1;
          if (path === journalPath) counts.journal += 1;
          if (path === revisionPath) counts.revision += 1;
          return baseFs.readFile(path);
        },
        async lstat(path) {
          if (path === targetPath) counts.target += 1;
          return baseFs.lstat(path);
        },
        async writeFileExclusive(path, data, opts) {
          if (path === lockPath) counts.lock += 1;
          return baseFs.writeFileExclusive(path, data, opts);
        },
      },
    };

    const result = await applyMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: options(),
    });

    expect(result.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    expect(counts).toEqual({ recovery: 0, journal: 0, revision: 0, target: 0, lock: 0 });
  });

  it("allows only mutation-lock acquisition and cleanup when provenance drifts in the preflight-to-lock window", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const recoveryPath = recoveryLockPath(storeRoot);
    const journalPath = operationJournalPath(storeRoot);
    const revisionPath = storeRevisionPath(storeRoot);
    const lockPath = mutationLockPath(storeRoot);
    const targetPath = target();
    const counts = {
      recovery: 0,
      journal: 0,
      revision: 0,
      target: 0,
      lockAcquire: 0,
      lockCleanup: 0,
      publications: 0,
    };
    const baseFs = t.env.fs;
    let injected = false;
    const env: Env = {
      ...t.env,
      fs: {
        ...baseFs,
        async readFile(path) {
          if (path === recoveryPath) counts.recovery += 1;
          if (path === journalPath) counts.journal += 1;
          if (path === revisionPath) counts.revision += 1;
          return baseFs.readFile(path);
        },
        async lstat(path) {
          if (path === targetPath) counts.target += 1;
          return baseFs.lstat(path);
        },
        async writeFileExclusive(path, data, opts) {
          const acquired = await baseFs.writeFileExclusive(path, data, opts);
          if (path === lockPath) {
            counts.lockAcquire += 1;
            if (acquired && !injected) {
              injected = true;
              await writeRuleArtifact(t.env, storeRoot, "aba", "changed after preflight");
            }
          }
          return acquired;
        },
        async rm(path, opts) {
          if (path === lockPath) counts.lockCleanup += 1;
          return baseFs.rm(path, opts);
        },
        async publishFileAtomically(path, data, opts) {
          counts.publications += 1;
          return baseFs.publishFileAtomically(path, data, opts);
        },
      },
    };

    const result = await applyMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: options(),
    });

    expect(result.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    expect(counts).toEqual({
      recovery: 0,
      journal: 0,
      revision: 0,
      target: 0,
      lockAcquire: 1,
      lockCleanup: 1,
      publications: 0,
    });
    await expect(t.env.fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "ancestor ABA",
    "root ABA",
  ])("uses one anchored capability snapshot and fails closed on injected %s before Store reads", async () => {
    const baseFs = t.env.fs;
    let anchoredCalls = 0;
    let capabilityReads = 0;
    const capabilityRoot = t.path("home", ".cellarer", "store", "rules");
    const env: Env = {
      ...t.env,
      fs: {
        ...baseFs,
        async snapshotPathNoFollow() {
          anchoredCalls += 1;
          throw Object.assign(new Error("injected anchored snapshot ABA"), {
            code: "CELLARER_SNAPSHOT_STALE",
          });
        },
        async readdir(path) {
          if (path === capabilityRoot) capabilityReads += 1;
          return baseFs.readdir(path);
        },
        async readFile(path) {
          if (path.startsWith(`${capabilityRoot}/`)) capabilityReads += 1;
          return baseFs.readFile(path);
        },
        async readFileBytes(path) {
          if (path.startsWith(`${capabilityRoot}/`)) capabilityReads += 1;
          return baseFs.readFileBytes(path);
        },
      } as Env["fs"],
    };

    await expect(planApplyMutation(env, options())).rejects.toThrow(/snapshot|ABA|stale/i);
    expect(anchoredCalls).toBeGreaterThan(0);
    expect(capabilityReads).toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
  });

  it("rejects a plan when effective configuration changes without advancing revision", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const configPath = t.path("home", ".cellarer", "config.json");
    const config = JSON.parse(await t.env.fs.readFile(configPath)) as {
      defaults: { method: string };
    };
    config.defaults.method = config.defaults.method === "copy" ? "symlink" : "copy";
    await t.env.fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const result = await applyReceipt(prepared.mutationPlan);

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });
    await expect(t.env.fs.lstat(target())).rejects.toThrow();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
  });

  it.each([
    [
      "missing-to-global-owner",
      async () =>
        saveLedger(t.env, storeRoot, {
          version: 2,
          owners: [
            {
              agent: "codex",
              scope: "global",
              capability: "rules",
              target: t.path("home", ".codex", "AGENTS.md"),
              artifactIds: ["rules/style"],
              receipt: {
                method: "write",
                fingerprint: `sha256:${"b".repeat(64)}`,
                backup: null,
                generated: true,
                appliedAt: "2026-06-30T08:00:00.000Z",
              },
            },
          ],
        }),
    ],
    ["present-to-missing", async () => t.env.fs.rm(t.path("home", ".cellarer", "state.json"))],
    [
      "present-bytes-change",
      async () => {
        await t.env.fs.writeFile(
          t.path("home", ".cellarer", "state.json"),
          '{\n  "version": 2,\n  "owners": []\n}\n',
        );
      },
    ],
  ] as const)("rejects %s ledger provenance drift before any apply journal", async (_case, drift) => {
    if (_case.startsWith("present-")) {
      await t.env.fs.writeFile(
        t.path("home", ".cellarer", "state.json"),
        '{"version":2,"owners":[]}\n',
      );
    }
    const prepared = await planApplyMutation(t.env, options());
    await drift();

    const result = await applyReceipt(prepared.mutationPlan);

    expect(result.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    await expect(t.env.fs.lstat(target())).rejects.toThrow();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
  });

  it("binds project-owner ledger decisions before the terminal gitignore action", async () => {
    const projectDir = t.path("project-ledger-binding");
    await t.env.fs.mkdir(projectDir, { recursive: true });
    const projectOptions = { ...options(), scope: "project" as const, dir: projectDir };
    const prepared = await planApplyMutation(t.env, projectOptions);
    await saveLedger(t.env, storeRoot, {
      version: 2,
      owners: [
        {
          agent: "codex",
          scope: "project",
          projectRoot: projectDir,
          capability: "rules",
          target: t.path("project-ledger-binding", "CODEX.md"),
          artifactIds: ["rules/style"],
          receipt: {
            method: "write",
            fingerprint: `sha256:${"a".repeat(64)}`,
            backup: null,
            generated: true,
            appliedAt: "2026-06-30T08:00:00.000Z",
          },
        },
      ],
    });

    const result = await applyMutationPlan(t.env, prepared.mutationPlan, {
      storeRoot,
      options: projectOptions,
    });

    expect(result.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    await expect(t.env.fs.lstat(t.path("project-ledger-binding", ".gitignore"))).rejects.toThrow();
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
  });

  it("rejects a ledger symlink without reading its external target", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const externalLedger = t.path("external-ledger.json");
    const ledgerPath = t.path("home", ".cellarer", "state.json");
    await t.env.fs.writeFile(externalLedger, '{"version":2,"owners":[]}\n');
    await t.env.fs.symlink(externalLedger, ledgerPath, "file");
    let externalReads = 0;
    const readFile = t.env.fs.readFile;
    const readFileBytes = t.env.fs.readFileBytes;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        async readFile(path) {
          if (path === externalLedger || path === ledgerPath) externalReads += 1;
          return readFile(path);
        },
        async readFileBytes(path) {
          if (path === externalLedger || path === ledgerPath) externalReads += 1;
          return readFileBytes(path);
        },
      },
    };

    const result = await applyMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: options(),
    });

    expect(result.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    expect(externalReads).toBe(0);
    await expect(t.env.fs.readFile(externalLedger)).resolves.toBe('{"version":2,"owners":[]}\n');
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
  });

  it("keeps legacy plan-and-apply bound to the ledger snapshot without replanning", async () => {
    const lockPath = t.path("home", ".cellarer", "mutation.lock");
    const writeFileExclusive = t.env.fs.writeFileExclusive;
    let injected = false;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        async writeFileExclusive(path, data, writeOptions) {
          const acquired = await writeFileExclusive(path, data, writeOptions);
          if (acquired && path === lockPath && !injected) {
            injected = true;
            await saveLedger(t.env, storeRoot, { version: 2, owners: [] });
          }
          return acquired;
        },
      },
    };

    const result = await apply(env, options());

    expect(result.mutation?.result).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });
    await expect(t.env.fs.lstat(target())).rejects.toThrow();
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
  });

  it("retries apply planning when the revision changes across observed inputs", async () => {
    const observedTarget = target();
    const originalLstat = t.env.fs.lstat;
    let targetObservations = 0;
    let revisionAdvanced = false;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        lstat: async (path: string) => {
          try {
            return await originalLstat(path);
          } finally {
            if (path === observedTarget) {
              targetObservations += 1;
              if (!revisionAdvanced) {
                revisionAdvanced = true;
                await publishStoreRevision(t.env, storeRoot, 1);
              }
            }
          }
        },
      },
    };

    const prepared = await planApplyMutation(env, options());

    expect(prepared.mutationPlan.baseRevision).toBe(1);
    expect(targetObservations).toBeGreaterThanOrEqual(2);
  });

  it("rejects expired plans and changed target preconditions under the lock", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const expired = createAuthorizedMutationPlan(t.env, storeRoot, {
      ...prepared.mutationPlan,
      expires: { policy: "expires-at", expiresAt: "2020-01-01T00:00:00.000Z" },
    });
    const expiredResult = await applyReceipt(expired);
    expect(expiredResult.operation).toMatchObject({
      ok: false,
      conflict: { code: "EXPIRED_PLAN" },
    });

    await t.env.fs.mkdir(t.path("home", ".claude"), { recursive: true });
    await t.env.fs.writeFile(target(), "external change");
    const drifted = await applyReceipt(prepared.mutationPlan);
    expect(drifted.operation).toMatchObject({
      ok: false,
      conflict: { code: "TARGET_PRECONDITION_CONFLICT" },
    });
    await expect(t.env.fs.readFile(target())).resolves.toBe("external change");
  });

  it("fails before an apply action when its target drifts after the journal starts", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const external = "external after journal";
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    let injected = false;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path: string, data: string, opts?: { mode?: number }) => {
          await publishFileAtomically(path, data, opts);
          if (!injected && path.endsWith("operations/active.json")) {
            const journal = JSON.parse(data) as { status?: string };
            if (journal.status === "executing") {
              injected = true;
              await publishFileAtomically(target(), external);
            }
          }
        },
      },
    };

    const result = await applyMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: options(),
    });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "PARTIAL_FAILURE" },
      journal: {
        status: "recovery-required",
        actions: [
          {
            status: "failed",
            receipt: { error: { code: "TARGET_PRECONDITION_CONFLICT" } },
          },
        ],
      },
    });
    await expect(t.env.fs.readFile(target())).resolves.toBe(external);
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
  });

  it("fails before a revert action when its target drifts after the journal starts", async () => {
    const applyPlan = await planApplyMutation(t.env, options());
    expect((await applyReceipt(applyPlan.mutationPlan)).operation.ok).toBe(true);
    const prepared = await planRevertMutation(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
    });
    const external = "external after revert journal";
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    let injected = false;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path: string, data: string, opts?: { mode?: number }) => {
          await publishFileAtomically(path, data, opts);
          if (!injected && path.endsWith("operations/active.json")) {
            const journal = JSON.parse(data) as { status?: string };
            if (journal.status === "executing") {
              injected = true;
              await publishFileAtomically(target(), external);
            }
          }
        },
      },
    };

    const result = await applyRevertMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: { storeRoot, scope: "global", agents: ["claude-code"] },
    });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "PARTIAL_FAILURE" },
      journal: {
        status: "recovery-required",
        actions: [
          {
            status: "failed",
            receipt: { error: { code: "TARGET_PRECONDITION_CONFLICT" } },
          },
        ],
      },
    });
    await expect(t.env.fs.readFile(target())).resolves.toBe(external);
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
  });

  it("returns typed owner evidence when apply cannot acquire the store lock", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const activeOwner = {
      operationId: "operation-active",
      processId: 42,
      hostname: "other-process",
      acquiredAt: "2026-07-28T09:00:00.000Z",
    };
    const acquired = await acquireStoreMutationLock(t.env, storeRoot, activeOwner);
    if (!acquired.ok) throw new Error("expected lock setup");
    try {
      const result = await applyReceipt(prepared.mutationPlan);
      expect(result.operation).toEqual({
        ok: false,
        conflict: {
          code: "LOCK_CONFLICT",
          message: "store mutation lock is held",
          owner: activeOwner,
        },
      });
      await expect(t.env.fs.lstat(target())).rejects.toThrow();
    } finally {
      await acquired.lock.release();
    }
  });

  it("routes revert through a planned receipt and rejects post-plan target drift", async () => {
    const applyPlan = await planApplyMutation(t.env, options());
    const applied = await applyReceipt(applyPlan.mutationPlan);
    expect(applied.operation.ok).toBe(true);

    const preparedRevert = await planRevertMutation(t.env, {
      storeRoot,
      agents: ["claude-code"],
    });
    await t.env.fs.writeFile(target(), "edited after revert planning");
    const drifted = await revertReceipt(preparedRevert.mutationPlan);
    expect(drifted.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });

    const currentRevertOptions = {
      storeRoot,
      agents: ["claude-code"],
      acknowledgements: [
        (await planRevertMutation(t.env, { storeRoot, agents: ["claude-code"] })).plan.targets[0]
          ?.acknowledgement?.token ?? "",
      ],
    };
    const currentRevert = await planRevertMutation(t.env, currentRevertOptions);
    const reverted = await applyRevertMutationPlan(t.env, currentRevert.mutationPlan, {
      storeRoot,
      options: currentRevertOptions,
    });
    expect(reverted.operation.ok).toBe(true);
    await expect(t.env.fs.lstat(target())).rejects.toThrow();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(2);
  });

  it("retries revert planning when the revision changes across target observation", async () => {
    const applyPlan = await planApplyMutation(t.env, options());
    expect((await applyReceipt(applyPlan.mutationPlan)).operation.ok).toBe(true);
    const originalLstat = t.env.fs.lstat;
    let targetObservations = 0;
    let revisionAdvanced = false;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        lstat: async (path: string) => {
          try {
            return await originalLstat(path);
          } finally {
            if (path === target()) {
              targetObservations += 1;
              if (!revisionAdvanced) {
                revisionAdvanced = true;
                await publishStoreRevision(t.env, storeRoot, 2);
              }
            }
          }
        },
      },
    };

    const prepared = await planRevertMutation(env, { storeRoot, agents: ["claude-code"] });

    expect(prepared.mutationPlan.baseRevision).toBe(2);
    expect(targetObservations).toBeGreaterThanOrEqual(2);
  });

  it("validates authority before the lock and before decoding malformed revert payloads", async () => {
    const applyPlan = await planApplyMutation(t.env, options());
    expect((await applyReceipt(applyPlan.mutationPlan)).operation.ok).toBe(true);
    const prepared = await planRevertMutation(t.env, { storeRoot, agents: ["claude-code"] });
    const malformedInputs = {
      ...prepared.mutationPlan,
      normalizedInputs: { storeRoot: false },
    };
    const malformedAction = {
      ...prepared.mutationPlan,
      actions: prepared.mutationPlan.actions.map((action, index) =>
        index === 0 ? { ...action, payload: { revertTarget: "malformed" } } : action,
      ),
    };

    for (const tampered of [malformedInputs, malformedAction]) {
      const result = await revertReceipt(tampered);
      expect(result.operation).toMatchObject({
        ok: false,
        conflict: { code: "INVALID_PLAN" },
      });
      await expect(t.env.fs.lstat(target())).resolves.toBeDefined();
      await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
      await expect(t.env.fs.lstat(t.path("home", ".cellarer", "mutation.lock"))).rejects.toThrow();
    }
  });

  it("returns PARTIAL_FAILURE when the second ordinary apply action hits an I/O error", async () => {
    const applyOptions = {
      ...options(),
      agents: ["claude-code", "codex"],
    };
    const prepared = await planApplyMutation(t.env, applyOptions);
    const originalWriteFile = t.env.fs.writeFile;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        writeFile: async (path: string, data: string, opts?: { mode?: number }) => {
          if (path.startsWith(t.path("home", ".codex", ".cellarer-tmp-"))) {
            const error = new Error("simulated disk permission failure") as Error & {
              code: string;
            };
            error.code = "EACCES";
            throw error;
          }
          await originalWriteFile(path, data, opts);
        },
      },
    };

    const result = await applyMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: applyOptions,
    });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "PARTIAL_FAILURE", failedActionIds: [expect.any(String)] },
      journal: { status: "recovery-required" },
    });
    await expect(t.env.fs.readFile(target())).resolves.toContain("planned content");
    await expect(t.env.fs.lstat(t.path("home", ".codex", "AGENTS.md"))).rejects.toThrow();
    expect(await readOperationJournal(t.env, storeRoot)).toMatchObject({
      status: "recovery-required",
      actions: [{ status: "succeeded" }, { status: "failed" }],
    });
  });

  it("does not commit when an ordinary apply target is silently corrupted after placement", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const originalRename = t.env.fs.rename;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        rename: async (oldPath: string, newPath: string) => {
          await originalRename(oldPath, newPath);
          if (newPath === target()) await t.env.fs.writeFile(newPath, "silently corrupted");
        },
      },
    };

    const result = await applyMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: options(),
    });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "PARTIAL_FAILURE" },
      journal: {
        status: "recovery-required",
        actions: [
          { status: "failed", receipt: { error: { code: "PUBLICATION_POSTCONDITION_FAILED" } } },
        ],
      },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
  });

  it.each([
    "bytes",
    "mode",
  ] as const)("does not commit when a signed gitignore publication silently corrupts %s", async (corruption) => {
    const projectDir = t.path("project");
    const gitignorePath = t.path("project", ".gitignore");
    await t.env.fs.mkdir(projectDir, { recursive: true });
    const projectOptions = {
      ...options(),
      scope: "project" as const,
      dir: projectDir,
    };
    const prepared = await planApplyMutation(t.env, projectOptions);
    const originalPublish = t.env.fs.publishFileAtomically;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path: string, data: string, opts?: { mode?: number }) => {
          await originalPublish(path, data, opts);
          if (path !== gitignorePath) return;
          if (corruption === "bytes") await t.env.fs.writeFile(path, "corrupt gitignore\n");
          else await t.env.fs.chmod(path, 0o600);
        },
      },
    };

    const result = await applyMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: projectOptions,
    });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "PARTIAL_FAILURE" },
      journal: {
        status: "recovery-required",
        actions: [
          { status: "succeeded" },
          {
            status: "failed",
            receipt: { error: { code: "PUBLICATION_POSTCONDITION_FAILED" } },
          },
        ],
      },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
  });

  it.each([
    "bytes",
    "mode",
  ] as const)("does not advance revision when state publication silently corrupts %s", async (corruption) => {
    const prepared = await planApplyMutation(t.env, options());
    const statePath = t.path("home", ".cellarer", "state.json");
    const originalPublish = t.env.fs.publishFileAtomically;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path: string, data: string, opts?: { mode?: number }) => {
          await originalPublish(path, data, opts);
          if (path !== statePath) return;
          if (corruption === "bytes") await t.env.fs.writeFile(path, "corrupt state\n");
          else await t.env.fs.chmod(path, 0o644);
        },
      },
    };

    const result = await applyMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: options(),
    });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED", targets: [statePath] },
      journal: { status: "recovery-required" },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    const durable = await t.env.fs.readFile(
      t.path("home", ".cellarer", "operations", "active.json"),
    );
    expect(durable).not.toContain("corrupt state");
  });

  it("does not execute the first product action when the prepared journal is silently skipped", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const journalPath = operationJournalPath(storeRoot);
    const originalPublish = t.env.fs.publishFileAtomically;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path: string, data: string, opts?: { mode?: number }) => {
          if (path === journalPath && data.includes('"status": "prepared"')) return;
          await originalPublish(path, data, opts);
        },
      },
    };

    const result = await applyMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: options(),
    });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED", targets: [journalPath] },
    });
    await expect(t.env.fs.lstat(target())).rejects.toThrow();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
  });

  it("retains recovery evidence when revision publication is silently skipped", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const revisionPath = storeRevisionPath(storeRoot);
    const originalPublish = t.env.fs.publishFileAtomically;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path: string, data: string, opts?: { mode?: number }) => {
          if (path === revisionPath) return;
          await originalPublish(path, data, opts);
        },
      },
    };

    const result = await applyMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: options(),
    });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED", targets: [revisionPath] },
      journal: { status: "recovery-required" },
    });
    await expect(t.env.fs.readFile(target())).resolves.toContain("planned content");
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "recovery-required",
    });
  });

  it("does not publish a receipt or report success when the completed journal write is skipped", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const journalPath = operationJournalPath(storeRoot);
    const receiptPath = operationReceiptPath(storeRoot, "operation-fixed");
    const originalPublish = t.env.fs.publishFileAtomically;
    const env = {
      ...t.env,
      randomId: () => "fixed",
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path: string, data: string, opts?: { mode?: number }) => {
          if (path === journalPath && data.includes('"status": "completed"')) return;
          await originalPublish(path, data, opts);
        },
      },
    };

    const result = await applyMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: options(),
    });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED", targets: [journalPath] },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "publishing-state",
    });
    await expect(t.env.fs.lstat(receiptPath)).rejects.toThrow();
  });

  it("keeps the completed journal and reports recovery when receipt bytes are silently corrupted", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const journalPath = operationJournalPath(storeRoot);
    const receiptPath = operationReceiptPath(storeRoot, "operation-fixed");
    const originalPublish = t.env.fs.publishFileAtomically;
    const env = {
      ...t.env,
      randomId: () => "fixed",
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path: string, data: string, opts?: { mode?: number }) => {
          await originalPublish(path, data, opts);
          if (path === receiptPath) await t.env.fs.writeFile(path, "corrupt receipt\n");
        },
      },
    };

    const result = await applyMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: options(),
    });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED", targets: [receiptPath] },
      journal: { status: "completed" },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "completed",
    });
    await expect(t.env.fs.readFile(journalPath)).resolves.toContain('"outcome": "committed"');
    await expect(t.env.fs.readFile(receiptPath)).resolves.toBe("corrupt receipt\n");
  });

  it("does not commit when an ordinary revert removal silently leaves the target", async () => {
    const applyPlan = await planApplyMutation(t.env, options());
    expect((await applyReceipt(applyPlan.mutationPlan)).operation.ok).toBe(true);
    const prepared = await planRevertMutation(t.env, {
      storeRoot,
      agents: ["claude-code"],
    });
    const originalRm = t.env.fs.rm;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        rm: async (path: string, opts?: { recursive?: boolean; force?: boolean }) => {
          if (path === target()) return;
          await originalRm(path, opts);
        },
      },
    };

    const result = await applyRevertMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: { storeRoot, agents: ["claude-code"] },
    });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "PARTIAL_FAILURE" },
      journal: {
        status: "recovery-required",
        actions: [
          { status: "failed", receipt: { error: { code: "PUBLICATION_POSTCONDITION_FAILED" } } },
        ],
      },
    });
    await expect(t.env.fs.lstat(target())).resolves.toBeDefined();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
  });

  it("signs project gitignore as the final apply action and receipts it before revision commit", async () => {
    const projectDir = t.path("project");
    await t.env.fs.mkdir(projectDir, { recursive: true });
    const projectOptions = {
      ...options(),
      scope: "project" as const,
      dir: projectDir,
    };
    const prepared = await planApplyMutation(t.env, projectOptions);
    const gitignorePath = t.path("project", ".gitignore");

    expect(prepared.mutationPlan.actions.at(-1)).toMatchObject({
      kind: "sync-gitignore",
      target: gitignorePath,
      payload: {
        path: gitignorePath,
        digest: expect.stringMatching(/^sha256:/),
        mode: 0o644,
      },
    });
    expect(prepared.mutationPlan.targetPreconditions.at(-1)).toMatchObject({
      target: gitignorePath,
      expected: { state: "absent" },
    });

    const result = await applyMutationPlan(t.env, prepared.mutationPlan, {
      storeRoot,
      options: projectOptions,
    });

    expect(result.operation).toMatchObject({
      ok: true,
      receipt: {
        resultingRevision: 1,
        actionReceipts: [expect.anything(), { target: gitignorePath, outcome: "applied" }],
      },
    });
    await expect(t.env.fs.readFile(gitignorePath)).resolves.toContain("/CLAUDE.md");
  });

  it("does not advance revision or publish a receipt when gitignore apply fails", async () => {
    const projectDir = t.path("project");
    const gitignorePath = t.path("project", ".gitignore");
    await t.env.fs.mkdir(projectDir, { recursive: true });
    const projectOptions = {
      ...options(),
      scope: "project" as const,
      dir: projectDir,
    };
    const prepared = await planApplyMutation(t.env, projectOptions);
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path: string, data: string, opts?: { mode?: number }) => {
          if (path === gitignorePath) {
            const error = new Error("simulated gitignore failure") as Error & { code: string };
            error.code = "EIO";
            throw error;
          }
          return t.env.fs.publishFileAtomically(path, data, opts);
        },
      },
    };

    const result = await applyMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: projectOptions,
    });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "PARTIAL_FAILURE" },
      journal: { status: "recovery-required" },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(t.env.fs.lstat(gitignorePath)).rejects.toThrow();
    expect(await readOperationJournal(t.env, storeRoot)).toMatchObject({
      actions: [{ status: "succeeded" }, { status: "failed" }],
    });
  });

  it("leaves a recoverable boundary when crashing after gitignore receipt but before state", async () => {
    const projectDir = t.path("project");
    const gitignorePath = t.path("project", ".gitignore");
    const statePath = t.path("home", ".cellarer", "state.json");
    await t.env.fs.mkdir(projectDir, { recursive: true });
    const projectOptions = {
      ...options(),
      scope: "project" as const,
      dir: projectDir,
    };
    const prepared = await planApplyMutation(t.env, projectOptions);
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path: string, data: string, opts?: { mode?: number }) => {
          if (path === statePath) throw new Error("crash-before-state-publication");
          return t.env.fs.publishFileAtomically(path, data, opts);
        },
      },
    };

    await expect(
      applyMutationPlan(env, prepared.mutationPlan, { storeRoot, options: projectOptions }),
    ).rejects.toThrow("crash-before-state-publication");

    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(t.env.fs.readFile(gitignorePath)).resolves.toContain("/CLAUDE.md");
    const journal = await readOperationJournal(t.env, storeRoot);
    expect(journal).toMatchObject({
      status: "publishing-state",
      actions: [{ status: "succeeded" }, { status: "succeeded" }],
      statePublications: [{ path: statePath, digest: expect.stringMatching(/^sha256:/) }],
    });
    if (!journal) throw new Error("expected crash journal");
    await expect(readOperationReceipt(t.env, storeRoot, journal.operationId)).resolves.toBeNull();
  });

  it("keeps revert revision at its prior boundary when signed gitignore removal fails", async () => {
    const projectDir = t.path("project");
    const gitignorePath = t.path("project", ".gitignore");
    await t.env.fs.mkdir(projectDir, { recursive: true });
    const projectOptions = {
      ...options(),
      scope: "project" as const,
      dir: projectDir,
    };
    const applyPlan = await planApplyMutation(t.env, projectOptions);
    expect(
      (
        await applyMutationPlan(t.env, applyPlan.mutationPlan, {
          storeRoot,
          options: projectOptions,
        })
      ).operation.ok,
    ).toBe(true);
    const prepared = await planRevertMutation(t.env, {
      storeRoot,
      scope: "project",
      dir: projectDir,
      agents: ["claude-code"],
    });
    expect(prepared.mutationPlan.actions.at(-1)).toMatchObject({
      kind: "sync-gitignore",
      target: gitignorePath,
    });
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        rm: async (path: string, opts?: { recursive?: boolean; force?: boolean }) => {
          if (path === gitignorePath) {
            const error = new Error("simulated gitignore removal failure") as Error & {
              code: string;
            };
            error.code = "EIO";
            throw error;
          }
          return t.env.fs.rm(path, opts);
        },
      },
    };

    const result = await applyRevertMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: {
        storeRoot,
        scope: "project",
        dir: projectDir,
        agents: ["claude-code"],
      },
    });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "PARTIAL_FAILURE" },
      journal: { status: "recovery-required" },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
    await expect(t.env.fs.readFile(gitignorePath)).resolves.toContain("/CLAUDE.md");
  });
});
