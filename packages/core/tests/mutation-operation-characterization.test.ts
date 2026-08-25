import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { canonicalMutationPlan, createAuthorizedMutationPlan } from "../src/protocol/canonical.js";
import type { MutationOperation, MutationPlanInput } from "../src/protocol/models.js";
import {
  characterizeMutationOperationPlan,
  mutationOperationAdapters,
} from "../src/protocol/operation-adapter.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

const actionKinds: Readonly<Record<MutationOperation, string>> = {
  initialize: "mkdir",
  apply: "write",
  revert: "restore-snapshot",
  settings: "publish-file",
  "secret-metadata": "keychain-secret-set",
  "store-import": "inventory-resource-content",
  "resource-lifecycle": "install-resource-content",
  "sync-uninstall": "remove-target",
};

const env = {
  cwd: () => "/workspace",
  mutationAuthority: deterministicMutationAuthority(),
} as Env;

describe("mutation operation characterization", () => {
  it.each(
    mutationOperationAdapters,
  )("freezes canonical, action, authority, receipt, and recovery metadata for $operation", (adapter) => {
    const actionId = `action-${adapter.operation}`;
    const input: MutationPlanInput = {
      schemaVersion: 1,
      planId: `plan-${adapter.operation}`,
      operation: adapter.operation,
      baseRevision: 7,
      normalizedInputs: { mutationKind: `fixture-${adapter.operation}` },
      targetPreconditions: [
        { actionId, target: `/workspace/${adapter.operation}`, expected: { state: "absent" } },
      ],
      actions: [
        {
          actionId,
          kind: actionKinds[adapter.operation],
          target: `/workspace/${adapter.operation}`,
          payload: { fixture: adapter.operation },
        },
      ],
      expires: { policy: "none" },
    };
    const plan = createAuthorizedMutationPlan(env, "/workspace/store", input);
    const characterization = characterizeMutationOperationPlan(adapter, plan);

    expect(characterization).toEqual({
      canonicalPlan: canonicalMutationPlan(plan),
      authorityScope: {
        authorityId: "test-authority",
        authorityEpoch: 1,
        domain: "executable-plan-v1",
      },
      orderedEffects: [
        {
          actionId,
          kind: actionKinds[adapter.operation],
          target: `/workspace/${adapter.operation}`,
        },
      ],
      receiptProjection: "kernel-operation-receipt-v1",
      recovery: adapter.recovery,
    });
  });
});
