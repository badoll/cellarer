import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  canonicalJson,
  canonicalMutationPlan,
  createAuthorizedMutationPlan,
  createDurableMutationPlan,
  createMutationPlan,
  mutationPlanDigest,
  verifyMutationPlanDigest,
} from "../src/protocol/canonical.js";
import type {
  MutationConflict,
  MutationPlanInput,
  OperationJournal,
  OperationReceipt,
  OperationResult,
} from "../src/protocol/models.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

interface GoldenFixture {
  canonicalPlan: string;
  digest: string;
  conflicts: MutationConflict[];
  journal: OperationJournal;
  receipt: OperationReceipt;
}

const golden = JSON.parse(
  readFileSync(new URL("./fixtures/transaction-protocol-v1.json", import.meta.url), "utf8"),
) as GoldenFixture;

const planInput: MutationPlanInput = {
  schemaVersion: 1,
  planId: "plan-0001",
  operation: "apply",
  baseRevision: 7,
  normalizedInputs: { scope: "global", agents: ["claude-code", "codex"] },
  targetPreconditions: [
    { actionId: "action-1", target: "/tmp/a", expected: { state: "absent" } },
    {
      actionId: "action-2",
      target: "/tmp/b",
      expected: { state: "present", fingerprint: "sha256:before" },
    },
  ],
  actions: [
    {
      actionId: "action-1",
      kind: "write",
      target: "/tmp/a",
      payload: { mode: 420, contentDigest: "sha256:after-a" },
    },
    { actionId: "action-2", kind: "remove", target: "/tmp/b", payload: {} },
  ],
  expires: { policy: "expires-at", expiresAt: "2026-07-28T12:00:00.000Z" },
};

describe("transaction protocol v1", () => {
  it("uses one deterministic canonical encoding and digest", () => {
    expect(canonicalMutationPlan(planInput)).toBe(golden.canonicalPlan);
    expect(mutationPlanDigest(planInput)).toBe(golden.digest);

    const reordered: MutationPlanInput = {
      actions: planInput.actions,
      targetPreconditions: planInput.targetPreconditions,
      expires: planInput.expires,
      normalizedInputs: planInput.normalizedInputs,
      baseRevision: planInput.baseRevision,
      operation: planInput.operation,
      planId: planInput.planId,
      schemaVersion: planInput.schemaVersion,
    };
    expect(canonicalMutationPlan(reordered)).toBe(golden.canonicalPlan);
  });

  it("creates a deeply immutable plan receipt and detects tampering", () => {
    const plan = createMutationPlan(planInput);
    expect(plan.digest).toBe(golden.digest);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.actions)).toBe(true);
    expect(Object.isFrozen(plan.actions[0]?.payload)).toBe(true);
    expect(verifyMutationPlanDigest(plan)).toBe(true);

    const tampered = {
      ...plan,
      baseRevision: plan.baseRevision + 1,
    };
    expect(verifyMutationPlanDigest(tampered)).toBe(false);
  });

  it("keeps every specified conflict as a stable discriminated contract", () => {
    const conflicts: MutationConflict[] = [
      {
        code: "LOCK_CONFLICT",
        message: "store mutation lock is held",
        owner: {
          operationId: "operation-active",
          processId: 1234,
          hostname: "workstation",
          acquiredAt: "2026-07-28T10:00:00.000Z",
        },
      },
      {
        code: "STALE_REVISION",
        message: "store revision changed; replan required",
        planId: "plan-0001",
        expectedRevision: 7,
        actualRevision: 8,
        replanRequired: true,
      },
      {
        code: "EXPIRED_PLAN",
        message: "plan expired",
        planId: "plan-0001",
        expiredAt: "2026-07-28T12:00:00.000Z",
      },
      {
        code: "INVALID_PLAN_DIGEST",
        message: "plan digest does not match its contents",
        planId: "plan-0001",
        expectedDigest: "sha256:expected",
        actualDigest: "sha256:actual",
      },
      {
        code: "TARGET_PRECONDITION_CONFLICT",
        message: "target changed after planning",
        planId: "plan-0001",
        actionId: "action-2",
        target: "/tmp/b",
        expected: { state: "present", fingerprint: "sha256:before" },
        actual: { state: "present", fingerprint: "sha256:changed" },
      },
      {
        code: "INTERRUPTED_OPERATION",
        message: "an incomplete operation requires recovery",
        operationId: "operation-0001",
        journalStatus: "executing",
      },
      {
        code: "PARTIAL_FAILURE",
        message: "one or more actions failed",
        operationId: "operation-0001",
        failedActionIds: ["action-2"],
      },
      {
        code: "MANUAL_RECOVERY_REQUIRED",
        message: "target matches neither recorded receipt",
        operationId: "operation-0001",
        targets: ["/tmp/b"],
        guidance: "inspect the target and journal before changing either",
      },
    ];

    expect(conflicts).toEqual(golden.conflicts);
  });

  it("keeps journals, operation receipts, and results versioned and serializable", () => {
    const actionReceipt = {
      actionId: "action-1",
      target: "/tmp/a",
      outcome: "applied" as const,
      before: { state: "absent" as const },
      after: { state: "present" as const, fingerprint: "sha256:after-a" },
      recordedAt: "2026-07-28T10:01:01.000Z",
    };
    const authority = deterministicMutationAuthority();
    const storeRoot = "/tmp/cellarer-protocol-fixture";
    const authorityEnv = { cwd: () => "/", mutationAuthority: authority } as Env;
    const durablePlan = createDurableMutationPlan(
      authorityEnv,
      storeRoot,
      createAuthorizedMutationPlan(authorityEnv, storeRoot, planInput),
    );
    const unsignedJournal = {
      schemaVersion: 1,
      operationId: "operation-0001",
      sequence: 1,
      previousJournalSeal: null,
      plan: durablePlan,
      nextRevision: 8,
      status: "executing",
      startedAt: "2026-07-28T10:01:00.000Z",
      updatedAt: "2026-07-28T10:01:01.000Z",
      actions: [
        { actionId: "action-1", target: "/tmp/a", status: "succeeded", receipt: actionReceipt },
        { actionId: "action-2", target: "/tmp/b", status: "pending" },
      ],
    };
    const journal: OperationJournal = {
      ...unsignedJournal,
      authorization: authority.seal({
        schemaVersion: 1,
        domain: "operation-journal-v1",
        normalizedStoreRoot: storeRoot,
        operation: durablePlan.operation,
        baseRevision: durablePlan.baseRevision,
        canonicalPayload: canonicalJson(unsignedJournal),
      }),
    };
    const receipt: OperationReceipt = {
      schemaVersion: 1,
      operationId: "operation-0001",
      planId: "plan-0001",
      planDigest: golden.digest,
      operation: "apply",
      baseRevision: 7,
      resultingRevision: 8,
      outcome: "committed",
      actionReceipts: [actionReceipt],
      startedAt: "2026-07-28T10:01:00.000Z",
      completedAt: "2026-07-28T10:01:02.000Z",
    };
    const success: OperationResult = { ok: true, receipt };
    const staleConflict = golden.conflicts[1];
    if (!staleConflict) throw new Error("golden stale conflict is missing");
    const failure: OperationResult = { ok: false, conflict: staleConflict };

    expect(journal).toMatchObject({
      schemaVersion: 1,
      sequence: 1,
      previousJournalSeal: null,
      plan: { authorization: { domain: "durable-plan-v1" } },
      authorization: { domain: "operation-journal-v1" },
    });
    expect(JSON.parse(JSON.stringify(journal))).toEqual(journal);
    expect(receipt).toEqual(golden.receipt);
    expect(JSON.parse(JSON.stringify(success))).toEqual({ ok: true, receipt: golden.receipt });
    expect(JSON.parse(JSON.stringify(failure))).toEqual({
      ok: false,
      conflict: golden.conflicts[1],
    });
  });
});
