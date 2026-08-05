import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { add } from "../src/engine/add.js";
import { applyMutationPlan, planApplyMutation } from "../src/engine/apply.js";
import { planGitignoreMutation } from "../src/engine/gitignore-sync.js";
import { applyRevertMutationPlan } from "../src/engine/revert.js";
import type { Env, SecretStore } from "../src/env.js";
import * as core from "../src/index.js";
import {
  createAuthorizedMutationPlan,
  createDurableMutationPlan,
  createMutationPlan,
} from "../src/protocol/canonical.js";
import { targetState } from "../src/protocol/execute.js";
import { operationJournalPath } from "../src/protocol/journal.js";
import type { OperationJournal } from "../src/protocol/models.js";
import { diagnoseMutationRecovery, recoverInterruptedOperation } from "../src/protocol/recovery.js";
import * as activeSecretInternals from "../src/secrets/active-values.js";
import * as observableSecretInternals from "../src/secrets/observable.js";
import { setStoredSecret } from "../src/secrets/provider.js";
import { saveCollections } from "../src/settings.js";
import { sha256 } from "../src/store/checksum.js";
import { entryKey } from "../src/store/ledger.js";
import { initStore, writeRuleArtifact } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("closure hardening", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });

  afterEach(() => t.cleanup());

  it("6.1 rejects a re-signed wrong-operation revert before every effect", async () => {
    const raw = createMutationPlan({
      schemaVersion: 1,
      planId: "raw-plan-identity",
      operation: "apply",
      baseRevision: 0,
      normalizedInputs: { storeRoot, revertPlan: { targets: [], conflicts: [], warnings: [] } },
      targetPreconditions: [],
      actions: [],
      expires: { policy: "none" },
    });
    const forged = createMutationPlan({
      ...raw,
      operation: "unknown-operation",
      rawExtra: "raw-extra-field",
    } as never);
    let lockCalls = 0;
    const original = t.env.fs.writeFileExclusive;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        async writeFileExclusive(path, data, options) {
          lockCalls += 1;
          return original(path, data, options);
        },
      },
    };

    const result = await applyRevertMutationPlan(env, forged, {
      storeRoot,
      options: { storeRoot },
    });

    expect(result.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    expect(JSON.stringify(result)).not.toMatch(
      /raw-plan-identity|unknown-operation|raw-extra-field/,
    );
    expect(lockCalls).toBe(0);
  });

  it("6.1 reconstructs trusted apply options instead of accepting a self-signed fake agent and home target", async () => {
    await writeRuleArtifact(t.env, storeRoot, "forged", "attacker-selected bytes\n");
    const target = t.path("home", ".forged-agent", "arbitrary.md");
    const content = "attacker-selected bytes\n";
    const action = {
      artifact: "rules/*",
      artifactIds: ["rules/forged"],
      agent: "forged-agent",
      scope: "global" as const,
      capability: "rules" as const,
      target,
      method: "symlink" as const,
      op: "write" as const,
      reason: "rules/forged",
      preview: { after: content },
      desiredEvidence: { method: "write" as const, contentFingerprint: sha256(content) },
      ownership: {
        key: "",
        classification: "absent" as const,
        target,
        currentFingerprint: null,
        expectedReceipt: null,
      },
    };
    action.ownership.key = entryKey(action);
    const distributePlan = { actions: [action], warnings: [], conflicts: [] };
    const actionId = sha256(JSON.stringify({ index: 0, op: action.op, target }));
    const forged = createMutationPlan({
      schemaVersion: 1,
      planId: "forged-self-authorized-apply",
      operation: "apply",
      baseRevision: 0,
      normalizedInputs: {
        storeRoot,
        scope: "global",
        agents: ["forged-agent"],
        capabilities: ["rules"],
        distributePlan,
      },
      targetPreconditions: [{ actionId, target, expected: { state: "absent" } }],
      actions: [{ actionId, kind: "write", target, payload: { planAction: action } }],
      expires: { policy: "none" },
    });
    let providerReads = 0;
    let locks = 0;
    let storeReads = 0;
    let storeListings = 0;
    let targetObservations = 0;
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
        ...t.env.fs,
        async readFile(path) {
          storeReads += 1;
          return t.env.fs.readFile(path);
        },
        async readdir(path) {
          storeListings += 1;
          return t.env.fs.readdir(path);
        },
        async lstat(path) {
          targetObservations += 1;
          return t.env.fs.lstat(path);
        },
        async writeFileExclusive(path, data, options) {
          locks += 1;
          return t.env.fs.writeFileExclusive(path, data, options);
        },
      },
    };
    const context = {
      storeRoot,
      secretMode: "keychain" as const,
      options: {
        storeRoot,
        scope: "global" as const,
        agents: ["claude-code"],
        capabilities: ["rules" as const],
      },
    };

    const result = await applyMutationPlan(env, forged, context);

    expect(result.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    expect(providerReads).toBe(0);
    expect(locks).toBe(0);
    expect(storeReads).toBe(0);
    expect(storeListings).toBe(0);
    expect(targetObservations).toBe(0);
    await expect(t.env.fs.lstat(target)).rejects.toThrow();
  });

  it("6.1 rejects a self-signed revert with untrusted options before Store or target observation", async () => {
    const forged = createMutationPlan({
      schemaVersion: 1,
      planId: "forged-revert-options",
      operation: "revert",
      baseRevision: 0,
      normalizedInputs: {
        storeRoot,
        agents: ["forged-agent"],
        revertPlan: { targets: [], conflicts: [], warnings: [] },
      },
      targetPreconditions: [],
      actions: [],
      expires: { policy: "none" },
    });
    const calls = { readFile: 0, readdir: 0, lstat: 0 };
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        async readFile(path) {
          calls.readFile += 1;
          return t.env.fs.readFile(path);
        },
        async readdir(path) {
          calls.readdir += 1;
          return t.env.fs.readdir(path);
        },
        async lstat(path) {
          calls.lstat += 1;
          return t.env.fs.lstat(path);
        },
      },
    };

    const result = await applyRevertMutationPlan(env, forged, {
      storeRoot,
      options: { storeRoot, agents: ["claude-code"] },
    });

    expect(result.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    expect(JSON.stringify(result)).not.toContain("forged-revert-options");
    expect(calls).toEqual({ readFile: 0, readdir: 0, lstat: 0 });
  });

  it("6.2 treats an unknown self-consistent recovery action as manual-only", async () => {
    const outside = t.path("outside", "arbitrary-directory");
    await t.env.fs.mkdir(outside, { recursive: true });
    await t.env.fs.writeFile(join(outside, "keep.txt"), "keep");
    const after = await targetState(t.env, outside);
    const plan = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: "forged-plan",
      operation: "apply",
      baseRevision: 0,
      normalizedInputs: { storeRoot },
      targetPreconditions: [
        { actionId: "forged-action", target: outside, expected: { state: "absent" } },
      ],
      actions: [
        {
          actionId: "forged-action",
          kind: "unknown-recursive-remove",
          target: outside,
          payload: {},
          postcondition: after,
        },
      ],
      expires: { policy: "none" },
    });
    const journal: OperationJournal = {
      schemaVersion: 1,
      operationId: "operation-forged",
      plan: createDurableMutationPlan(t.env, storeRoot, plan),
      nextRevision: 1,
      status: "executing",
      startedAt: t.env.now().toISOString(),
      updatedAt: t.env.now().toISOString(),
      actions: [
        {
          actionId: "forged-action",
          target: outside,
          status: "succeeded",
          receipt: {
            actionId: "forged-action",
            target: outside,
            outcome: "applied",
            before: { state: "absent" },
            after,
            recordedAt: t.env.now().toISOString(),
          },
        },
      ],
    };
    await t.env.fs.mkdir(join(storeRoot, "operations"), { recursive: true });
    await t.env.fs.publishFileAtomically(
      operationJournalPath(storeRoot),
      `${JSON.stringify(journal, null, 2)}\n`,
      { mode: 0o600 },
    );
    let claimCalls = 0;
    let targetReads = 0;
    const originalExclusive = t.env.fs.writeFileExclusive;
    const originalLstat = t.env.fs.lstat;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        async writeFileExclusive(path, data, options) {
          claimCalls += 1;
          return originalExclusive(path, data, options);
        },
        async lstat(path) {
          if (path === outside) targetReads += 1;
          return originalLstat(path);
        },
      },
    };

    const result = await recoverInterruptedOperation(env, storeRoot, {
      operationId: journal.operationId,
    }).catch((error: unknown) => error);

    expect(result).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED" },
    });
    expect(claimCalls).toBe(0);
    expect(targetReads).toBe(0);
    await expect(t.env.fs.readFile(join(outside, "keep.txt"))).resolves.toBe("keep");
  });

  it("6.2 does not let a known add action authorize deleting config.json", async () => {
    const target = join(storeRoot, "config.json");
    const beforeText = await t.env.fs.readFile(target);
    const after = await targetState(t.env, target);
    const plan = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: "forged-known-store-action",
      operation: "store-import",
      baseRevision: 0,
      normalizedInputs: { mutationKind: "add" },
      targetPreconditions: [
        { actionId: "forged-add-rules", target, expected: { state: "absent" } },
      ],
      actions: [
        {
          actionId: "forged-add-rules",
          kind: "add-rules",
          target,
          payload: { contentDigest: after.state === "present" ? after.fingerprint : "absent" },
          postcondition: after,
        },
      ],
      expires: { policy: "none" },
    });
    const now = t.env.now().toISOString();
    const journal: OperationJournal = {
      schemaVersion: 1,
      operationId: "operation-forged-known-action",
      plan: createDurableMutationPlan(t.env, storeRoot, plan),
      nextRevision: 1,
      status: "executing",
      startedAt: now,
      updatedAt: now,
      actions: [
        {
          actionId: "forged-add-rules",
          target,
          status: "succeeded",
          receipt: {
            actionId: "forged-add-rules",
            target,
            outcome: "applied",
            before: { state: "absent" },
            after,
            recordedAt: now,
          },
        },
      ],
    };
    await t.env.fs.mkdir(join(storeRoot, "operations"), { recursive: true });
    await t.env.fs.publishFileAtomically(
      operationJournalPath(storeRoot),
      `${JSON.stringify(journal, null, 2)}\n`,
      { mode: 0o600 },
    );
    let claims = 0;
    let targetObservations = 0;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        async writeFileExclusive(path, data, options) {
          claims += 1;
          return t.env.fs.writeFileExclusive(path, data, options);
        },
        async lstat(path) {
          if (path === target) targetObservations += 1;
          return t.env.fs.lstat(path);
        },
      },
    };

    const result = await recoverInterruptedOperation(env, storeRoot, {
      operationId: journal.operationId,
    });

    expect(result).toMatchObject({ ok: false, conflict: { code: "MANUAL_RECOVERY_REQUIRED" } });
    expect(claims).toBe(0);
    expect(targetObservations).toBe(0);
    await expect(t.env.fs.readFile(target)).resolves.toBe(beforeText);
  });

  it("6.2 rejects a self-consistent store-import journal before claim, target observation, provider, or removal", async () => {
    const ruleTarget = join(storeRoot, "store", "rules", "existing-rule.md");
    const skillTarget = join(storeRoot, "store", "skills", "existing-skill");
    const skillFile = join(skillTarget, "SKILL.md");
    const ruleContent = "# Existing legitimate rule\n";
    const skillContent = "# Existing legitimate skill\n";
    await t.env.fs.writeFile(ruleTarget, ruleContent);
    await t.env.fs.mkdir(skillTarget, { recursive: true });
    await t.env.fs.writeFile(skillFile, skillContent);
    const ruleAfter = await targetState(t.env, ruleTarget);
    const skillAfter = await targetState(t.env, skillTarget);
    if (ruleAfter.state !== "present" || skillAfter.state !== "present") {
      throw new Error("expected existing Store targets");
    }
    const ruleActionId = sha256(
      JSON.stringify({ kind: "rules", name: "existing-rule", target: ruleTarget }),
    );
    const skillActionId = sha256(
      JSON.stringify({ kind: "skills", name: "existing-skill", target: skillTarget }),
    );
    const forged = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: "self-consistent-store-import",
      operation: "store-import",
      baseRevision: 0,
      normalizedInputs: { mutationKind: "add" },
      targetPreconditions: [
        { actionId: ruleActionId, target: ruleTarget, expected: { state: "absent" } },
        { actionId: skillActionId, target: skillTarget, expected: { state: "absent" } },
      ],
      actions: [
        {
          actionId: ruleActionId,
          kind: "add-rules",
          target: ruleTarget,
          payload: { contentDigest: ruleAfter.fingerprint },
          postcondition: ruleAfter,
        },
        {
          actionId: skillActionId,
          kind: "add-skills",
          target: skillTarget,
          payload: { sourceFingerprint: skillAfter.fingerprint },
          postcondition: skillAfter,
        },
      ],
      expires: { policy: "none" },
    });
    const now = t.env.now().toISOString();
    const journal: OperationJournal = {
      schemaVersion: 1,
      operationId: "operation-self-consistent-store-import",
      plan: createDurableMutationPlan(t.env, storeRoot, forged),
      nextRevision: 1,
      status: "executing",
      startedAt: now,
      updatedAt: now,
      actions: forged.actions.map((action, index) => ({
        actionId: action.actionId,
        target: action.target,
        status: "succeeded" as const,
        receipt: {
          actionId: action.actionId,
          target: action.target,
          outcome: "applied" as const,
          before: { state: "absent" as const },
          after: index === 0 ? ruleAfter : skillAfter,
          recordedAt: now,
        },
      })),
    };
    await t.env.fs.mkdir(join(storeRoot, "operations"), { recursive: true });
    await t.env.fs.publishFileAtomically(
      operationJournalPath(storeRoot),
      `${JSON.stringify(journal, null, 2)}\n`,
      { mode: 0o600 },
    );
    let claimCalls = 0;
    let targetLstats = 0;
    let targetReads = 0;
    let targetRemovals = 0;
    let providerCalls = 0;
    const isTargetPath = (path: string) =>
      path === ruleTarget || path === skillTarget || path.startsWith(`${skillTarget}/`);
    const env: Env = {
      ...t.env,
      secretStore: {
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
      },
      fs: {
        ...t.env.fs,
        async writeFileExclusive(path, data, options) {
          claimCalls += 1;
          return t.env.fs.writeFileExclusive(path, data, options);
        },
        async lstat(path) {
          if (isTargetPath(path)) targetLstats += 1;
          return t.env.fs.lstat(path);
        },
        async readFile(path) {
          if (isTargetPath(path)) targetReads += 1;
          return t.env.fs.readFile(path);
        },
        async rm(path, options) {
          if (isTargetPath(path)) targetRemovals += 1;
          return t.env.fs.rm(path, options);
        },
      },
    };

    await expect(diagnoseMutationRecovery(env, storeRoot)).resolves.toMatchObject({
      status: "manual-recovery-required",
    });
    await expect(
      recoverInterruptedOperation(env, storeRoot, { operationId: journal.operationId }),
    ).resolves.toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED" },
    });

    expect(claimCalls).toBe(0);
    expect(targetLstats).toBe(0);
    expect(targetReads).toBe(0);
    expect(targetRemovals).toBe(0);
    expect(providerCalls).toBe(0);
    await expect(t.env.fs.readFile(ruleTarget)).resolves.toBe(ruleContent);
    await expect(t.env.fs.readFile(skillFile)).resolves.toBe(skillContent);
  });

  it("6.3 rejects a self-consistent cross-root gitignore helper as one whole plan", async () => {
    await writeRuleArtifact(t.env, storeRoot, "base", "# safe\n");
    const prepared = await planApplyMutation(t.env, {
      storeRoot,
      scope: "project",
      dir: t.env.cwd(),
      agents: ["claude-code"],
      capabilities: ["rules"],
    });
    const productTarget = prepared.mutationPlan.actions.find(
      (action) => action.kind !== "sync-gitignore",
    )?.target;
    if (!productTarget) throw new Error("missing product action");
    const outsideProject = t.path("outside-project");
    await t.env.fs.mkdir(outsideProject, { recursive: true });
    const outsideHelper = await planGitignoreMutation(t.env, outsideProject, []);
    const forged = createMutationPlan({
      ...prepared.mutationPlan,
      actions: [
        ...prepared.mutationPlan.actions.filter((action) => action.kind !== "sync-gitignore"),
        outsideHelper.action,
      ],
      targetPreconditions: [
        ...prepared.mutationPlan.targetPreconditions.filter(
          (precondition) =>
            !prepared.mutationPlan.actions.some(
              (action) =>
                action.kind === "sync-gitignore" && action.actionId === precondition.actionId,
            ),
        ),
        outsideHelper.precondition,
      ],
    });
    let lockCalls = 0;
    const original = t.env.fs.writeFileExclusive;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        async writeFileExclusive(path, data, options) {
          lockCalls += 1;
          return original(path, data, options);
        },
      },
    };

    const result = await applyMutationPlan(env, forged, {
      storeRoot,
      options: {
        storeRoot,
        scope: "project",
        dir: t.env.cwd(),
        agents: ["claude-code"],
        capabilities: ["rules"],
      },
    });

    expect(result.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    expect(lockCalls).toBe(0);
    await expect(t.env.fs.lstat(productTarget)).rejects.toThrow();
    await expect(t.env.fs.lstat(join(outsideProject, ".gitignore"))).rejects.toThrow();
  });

  it("6.3 rejects an extra re-signed gitignore target before writing the product target", async () => {
    await writeRuleArtifact(t.env, storeRoot, "base", "# safe\n");
    const options = {
      storeRoot,
      scope: "project" as const,
      dir: t.env.cwd(),
      agents: ["claude-code"],
      capabilities: ["rules" as const],
    };
    const prepared = await planApplyMutation(t.env, options);
    const product = prepared.mutationPlan.actions.find(
      (action) => action.kind !== "sync-gitignore",
    );
    const helperIndex = prepared.mutationPlan.actions.findIndex(
      (action) => action.kind === "sync-gitignore",
    );
    const helper = prepared.mutationPlan.actions[helperIndex];
    if (!product || !helper) throw new Error("expected product and gitignore actions");
    const extra = join(t.env.cwd(), "unmanaged-extra.txt");
    const alteredHelper = await planGitignoreMutation(t.env, t.env.cwd(), [product.target, extra]);
    const actions = [...prepared.mutationPlan.actions];
    actions[helperIndex] = alteredHelper.action;
    const targetPreconditions = prepared.mutationPlan.targetPreconditions.map((precondition) =>
      precondition.actionId === helper.actionId ? alteredHelper.precondition : precondition,
    );
    const forged = createMutationPlan({
      ...prepared.mutationPlan,
      actions,
      targetPreconditions,
    });

    const result = await applyMutationPlan(t.env, forged, { storeRoot, options }).catch(
      (error: unknown) => error,
    );

    expect(result).toMatchObject({
      operation: { ok: false, conflict: { code: "INVALID_PLAN" } },
    });
    await expect(t.env.fs.lstat(product.target)).rejects.toThrow();
    await expect(t.env.fs.lstat(join(t.env.cwd(), ".gitignore"))).rejects.toThrow();
  });

  it("6.4 inventories a selected provider value even without a colocated reference", async () => {
    const source = t.path("provider-only.md");
    const target = join(storeRoot, "store", "rules", "provider-only.md");
    await t.env.fs.writeFile(source, "provider-only value: tiny\n");
    const env: Env = { ...t.env, env: { SECRET_TOKEN: "tiny" } };

    const result = await add(env, { storeRoot, source });

    expect(result.imported).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/known secret value/i);
    expect(JSON.stringify(result)).not.toContain("tiny");
    await expect(t.env.fs.lstat(target)).rejects.toThrow();
  });

  it("6.4 inventories every managed keychain name once even without a colocated reference", async () => {
    const values = new Map<string, string>();
    let providerReads = 0;
    const secretStore: SecretStore = {
      async get(service, account) {
        providerReads += 1;
        const value = values.get(`${service}/${account}`);
        return value === undefined ? { found: false } : { found: true, value };
      },
      async set(service, account, secret) {
        values.set(`${service}/${account}`, secret);
      },
      async delete(service, account) {
        return values.delete(`${service}/${account}`);
      },
    };
    const env: Env = { ...t.env, secretStore };
    const stored = await setStoredSecret(env, storeRoot, {
      provider: "keychain",
      keychainService: "closure-service",
      name: "managed-low-entropy",
      value: "tiny",
    });
    expect(stored.operation.ok).toBe(true);
    const source = t.path("managed-keychain.md");
    const target = join(storeRoot, "store", "rules", "managed-keychain.md");
    await t.env.fs.writeFile(source, "provider-only value: tiny\n");

    const result = await add(env, {
      storeRoot,
      source,
      secretMode: "keychain",
      keychainService: "closure-service",
    });

    expect(result.imported).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/known secret value/i);
    expect(providerReads).toBe(1);
    expect(JSON.stringify(result)).not.toContain("tiny");
    await expect(t.env.fs.lstat(target)).rejects.toThrow();
  });

  it("6.4 centrally blocks low-entropy known values in final Store publication bytes", async () => {
    const configPath = join(storeRoot, "config.json");
    const before = await t.env.fs.readFile(configPath);
    const env: Env = { ...t.env, env: { SECRET_TOKEN: "tiny" } };

    await expect(
      saveCollections(env, storeRoot, {
        default: { description: "tiny" },
      }),
    ).rejects.toMatchObject({ code: "FINAL_SECRET_BYTE_GUARD" });

    await expect(t.env.fs.readFile(configPath)).resolves.toBe(before);
    await expect(t.env.fs.lstat(operationJournalPath(storeRoot))).rejects.toThrow();
  });

  it("6.5 keeps the complete plaintext-capable internal modules private at runtime", () => {
    const internalValues = new Set([
      ...Object.values(activeSecretInternals),
      ...Object.values(observableSecretInternals),
    ]);
    const escaped = Object.entries(core)
      .filter(([, value]) => internalValues.has(value))
      .map(([name]) => name)
      .sort();

    expect(escaped).toEqual([]);
  });
});
