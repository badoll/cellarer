import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMutationPlan, planApplyMutation } from "../src/engine/apply.js";
import { applyRevertMutationPlan, planRevertMutation } from "../src/engine/revert.js";
import {
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
import { acquireStoreMutationLock } from "../src/protocol/mutation-lock.js";
import {
  publishStoreRevision,
  readStoreRevision,
  storeRevisionPath,
} from "../src/protocol/store-revision.js";
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
    applyMutationPlan(t.env, mutationPlan, { storeRoot });
  const revertReceipt = (mutationPlan: Parameters<typeof applyRevertMutationPlan>[1]) =>
    applyRevertMutationPlan(t.env, mutationPlan, { storeRoot });

  it("rejects a tampered plan digest before target mutation", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const tampered = { ...prepared.mutationPlan, baseRevision: 99 };

    const result = await applyReceipt(tampered);

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN_DIGEST", planId: prepared.mutationPlan.planId },
    });
    await expect(t.env.fs.lstat(target())).rejects.toThrow();
  });

  it.each([
    {
      name: "future schema version",
      alter: (plan: MutationPlan) => ({ ...plan, schemaVersion: 2 }),
      diagnostic: /unsupported mutation plan schema version 2/i,
    },
    {
      name: "unknown expiry policy",
      alter: (plan: MutationPlan) => ({
        ...plan,
        expires: { policy: "after-approval" },
      }),
      diagnostic: /unsupported mutation plan expiry policy "after-approval"/i,
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

    await expect(applyMutationPlan(env, unsupported, { storeRoot })).rejects.toThrow(
      testCase.diagnostic,
    );

    expect(lockAttempts).toBe(0);
    await expect(t.env.fs.lstat(target())).rejects.toThrow();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
    await expect(t.env.fs.lstat(t.path("home", ".cellarer", "mutation.lock"))).rejects.toThrow();
  });

  it("accepts a canonical leap-day expires-at timestamp", async () => {
    const prepared = await planApplyMutation(t.env, options());
    const leapDayPlan = createMutationPlan({
      ...prepared.mutationPlan,
      expires: { policy: "expires-at", expiresAt: "2028-02-29T00:00:00.000Z" },
    });

    const result = await applyReceipt(leapDayPlan);

    expect(result.operation).toMatchObject({ ok: true });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
  });

  it("validates the digest under the lock before decoding malformed apply payloads", async () => {
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
        conflict: { code: "INVALID_PLAN_DIGEST" },
      });
      await expect(t.env.fs.lstat(target())).rejects.toThrow();
      await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
      await expect(t.env.fs.lstat(t.path("home", ".cellarer", "mutation.lock"))).rejects.toThrow();
    }
  });

  it("rejects stale revisions and executes the exact planned actions without replanning", async () => {
    const first = await planApplyMutation(t.env, options());
    const stale = await planApplyMutation(t.env, options());
    await writeRuleArtifact(t.env, storeRoot, "style", "changed after planning");
    const normalizedInputs = JSON.parse(
      JSON.stringify(first.mutationPlan.normalizedInputs),
    ) as Record<string, unknown>;
    const displayPlan = normalizedInputs.distributePlan as {
      actions: Array<{ preview?: { after?: string } }>;
    };
    if (displayPlan.actions[0]?.preview) {
      displayPlan.actions[0].preview.after = "unlisted display-plan mutation";
    }
    const exactReceipt = createMutationPlan({
      ...first.mutationPlan,
      normalizedInputs: normalizedInputs as CanonicalJsonObject,
    });

    const committed = await applyReceipt(exactReceipt);
    const rejected = await applyReceipt(stale.mutationPlan);

    expect(committed.operation.ok).toBe(true);
    expect(rejected.operation).toMatchObject({
      ok: false,
      conflict: { code: "STALE_REVISION", expectedRevision: 0, actualRevision: 1 },
    });
    await expect(t.env.fs.readFile(target())).resolves.toContain("planned content");
    await expect(t.env.fs.readFile(target())).resolves.not.toContain("changed after planning");
    await expect(t.env.fs.readFile(target())).resolves.not.toContain(
      "unlisted display-plan mutation",
    );
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
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
    const expired = createMutationPlan({
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
      conflict: { code: "TARGET_PRECONDITION_CONFLICT", target: target() },
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

    const result = await applyMutationPlan(env, prepared.mutationPlan, { storeRoot });

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

    const result = await applyRevertMutationPlan(env, prepared.mutationPlan, { storeRoot });

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
      conflict: { code: "TARGET_PRECONDITION_CONFLICT", target: target() },
    });

    const currentRevert = await planRevertMutation(t.env, {
      storeRoot,
      agents: ["claude-code"],
      acknowledgements: [
        (await planRevertMutation(t.env, { storeRoot, agents: ["claude-code"] })).plan.targets[0]
          ?.acknowledgement?.token ?? "",
      ],
    });
    const reverted = await revertReceipt(currentRevert.mutationPlan);
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

  it("validates the digest under the lock before decoding malformed revert payloads", async () => {
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
        conflict: { code: "INVALID_PLAN_DIGEST" },
      });
      await expect(t.env.fs.lstat(target())).resolves.toBeDefined();
      await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
      await expect(t.env.fs.lstat(t.path("home", ".cellarer", "mutation.lock"))).rejects.toThrow();
    }
  });

  it("returns PARTIAL_FAILURE when the second ordinary apply action hits an I/O error", async () => {
    const prepared = await planApplyMutation(t.env, {
      ...options(),
      agents: ["claude-code", "codex"],
    });
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

    const result = await applyMutationPlan(env, prepared.mutationPlan, { storeRoot });

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

    const result = await applyMutationPlan(env, prepared.mutationPlan, { storeRoot });

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
    const prepared = await planApplyMutation(t.env, {
      ...options(),
      scope: "project",
      dir: projectDir,
    });
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

    const result = await applyMutationPlan(env, prepared.mutationPlan, { storeRoot });

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

    const result = await applyMutationPlan(env, prepared.mutationPlan, { storeRoot });

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

    const result = await applyMutationPlan(env, prepared.mutationPlan, { storeRoot });

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

    const result = await applyMutationPlan(env, prepared.mutationPlan, { storeRoot });

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

    const result = await applyMutationPlan(env, prepared.mutationPlan, { storeRoot });

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

    const result = await applyMutationPlan(env, prepared.mutationPlan, { storeRoot });

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

    const result = await applyRevertMutationPlan(env, prepared.mutationPlan, { storeRoot });

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
    const prepared = await planApplyMutation(t.env, {
      ...options(),
      scope: "project",
      dir: projectDir,
    });
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

    const result = await applyMutationPlan(t.env, prepared.mutationPlan, { storeRoot });

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
    const prepared = await planApplyMutation(t.env, {
      ...options(),
      scope: "project",
      dir: projectDir,
    });
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

    const result = await applyMutationPlan(env, prepared.mutationPlan, { storeRoot });

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
    const prepared = await planApplyMutation(t.env, {
      ...options(),
      scope: "project",
      dir: projectDir,
    });
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

    await expect(applyMutationPlan(env, prepared.mutationPlan, { storeRoot })).rejects.toThrow(
      "crash-before-state-publication",
    );

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
    const applyPlan = await planApplyMutation(t.env, {
      ...options(),
      scope: "project",
      dir: projectDir,
    });
    expect(
      (await applyMutationPlan(t.env, applyPlan.mutationPlan, { storeRoot })).operation.ok,
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

    const result = await applyRevertMutationPlan(env, prepared.mutationPlan, { storeRoot });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "PARTIAL_FAILURE" },
      journal: { status: "recovery-required" },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
    await expect(t.env.fs.readFile(gitignorePath)).resolves.toContain("/CLAUDE.md");
  });
});
