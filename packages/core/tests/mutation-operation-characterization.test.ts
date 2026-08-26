import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { canonicalMutationPlan, createAuthorizedMutationPlan } from "../src/protocol/canonical.js";
import type { MutationOperation, MutationPlanInput } from "../src/protocol/models.js";
import {
  characterizeMutationOperationPlan,
  mutationOperationAdapters,
  resolveAuthorizedMutationOperationAdapter,
} from "../src/protocol/operation-adapter.js";
import { sha256 } from "../src/store/checksum.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

const fixtures: Readonly<
  Record<
    MutationOperation,
    {
      readonly normalizedInputs: MutationPlanInput["normalizedInputs"];
      readonly actions: MutationPlanInput["actions"];
    }
  >
> = {
  initialize: {
    normalizedInputs: { mutationKind: "initialize-store" },
    actions: [
      {
        actionId: "initialize-config",
        kind: "publish-file",
        target: "/workspace/store/config.json",
        payload: {
          path: "/workspace/store/config.json",
          digest: sha256("{}\n"),
          mode: 0o600,
        },
        postcondition: { state: "present", fingerprint: sha256("{}\n") },
      },
      ...["rules", "mcp", "skills", "metadata/skills"].map((path, index) => ({
        actionId: `initialize-layout-${index}`,
        kind: "mkdir",
        target: `/workspace/store/store/${path}`,
        payload: { path: `/workspace/store/store/${path}` },
        postcondition: { state: "present" as const, fingerprint: `fixture-${index}` },
      })),
    ],
  },
  apply: {
    normalizedInputs: {
      storeRoot: "/workspace/store",
      scope: "global",
      agents: ["codex"],
      configFingerprint: sha256("config"),
      storeProvenance: [],
      capabilityRootProvenance: [],
      distributePlan: {
        actions: [{ op: "write", target: "/workspace/apply" }],
        warnings: [],
        conflicts: [],
      },
    },
    actions: [
      {
        actionId: "apply",
        kind: "write",
        target: "/workspace/apply",
        payload: { planAction: { op: "write", target: "/workspace/apply" } },
      },
    ],
  },
  revert: {
    normalizedInputs: {
      storeRoot: "/workspace/store",
      revertPlan: {
        targets: [
          { target: "/workspace/revert", proposedAction: "restore-snapshot", blocked: false },
        ],
        warnings: [],
        conflicts: [],
      },
    },
    actions: [
      {
        actionId: "revert",
        kind: "restore-snapshot",
        target: "/workspace/revert",
        payload: {
          revertTarget: {
            target: "/workspace/revert",
            proposedAction: "restore-snapshot",
            blocked: false,
          },
        },
      },
    ],
  },
  settings: {
    normalizedInputs: {
      mutationKind: "config-update",
      businessInput: { kind: "settings", action: "update", settings: { method: "copy" } },
      changedFields: ["defaults.method"],
      storeProvenance: [{ path: "/workspace/store/config.json", expected: { state: "absent" } }],
    },
    actions: [publicationAction("config-update", "/workspace/store/config.json", "{}\n")],
  },
  "secret-metadata": {
    normalizedInputs: { mutationKind: "keychain-secret-set" },
    actions: [
      {
        actionId: "keychain-set",
        kind: "keychain-secret-set",
        target: "/workspace/store/keychain.json",
        payload: { provider: "keychain", service: "cellarer", name: "fixture" },
        postcondition: { state: "present", fingerprint: sha256("fixture") },
      },
    ],
  },
  "store-import": {
    normalizedInputs: {
      mutationKind: "inventory-secret-adoption",
      candidateId: `inventory-candidate:v1:mcp:${"a".repeat(64)}`,
      candidateName: "fixture",
      provider: { kind: "vault" },
      providerPrecondition: { state: "absent" },
      refreshScope: { agentId: null, projectRoot: null },
      selector: { kind: "environment", server: "fixture", name: "TOKEN" },
      targetName: "fixture-token",
    },
    actions: [
      {
        actionId: "adoption-content",
        kind: "inventory-resource-content",
        target: "/workspace/store/store/mcp/fixture.json",
        payload: {
          candidateId: `inventory-candidate:v1:mcp:${"a".repeat(64)}`,
          resourceId: "mcp/fixture",
        },
      },
      {
        actionId: "adoption-metadata",
        kind: "inventory-resource-metadata",
        target: "/workspace/store/store/metadata/mcp/fixture.json",
        payload: {
          candidateId: `inventory-candidate:v1:mcp:${"a".repeat(64)}`,
          resourceId: "mcp/fixture",
        },
      },
    ],
  },
  "resource-lifecycle": {
    normalizedInputs: {
      mutationKind: "resource-export",
      businessInput: {
        operation: "export",
        resourceId: "rules/fixture",
        bundlePath: "/workspace/resource.cellarer.json",
      },
      capabilitySnapshot: {},
      currentRevisionId: sha256("revision"),
      blocked: [],
      storeProvenance: [],
      bundleDigest: sha256("bundle"),
    },
    actions: [
      {
        actionId: "resource-export",
        kind: "write-resource-bundle",
        target: "/workspace/resource.cellarer.json",
        payload: {},
      },
    ],
  },
  "sync-uninstall": {
    normalizedInputs: {
      mutationKind: "sync-target-uninstall",
      businessInput: { targetKeys: ["owner-key"] },
      capabilitySnapshot: [],
      targets: [{ key: "owner-key", target: "/workspace/sync-target", blocked: false }],
    },
    actions: [
      {
        actionId: "sync-uninstall",
        kind: "remove-target",
        target: "/workspace/sync-target",
        payload: {},
      },
    ],
  },
};

const env = {
  cwd: () => "/workspace",
  mutationAuthority: deterministicMutationAuthority(),
} as Env;

describe("mutation operation characterization", () => {
  it.each(
    mutationOperationAdapters,
  )("freezes canonical, action, authority, receipt, and recovery metadata for $operation", (adapter) => {
    const fixture = fixtures[adapter.operation];
    const actions = fixture.actions;
    const input: MutationPlanInput = {
      schemaVersion: 1,
      planId: `plan-${adapter.operation}`,
      operation: adapter.operation,
      baseRevision: 7,
      normalizedInputs: fixture.normalizedInputs,
      targetPreconditions: actions.map(({ actionId, target }) => ({
        actionId,
        target,
        expected: { state: "absent" },
      })),
      actions,
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
      orderedEffects: actions.map(({ actionId, kind, target }) => ({ actionId, kind, target })),
      receiptProjection: "kernel-operation-receipt-v1",
      recovery: adapter.recovery,
    });
  });

  it("rejects embedded apply, revert, and uninstall order mismatches", () => {
    const applyFixture = fixtures.apply;
    const applyPlan = authorizedFixture("apply", {
      ...applyFixture,
      normalizedInputs: {
        ...applyFixture.normalizedInputs,
        distributePlan: { actions: [], warnings: [], conflicts: [] },
      },
    });
    expect(
      resolveAuthorizedMutationOperationAdapter(env, "/workspace/store", applyPlan),
    ).toBeNull();

    const revertFixture = fixtures.revert;
    const revertPlan = authorizedFixture("revert", {
      ...revertFixture,
      normalizedInputs: {
        ...revertFixture.normalizedInputs,
        revertPlan: { targets: [], warnings: [], conflicts: [] },
      },
    });
    expect(
      resolveAuthorizedMutationOperationAdapter(env, "/workspace/store", revertPlan),
    ).toBeNull();

    const uninstallFixture = fixtures["sync-uninstall"];
    const uninstallPlan = authorizedFixture("sync-uninstall", {
      ...uninstallFixture,
      normalizedInputs: {
        ...uninstallFixture.normalizedInputs,
        targets: [{ key: "owner-key", target: "/workspace/different-target", blocked: false }],
      },
    });
    expect(
      resolveAuthorizedMutationOperationAdapter(env, "/workspace/store", uninstallPlan),
    ).toBeNull();
  });

  it("rejects characterization when action preconditions are reordered", () => {
    const fixture = fixtures.initialize;
    const plan = authorizedFixture("initialize", fixture);
    const adapter = resolveAuthorizedMutationOperationAdapter(env, "/workspace/store", plan);
    if (!adapter) throw new TypeError("initialize adapter fixture is invalid");
    const reordered = { ...plan, targetPreconditions: [...plan.targetPreconditions].reverse() };
    expect(() => characterizeMutationOperationPlan(adapter, reordered)).toThrow(/one-to-one/i);
  });
});

function authorizedFixture(
  operation: MutationOperation,
  fixture: {
    readonly normalizedInputs: MutationPlanInput["normalizedInputs"];
    readonly actions: MutationPlanInput["actions"];
  },
) {
  return createAuthorizedMutationPlan(env, "/workspace/store", {
    schemaVersion: 1,
    planId: `attack-${operation}`,
    operation,
    baseRevision: 7,
    normalizedInputs: fixture.normalizedInputs,
    targetPreconditions: fixture.actions.map(({ actionId, target }) => ({
      actionId,
      target,
      expected: { state: "absent" },
    })),
    actions: fixture.actions,
    expires: { policy: "none" },
  });
}

function publicationAction(mutationKind: string, target: string, data: string) {
  const digest = sha256(data);
  const mode = 0o600;
  return {
    actionId: sha256(
      JSON.stringify({
        mutationKind,
        index: 0,
        kind: "publish-file",
        path: target,
        digest,
        mode,
        currentUserOnly: false,
      }),
    ),
    kind: "publish-file",
    target,
    payload: { data, digest, mode, path: target },
    postcondition: { state: "present" as const, fingerprint: digest },
  };
}
