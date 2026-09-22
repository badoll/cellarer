import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { createAuthorizedMutationPlan } from "../src/protocol/canonical.js";
import type { MutationOperation, MutationPlanInput } from "../src/protocol/models.js";
import {
  assertMutationPlanActionAlignment,
  createMutationOperationRegistry,
  type MutationOperationAdapter,
  mutationOperationAdapterFor,
  mutationOperationAdapters,
  resolveAuthorizedMutationOperationAdapter,
} from "../src/protocol/operation-adapter.js";
import {
  createMutationPlanContractRegistry,
  mutationPlanContracts,
} from "../src/protocol/operation-contracts.js";
import { executePreparedMutationOperation } from "../src/protocol/operation-execution.js";
import { sha256 } from "../src/store/checksum.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

const storeRoot = "/workspace/store";

function authorityEnv(): Env {
  return {
    cwd: () => "/workspace",
    mutationAuthority: deterministicMutationAuthority(),
  } as Env;
}

function input(
  operation: MutationOperation,
  kind: string,
  normalizedInputs: MutationPlanInput["normalizedInputs"] = { mutationKind: "fixture" },
): MutationPlanInput {
  return {
    schemaVersion: 1,
    planId: `plan-${operation}`,
    operation,
    baseRevision: 0,
    normalizedInputs,
    targetPreconditions: [
      { actionId: "action-1", target: "/workspace/target", expected: { state: "absent" } },
    ],
    actions: [
      {
        actionId: "action-1",
        kind,
        target: "/workspace/target",
        payload: {},
      },
    ],
    expires: { policy: "none" },
  };
}

function inputWithActionKinds(
  operation: MutationOperation,
  normalizedInputs: MutationPlanInput["normalizedInputs"],
  kinds: readonly string[],
): MutationPlanInput {
  const actions = kinds.map((kind, index) => ({
    actionId: `action-${index + 1}`,
    kind,
    target: `/workspace/target-${index + 1}`,
    payload: {},
  }));
  return {
    schemaVersion: 1,
    planId: `plan-${operation}`,
    operation,
    baseRevision: 0,
    normalizedInputs,
    targetPreconditions: actions.map(({ actionId, target }) => ({
      actionId,
      target,
      expected: { state: "absent" as const },
    })),
    actions,
    expires: { policy: "none" },
  };
}

describe("mutation operation adapters", () => {
  it("registers one adapter for each executable operation", () => {
    expect(mutationOperationAdapters.map(({ operation }) => operation)).toEqual([
      "initialize",
      "apply",
      "sync-reconcile",
      "revert",
      "settings",
      "secret-metadata",
      "store-import",
      "resource-lifecycle",
      "sync-uninstall",
    ]);
    for (const adapter of mutationOperationAdapters) {
      expect(mutationOperationAdapterFor(adapter.operation)).toBe(adapter);
    }
  });

  it("fails closed for duplicate registrations", () => {
    const duplicate = mutationOperationAdapters[0] as MutationOperationAdapter;
    expect(() => createMutationOperationRegistry([duplicate, duplicate])).toThrow(
      /duplicate mutation operation adapter/i,
    );
  });

  it("fails closed for missing registrations", () => {
    expect(() => createMutationOperationRegistry([])).toThrow(
      /incomplete mutation operation adapter registry/i,
    );
  });

  it("fails closed for duplicate and incomplete mutation contract registries", () => {
    const duplicate = mutationPlanContracts[0];
    if (!duplicate) throw new TypeError("mutation contract fixture is missing");
    expect(() => createMutationPlanContractRegistry([duplicate, duplicate])).toThrow(
      /duplicate mutation plan contract/i,
    );
    expect(() => createMutationPlanContractRegistry([])).toThrow(
      /incomplete mutation plan contract registry/i,
    );
    expect(() => createMutationPlanContractRegistry(mutationPlanContracts.slice(1))).toThrow(
      /incomplete mutation plan contract registry/i,
    );
    expect(() =>
      createMutationPlanContractRegistry([
        ...mutationPlanContracts,
        { ...duplicate, mutationKind: "unexpected-contract", id: "initialize:unexpected-contract" },
      ]),
    ).toThrow(/unknown mutation plan contract/i);
  });

  it("rejects unknown and cross-operation actions after authorization", () => {
    const env = authorityEnv();
    const crossOperation = createAuthorizedMutationPlan(env, storeRoot, input("settings", "write"));
    expect(resolveAuthorizedMutationOperationAdapter(env, storeRoot, crossOperation)).toBeNull();

    const unknown = createAuthorizedMutationPlan(env, storeRoot, {
      ...input("settings", "publish-file"),
      operation: "unknown-operation" as MutationOperation,
    });
    expect(resolveAuthorizedMutationOperationAdapter(env, storeRoot, unknown)).toBeNull();
  });

  it("rejects unknown mutation contracts and recovery-only executable actions", () => {
    const env = authorityEnv();
    const unknownContract = createAuthorizedMutationPlan(
      env,
      storeRoot,
      input("settings", "publish-file", { mutationKind: "unknown-settings-contract" }),
    );
    expect(resolveAuthorizedMutationOperationAdapter(env, storeRoot, unknownContract)).toBeNull();

    const recoveryOnly = createAuthorizedMutationPlan(
      env,
      storeRoot,
      input("store-import", "scan-rules", { mutationKind: "inventory-store-import" }),
    );
    expect(resolveAuthorizedMutationOperationAdapter(env, storeRoot, recoveryOnly)).toBeNull();
    expect(mutationOperationAdapterFor("store-import").recovery.allowedActionKinds).toEqual(
      expect.arrayContaining(["scan-mcp", "scan-rules", "scan-skills"]),
    );
  });

  it("rejects missing, extra, duplicated, and reordered actions for an exact contract", () => {
    const env = authorityEnv();
    const expected = ["publish-file", "mkdir", "mkdir", "mkdir", "mkdir"] as const;
    const variants = [
      expected.slice(0, -1),
      [...expected, "mkdir"],
      ["publish-file", "mkdir", "mkdir", "mkdir", "publish-file"],
      ["mkdir", "publish-file", "mkdir", "mkdir", "mkdir"],
    ];

    for (const kinds of variants) {
      const plan = createAuthorizedMutationPlan(
        env,
        storeRoot,
        inputWithActionKinds("initialize", { mutationKind: "initialize-store" }, kinds),
      );
      expect(resolveAuthorizedMutationOperationAdapter(env, storeRoot, plan)).toBeNull();
    }
  });

  it("rejects reordered target preconditions even when the set still matches", () => {
    const env = authorityEnv();
    const plan = createAuthorizedMutationPlan(
      env,
      storeRoot,
      inputWithActionKinds("store-import", { mutationKind: "add" }, ["add-rules", "add-mcp"]),
    );
    const reordered = {
      ...plan,
      targetPreconditions: [...plan.targetPreconditions].reverse(),
    };
    expect(() => assertMutationPlanActionAlignment(reordered)).toThrow(/one-to-one/i);
  });

  it("rejects an action owned by another contract under the same operation", () => {
    const env = authorityEnv();
    const plan = createAuthorizedMutationPlan(
      env,
      storeRoot,
      input("secret-metadata", "keychain-secret-set", { mutationKind: "vault-update" }),
    );
    expect(resolveAuthorizedMutationOperationAdapter(env, storeRoot, plan)).toBeNull();
  });

  it("binds closed Store intent and dynamic actions to the selected contract", () => {
    const env = authorityEnv();
    const target = "/workspace/store/config.json";
    const data = "{}\n";
    const digest = sha256(data);
    const mutationKind = "config-update";
    const settingsInput = inputWithActionKinds(
      "settings",
      {
        mutationKind,
        businessInput: { kind: "settings", action: "update", settings: { method: "copy" } },
        changedFields: ["defaults.method"],
        storeProvenance: [{ path: target, expected: { state: "absent" } }],
      },
      ["publish-file"],
    );
    settingsInput.actions[0] = {
      actionId: sha256(
        JSON.stringify({
          mutationKind,
          index: 0,
          kind: "publish-file",
          path: target,
          digest,
          mode: 0o600,
          currentUserOnly: false,
        }),
      ),
      kind: "publish-file",
      target,
      payload: { data, digest, mode: 0o600, path: target },
      postcondition: { state: "present", fingerprint: digest },
    };
    settingsInput.targetPreconditions[0] = {
      actionId: settingsInput.actions[0].actionId,
      target,
      expected: { state: "absent" },
    };
    const validSettings = createAuthorizedMutationPlan(env, storeRoot, settingsInput);
    expect(
      resolveAuthorizedMutationOperationAdapter(env, storeRoot, validSettings)?.operation,
    ).toBe("settings");
    const extraIntent = createAuthorizedMutationPlan(env, storeRoot, {
      ...settingsInput,
      normalizedInputs: { ...settingsInput.normalizedInputs, unexpected: true },
    });
    expect(resolveAuthorizedMutationOperationAdapter(env, storeRoot, extraIntent)).toBeNull();

    const crossContractIntent = createAuthorizedMutationPlan(env, storeRoot, {
      ...settingsInput,
      normalizedInputs: {
        ...settingsInput.normalizedInputs,
        businessInput: { kind: "settings", action: "reset", fields: ["method"] },
      },
    });
    expect(
      resolveAuthorizedMutationOperationAdapter(env, storeRoot, crossContractIntent),
    ).toBeNull();

    const candidateId = `inventory-candidate:v1:rules:${"a".repeat(64)}`;
    const inventoryInput = inputWithActionKinds(
      "store-import",
      {
        mutationKind: "inventory-store-import",
        candidateIds: [candidateId],
        intoCollection: null,
        refreshScope: { agentId: null, projectRoot: null },
      },
      ["inventory-resource-content", "inventory-resource-metadata"],
    );
    inventoryInput.actions[0] = {
      ...inventoryInput.actions[0],
      payload: { candidateId, resourceId: "rules/fixture" },
    };
    inventoryInput.actions[1] = {
      ...inventoryInput.actions[1],
      payload: { candidateId: `${candidateId}-other`, resourceId: "rules/fixture" },
    };
    const mismatchedInventory = createAuthorizedMutationPlan(env, storeRoot, inventoryInput);
    expect(
      resolveAuthorizedMutationOperationAdapter(env, storeRoot, mismatchedInventory),
    ).toBeNull();
  });

  it("rejects an invalid contract before operation identity allocation or effects", async () => {
    const signingEnv = authorityEnv();
    let productInteractions = 0;
    let effects = 0;
    const env = new Proxy(signingEnv, {
      get(target, property, receiver) {
        if (property === "mutationAuthority" || property === "cwd") {
          return Reflect.get(target, property, receiver);
        }
        productInteractions += 1;
        throw new Error(`unexpected product interaction: ${String(property)}`);
      },
    }) as Env;
    const plan = createAuthorizedMutationPlan(
      signingEnv,
      storeRoot,
      input("settings", "publish-file", { mutationKind: "unknown-settings-contract" }),
    );

    const result = await executePreparedMutationOperation(env, storeRoot, plan, async () => {
      effects += 1;
      return { actionReceipts: [] };
    });

    expect(result).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    expect({ productInteractions, effects }).toEqual({ productInteractions: 0, effects: 0 });
  });

  it("accepts an empty resource plan only when its contract is explicitly blocked", () => {
    const env = authorityEnv();
    const normalizedInputs = {
      mutationKind: "resource-rename",
      businessInput: {
        operation: "rename",
        resourceId: "rules/fixture",
        newName: "renamed",
        mode: "rename",
      },
      capabilitySnapshot: {},
      currentRevisionId: sha256("revision"),
      dependencyReport: {},
      blocked: ["RESOURCE_COLLISION"],
      storeProvenance: [],
    };
    const blocked = createAuthorizedMutationPlan(env, storeRoot, {
      ...inputWithActionKinds("resource-lifecycle", normalizedInputs, []),
      targetPreconditions: [],
      actions: [],
    });
    expect(resolveAuthorizedMutationOperationAdapter(env, storeRoot, blocked)?.operation).toBe(
      "resource-lifecycle",
    );

    const unblocked = createAuthorizedMutationPlan(env, storeRoot, {
      ...inputWithActionKinds("resource-lifecycle", { ...normalizedInputs, blocked: [] }, []),
      targetPreconditions: [],
      actions: [],
    });
    expect(resolveAuthorizedMutationOperationAdapter(env, storeRoot, unblocked)).toBeNull();

    const blockedLocalFork = createAuthorizedMutationPlan(env, storeRoot, {
      ...inputWithActionKinds(
        "resource-lifecycle",
        {
          ...normalizedInputs,
          mutationKind: "resource-local-fork",
          businessInput: {
            operation: "rename",
            resourceId: "rules/fixture",
            newName: "forked",
            mode: "local-fork",
          },
        },
        [],
      ),
      targetPreconditions: [],
      actions: [],
    });
    expect(
      resolveAuthorizedMutationOperationAdapter(env, storeRoot, blockedLocalFork)?.operation,
    ).toBe("resource-lifecycle");
  });

  it("does not infer mutation policy from human reason or message wording", () => {
    const env = authorityEnv();
    const first = createAuthorizedMutationPlan(
      env,
      storeRoot,
      input("settings", "publish-file", {
        mutationKind: "config-update",
        reason: "first wording",
        message: "first message",
      }),
    );
    const second = createAuthorizedMutationPlan(
      env,
      storeRoot,
      input("settings", "publish-file", {
        mutationKind: "config-update",
        reason: "different wording",
        message: "different message",
      }),
    );
    const adapter = mutationOperationAdapterFor("settings");
    expect(adapter.selectContract(first)?.id).toBe("settings:config-update");
    expect(adapter.selectContract(second)?.id).toBe("settings:config-update");
  });
});
