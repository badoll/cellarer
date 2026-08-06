import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mutateCollection, mutateControlPlaneSettings } from "../src/control-plane-mutations.js";
import { applyMutationPlan, planApplyMutation } from "../src/engine/apply.js";
import type { Env } from "../src/env.js";
import { createAuthorizedMutationPlan } from "../src/protocol/canonical.js";
import {
  executeMutationPlan,
  type RecordOperationAction,
  targetState,
} from "../src/protocol/execute.js";
import type { MutationPlan, OperationActionReceipt } from "../src/protocol/models.js";
import { mutationPresentation } from "../src/protocol/presentation.js";
import { recoverInterruptedOperation } from "../src/protocol/recovery.js";
import { publishStoreRevision, readStoreRevision } from "../src/protocol/store-revision.js";
import { sha256 } from "../src/store/checksum.js";
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

  it("surfaces stale-plan revisions without publishing raw identity or its journal", async () => {
    const first = await planApplyMutation(t.env, applyOptions(), { planId: "plan-first" });
    const stale = await planApplyMutation(t.env, applyOptions(), { planId: "plan-stale" });
    expect(
      (
        await applyMutationPlan(t.env, first.mutationPlan, {
          storeRoot,
          options: applyOptions(),
        })
      ).operation.ok,
    ).toBe(true);

    const rejected = await applyMutationPlan(t.env, stale.mutationPlan, {
      storeRoot,
      options: applyOptions(),
    });
    const presented = mutationPresentation(stale.mutationPlan, rejected.operation);

    expect(presented).toMatchObject({
      planId: "untrusted",
      operation: "apply",
      baseRevision: 0,
      result: {
        ok: false,
        conflict: {
          code: "INVALID_PLAN",
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

    const rejected = await applyMutationPlan(t.env, prepared.mutationPlan, {
      storeRoot,
      options: applyOptions(),
    });

    expect(mutationPresentation(prepared.mutationPlan, rejected.operation)).toMatchObject({
      planId: "untrusted",
      result: {
        ok: false,
        conflict: { code: "TARGET_PRECONDITION_CONFLICT" },
      },
    });
  });

  it("omits untrusted low-entropy fields from early conflicts and their presentation", async () => {
    const lowPlanId = "tiny-plan-id";
    const lowActionId = "tiny-action-id";
    const lowTargetSegment = "tiny-target-path";
    const lowExpiresAt = "2020-01-01T00:00:00.000Z";
    const target = t.path("home", ".agent", lowTargetSegment);
    const baseInput = {
      schemaVersion: 1 as const,
      planId: lowPlanId,
      operation: "apply" as const,
      baseRevision: 0,
      normalizedInputs: {},
      targetPreconditions: [
        { actionId: lowActionId, target, expected: { state: "absent" as const } },
      ],
      actions: [{ actionId: lowActionId, kind: "write", target, payload: {} }],
      expires: { policy: "none" as const },
    };
    const serialized = async (plan: MutationPlan) => {
      const result = await executeMutationPlan(t.env, storeRoot, plan, async () => {
        throw new Error("an early conflict must not execute product actions");
      });
      return {
        operation: JSON.stringify(result),
        presentation: JSON.stringify(mutationPresentation(plan, result)),
      };
    };

    const expired = await serialized(
      createAuthorizedMutationPlan(t.env, storeRoot, {
        ...baseInput,
        expires: { policy: "expires-at", expiresAt: lowExpiresAt },
      }),
    );

    await publishStoreRevision(t.env, storeRoot, 1);
    const stalePlan = createAuthorizedMutationPlan(t.env, storeRoot, baseInput);
    const stale = await serialized(stalePlan);

    await publishStoreRevision(t.env, storeRoot, 0);
    await t.env.fs.mkdir(t.path("home", ".agent"), { recursive: true });
    await t.env.fs.writeFile(target, "drifted");
    const drifted = await serialized(createAuthorizedMutationPlan(t.env, storeRoot, baseInput));

    for (const output of [expired, stale, drifted]) {
      for (const raw of [lowPlanId, lowActionId, lowTargetSegment, lowExpiresAt]) {
        expect(output.operation).not.toContain(raw);
        expect(output.presentation).not.toContain(raw);
      }
      expect(output.presentation).not.toContain(stalePlan.digest);
    }
    expect(expired.operation).toContain('"code":"EXPIRED_PLAN"');
    expect(stale.operation).toContain('"code":"STALE_REVISION"');
    expect(drifted.operation).toContain('"code":"TARGET_PRECONDITION_CONFLICT"');
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
          failedActionIds: [mutationPlan.actions[1]?.actionId],
        },
      },
    });
    expect(JSON.stringify(presented)).not.toContain("statePublications");
  });

  it("surfaces an interrupted store import as manual-only without compensating its target", async () => {
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
        ok: false,
        conflict: {
          code: "MANUAL_RECOVERY_REQUIRED",
        },
      },
    });
    await expect(t.env.fs.readFile(mutationPlan.actions[0]?.target ?? "missing")).resolves.toBe(
      "after-1",
    );
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

    const first = mutateCollection(firstEnv, {
      storeRoot,
      action: "create",
      collectionName: "work",
      description: "Work",
      resourceIds: [],
    });
    await publicationStarted;
    await expect(
      mutateControlPlaneSettings(t.env, {
        storeRoot,
        action: "update",
        settings: { method: "copy" },
      }),
    ).rejects.toMatchObject({ code: "LOCK_CONFLICT", conflict: { code: "LOCK_CONFLICT" } });
    releasePublication();
    await first;

    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
  });

  it("makes a previously planned apply stale after a settings commit", async () => {
    const prepared = await planApplyMutation(t.env, applyOptions(), { planId: "before-settings" });

    await mutateControlPlaneSettings(t.env, {
      storeRoot,
      action: "update",
      settings: { method: "copy" },
    });
    const result = await applyMutationPlan(t.env, prepared.mutationPlan, {
      storeRoot,
      options: applyOptions(),
    });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });
  });

  function genericPlan(names: string[]): MutationPlan {
    const targets = names.map((name) =>
      t.path("home", ".cellarer", "store", "rules", `${name.replace(/\.txt$/, "")}.md`),
    );
    const actionId = (target: string, index: number) =>
      sha256(
        JSON.stringify({
          kind: "rules",
          name: names[index]?.replace(/\.txt$/, ""),
          target,
        }),
      );
    return createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: "plan-generic",
      operation: "store-import",
      baseRevision: 0,
      normalizedInputs: { mutationKind: "add" },
      targetPreconditions: targets.map((target, index) => ({
        actionId: actionId(target, index),
        target,
        expected: { state: "absent" },
      })),
      actions: targets.map((target, index) => ({
        actionId: actionId(target, index),
        kind: "add-rules",
        target,
        payload: { contentDigest: sha256(`after-${index + 1}`) },
        postcondition: {
          state: "present" as const,
          fingerprint: sha256(`after-${index + 1}`),
        },
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
