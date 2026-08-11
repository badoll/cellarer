import { clientErrorFromMutationConflict, type MutationConflict } from "@cellarer/core";
import { describe, expect, it } from "vitest";
import { cliErrorFromMutationConflict } from "../src/protocol/execution.js";

describe("client mutation error parity", () => {
  it.each([
    {
      conflict: {
        code: "LOCK_CONFLICT",
        message: "busy",
        owner: {
          operationId: "operation-owner",
          processId: 42,
          hostname: "host",
          acquiredAt: "2026-08-10T00:00:00.000Z",
        },
      },
      details: {
        coreCode: "LOCK_CONFLICT",
        owner: {
          operationId: "operation-owner",
          processId: 42,
          hostname: "host",
          acquiredAt: "2026-08-10T00:00:00.000Z",
        },
      },
    },
    {
      conflict: {
        code: "STALE_REVISION",
        message: "stale",
        planId: "plan-stale",
        expectedRevision: 0,
        actualRevision: 1,
        replanRequired: true,
      },
      details: {
        coreCode: "STALE_REVISION",
        planId: "plan-stale",
        expectedRevision: 0,
        actualRevision: 1,
        replanRequired: true,
      },
    },
    {
      conflict: {
        code: "TARGET_PRECONDITION_CONFLICT",
        message: "target drift",
        planId: "plan-target",
        actionId: "action-target",
        target: "/tmp/target",
        expected: { state: "absent" },
        actual: { state: "present", fingerprint: "changed" },
      },
      details: {
        coreCode: "TARGET_PRECONDITION_CONFLICT",
        planId: "plan-target",
        actionId: "action-target",
        target: "/tmp/target",
        expected: { state: "absent" },
        actual: { state: "present", fingerprint: "changed" },
      },
    },
    {
      conflict: {
        code: "INTERRUPTED_OPERATION",
        message: "recover",
        operationId: "operation-interrupted",
        journalStatus: "executing",
      },
      details: {
        coreCode: "INTERRUPTED_OPERATION",
        operationId: "operation-interrupted",
        journalStatus: "executing",
      },
    },
    {
      conflict: {
        code: "PARTIAL_FAILURE",
        message: "partial",
        operationId: "operation-partial",
        failedActionIds: ["action-2"],
      },
      details: {
        coreCode: "PARTIAL_FAILURE",
        operationId: "operation-partial",
        failedActionIds: ["action-2"],
      },
    },
    {
      conflict: {
        code: "MANUAL_RECOVERY_REQUIRED",
        message: "manual recovery",
        operationId: "operation-recovery",
        targets: ["/safe/target"],
        guidance: "restore the target and retry recovery",
      },
      details: {
        coreCode: "MANUAL_RECOVERY_REQUIRED",
        operationId: "operation-recovery",
        targets: ["/safe/target"],
        guidance: "restore the target and retry recovery",
      },
    },
    {
      conflict: {
        code: "EXPIRED_PLAN",
        message: "expired",
        planId: "untrusted",
        expiredAt: "untrusted",
      },
      details: {
        coreCode: "EXPIRED_PLAN",
        planId: "untrusted",
        expiredAt: "untrusted",
      },
    },
    {
      conflict: {
        code: "INVALID_PLAN_DIGEST",
        message: "invalid digest",
        planId: "untrusted",
        expectedDigest: "untrusted",
        actualDigest: "invalid",
      },
      details: {
        coreCode: "INVALID_PLAN_DIGEST",
        planId: "untrusted",
        expectedDigest: "untrusted",
        actualDigest: "invalid",
      },
    },
    {
      conflict: {
        code: "INVALID_PLAN",
        message: "mutation plan is invalid",
      },
      details: { coreCode: "INVALID_PLAN" },
    },
  ] satisfies readonly {
    readonly conflict: MutationConflict;
    readonly details: Readonly<Record<string, unknown>>;
  }[])("preserves $conflict.code evidence through one Core contract", ({ conflict, details }) => {
    const shared = clientErrorFromMutationConflict(conflict);

    expect(shared.details).toEqual(details);
    expect(cliErrorFromMutationConflict(conflict)).toEqual(shared);
  });
});
