import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMutationPlan, planApplyMutation } from "../src/engine/apply.js";
import type { Env } from "../src/env.js";
import { createMutationPlan } from "../src/protocol/canonical.js";
import {
  executeMutationPlan,
  type RecordOperationAction,
  targetState,
} from "../src/protocol/execute.js";
import type { MutationPlan, OperationActionReceipt } from "../src/protocol/models.js";
import { mutationPresentation } from "../src/protocol/presentation.js";
import { recoverInterruptedOperation } from "../src/protocol/recovery.js";
import { readStoreRevision } from "../src/protocol/store-revision.js";
import { saveCollections, saveDefaults } from "../src/settings.js";
import { initStore, writeRuleArtifact } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("transaction caller integration", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv({ randomId: () => "integration" });
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
    await writeRuleArtifact(t.env, storeRoot, "style", "planned content");
    await t.env.fs.mkdir(t.path("home", ".agent"), { recursive: true });
  });

  afterEach(() => t.cleanup());

  const applyOptions = () => ({
    storeRoot,
    scope: "global" as const,
    agents: ["claude-code"],
    capabilities: ["rules" as const],
  });

  it("surfaces stale-plan identity and revisions without publishing its journal", async () => {
    const first = await planApplyMutation(t.env, applyOptions(), { planId: "plan-first" });
    const stale = await planApplyMutation(t.env, applyOptions(), { planId: "plan-stale" });
    expect((await applyMutationPlan(t.env, first.mutationPlan, { storeRoot })).operation.ok).toBe(
      true,
    );

    const rejected = await applyMutationPlan(t.env, stale.mutationPlan, { storeRoot });
    const presented = mutationPresentation(stale.mutationPlan, rejected.operation);

    expect(presented).toMatchObject({
      planId: "plan-stale",
      operation: "apply",
      baseRevision: 0,
      result: {
        ok: false,
        conflict: {
          code: "STALE_REVISION",
          expectedRevision: 0,
          actualRevision: 1,
          replanRequired: true,
        },
      },
    });
    expect(JSON.stringify(presented)).not.toContain("journal");
  });

  it("surfaces target drift as a typed precondition conflict", async () => {
    const prepared = await planApplyMutation(t.env, applyOptions(), { planId: "plan-drift" });
    const target = t.path("home", ".claude", "CLAUDE.md");
    await t.env.fs.mkdir(t.path("home", ".claude"), { recursive: true });
    await t.env.fs.writeFile(target, "external edit");

    const rejected = await applyMutationPlan(t.env, prepared.mutationPlan, { storeRoot });

    expect(mutationPresentation(prepared.mutationPlan, rejected.operation)).toMatchObject({
      planId: "plan-drift",
      result: {
        ok: false,
        conflict: { code: "TARGET_PRECONDITION_CONFLICT", target },
      },
    });
  });

  it("surfaces partial failure receipts and typed recovery guidance without journal payloads", async () => {
    const mutationPlan = genericPlan(["a.txt", "b.txt"]);
    const result = await executeMutationPlan(
      t.env,
      storeRoot,
      mutationPlan,
      async (_operationId, recordAction) => {
        const succeeded = await writeAction(t.env, mutationPlan, 0, recordAction);
        const failedAction = mutationPlan.actions[1];
        if (!failedAction) throw new Error("missing failed test action");
        const failed: OperationActionReceipt = {
          actionId: failedAction.actionId,
          target: failedAction.target,
          outcome: "failed",
          before: { state: "absent" },
          after: { state: "absent" },
          recordedAt: t.env.now().toISOString(),
          error: { code: "TEST_FAILURE", message: "fixture failure" },
        };
        await recordAction(failed);
        return {
          actionReceipts: [succeeded, failed],
          failedActionIds: [failed.actionId],
        };
      },
    );

    const presented = mutationPresentation(mutationPlan, result);
    expect(presented).toMatchObject({
      planId: "plan-generic",
      result: {
        ok: false,
        conflict: {
          code: "PARTIAL_FAILURE",
          failedActionIds: ["action-2"],
        },
      },
    });
    expect(JSON.stringify(presented)).not.toContain("statePublications");
  });

  it("surfaces a successful compensated recovery as an operation receipt", async () => {
    const mutationPlan = genericPlan(["recover.txt"]);
    await expect(
      executeMutationPlan(t.env, storeRoot, mutationPlan, async (_operationId, recordAction) => {
        await writeAction(t.env, mutationPlan, 0, recordAction);
        throw new Error("interrupt after durable action receipt");
      }),
    ).rejects.toThrow("interrupt after durable action receipt");
    const recoveryEnv: Env = {
      ...t.env,
      probeProcessLiveness: async () => "dead",
    };

    const recovered = await recoverInterruptedOperation(recoveryEnv, storeRoot, {
      operationId: "operation-integration",
    });

    expect(mutationPresentation(mutationPlan, recovered)).toMatchObject({
      planId: "plan-generic",
      result: {
        ok: true,
        receipt: {
          operationId: "operation-integration",
          planId: "plan-generic",
          baseRevision: 0,
          resultingRevision: 0,
          outcome: "compensated",
          actionReceipts: [{ actionId: "action-1", outcome: "compensated" }],
        },
      },
    });
    await expect(t.env.fs.lstat(t.path("home", ".agent", "recover.txt"))).rejects.toThrow();
  });

  it("serializes concurrent settings writes through the same store lock", async () => {
    const configPath = t.path("home", ".cellarer", "config.json");
    const originalPublish = t.env.fs.publishFileAtomically;
    let releasePublication!: () => void;
    let announcePublication!: () => void;
    const publicationStarted = new Promise<void>((resolve) => {
      announcePublication = resolve;
    });
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const firstEnv: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          if (path === configPath) {
            announcePublication();
            await publicationGate;
          }
          await originalPublish(path, data, opts);
        },
      },
    };

    const first = saveCollections(firstEnv, storeRoot, {
      default: { description: "Default" },
      work: { description: "Work" },
    });
    await publicationStarted;
    await expect(saveDefaults(t.env, storeRoot, { method: "copy" })).rejects.toMatchObject({
      code: "LOCK_CONFLICT",
      conflict: { code: "LOCK_CONFLICT" },
    });
    releasePublication();
    await first;

    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
  });

  it("makes a previously planned apply stale after a settings commit", async () => {
    const prepared = await planApplyMutation(t.env, applyOptions(), { planId: "before-settings" });

    await saveDefaults(t.env, storeRoot, { method: "copy" });
    const result = await applyMutationPlan(t.env, prepared.mutationPlan, { storeRoot });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "STALE_REVISION", expectedRevision: 0, actualRevision: 1 },
    });
  });

  function genericPlan(names: string[]): MutationPlan {
    const targets = names.map((name) => t.path("home", ".agent", name));
    return createMutationPlan({
      schemaVersion: 1,
      planId: "plan-generic",
      operation: "apply",
      baseRevision: 0,
      normalizedInputs: {},
      targetPreconditions: targets.map((target, index) => ({
        actionId: `action-${index + 1}`,
        target,
        expected: { state: "absent" },
      })),
      actions: targets.map((target, index) => ({
        actionId: `action-${index + 1}`,
        kind: "write",
        target,
        payload: {},
      })),
      expires: { policy: "none" },
    });
  }
});

async function writeAction(
  env: Env,
  mutationPlan: MutationPlan,
  index: number,
  recordAction: RecordOperationAction,
): Promise<OperationActionReceipt> {
  const action = mutationPlan.actions[index];
  const precondition = mutationPlan.targetPreconditions[index];
  if (!action || !precondition) throw new Error(`missing test action ${index}`);
  const before = precondition.expected;
  await env.fs.writeFile(action.target, `after-${index + 1}`);
  const receipt: OperationActionReceipt = {
    actionId: action.actionId,
    target: action.target,
    outcome: "applied",
    before,
    after: await targetState(env, action.target),
    recordedAt: env.now().toISOString(),
  };
  await recordAction(receipt);
  return receipt;
}
