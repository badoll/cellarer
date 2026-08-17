import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";

describe("@cellarer/core package root", () => {
  it("exposes complete services without low-level mutation primitives", () => {
    expect(core).toHaveProperty("initializeStore");
    expect(core).toHaveProperty("recoverInterruptedOperation");
    expect(core).toHaveProperty("pruneOperationRecoveryArtifacts");
    expect(core).toHaveProperty("observeStoreConfigSnapshot");
    expect(core).not.toHaveProperty("initStore");
    expect(core).not.toHaveProperty("executeMutationPlan");
    expect(core).not.toHaveProperty("publishOperationJournal");
    expect(core).not.toHaveProperty("publishOperationReceipt");
    expect(core).not.toHaveProperty("removeOperationJournal");
    expect(core).not.toHaveProperty("pruneOperationReceipts");
    expect(core).not.toHaveProperty("acquireStoreMutationLock");
    expect(core).not.toHaveProperty("acquireStoreRecoveryLock");
    expect(core).not.toHaveProperty("releaseStoreMutationLock");
    expect(core).not.toHaveProperty("releaseStoreRecoveryLock");
    expect(core).not.toHaveProperty("publishStoreRevision");
    expect(core).not.toHaveProperty("appendActivity");
    expect(core).toHaveProperty("createMutationPlan");
    expect(core).not.toHaveProperty("mutationPlanDigest");
    expect(core).not.toHaveProperty("verifyMutationPlanDigest");
  });

  it("narrows the public integrity helper so it cannot mint executable authority", () => {
    const plan = core.createMutationPlan({
      schemaVersion: 1,
      planId: "public-integrity-only",
      operation: "apply",
      baseRevision: 0,
      normalizedInputs: {},
      targetPreconditions: [],
      actions: [],
      expires: { policy: "none" },
    });

    expect(plan.authorization).toMatchObject({
      authorityId: "unsealed",
      authorityEpoch: 0,
    });
  });
});
