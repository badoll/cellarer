import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { createAuthorizedMutationPlan } from "../src/protocol/canonical.js";
import type { MutationOperation, MutationPlanInput } from "../src/protocol/models.js";
import {
  createMutationOperationRegistry,
  type MutationOperationAdapter,
  mutationOperationAdapterFor,
  mutationOperationAdapters,
  resolveAuthorizedMutationOperationAdapter,
} from "../src/protocol/operation-adapter.js";
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

describe("mutation operation adapters", () => {
  it("registers one adapter for each executable operation", () => {
    expect(mutationOperationAdapters.map(({ operation }) => operation)).toEqual([
      "initialize",
      "apply",
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

  it("does not infer mutation policy from human reason or message wording", () => {
    const env = authorityEnv();
    const first = createAuthorizedMutationPlan(
      env,
      storeRoot,
      input("settings", "publish-file", {
        mutationKind: "fixture",
        reason: "first wording",
        message: "first message",
      }),
    );
    const second = createAuthorizedMutationPlan(
      env,
      storeRoot,
      input("settings", "publish-file", {
        mutationKind: "fixture",
        reason: "different wording",
        message: "different message",
      }),
    );
    expect(resolveAuthorizedMutationOperationAdapter(env, storeRoot, first)?.operation).toBe(
      "settings",
    );
    expect(resolveAuthorizedMutationOperationAdapter(env, storeRoot, second)?.operation).toBe(
      "settings",
    );
  });
});
