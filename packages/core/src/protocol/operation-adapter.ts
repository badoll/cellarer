import type { Env } from "../env.js";
import {
  assertStrictMutationPlanRuntime,
  canonicalMutationPlan,
  verifyMutationPlanAuthorization,
  verifyMutationPlanDigest,
} from "./canonical.js";
import type {
  CanonicalJsonObject,
  CanonicalJsonValue,
  MutationOperation,
  MutationPlan,
  OperationResult,
} from "./models.js";
import { type MutationPlanContract, mutationPlanContractFor } from "./operation-contracts.js";

type StoreMutationIntent = CanonicalJsonObject & { readonly mutationKind: string };

export interface MutationOperationIntentByOperation {
  readonly initialize: StoreMutationIntent;
  readonly apply: CanonicalJsonObject;
  readonly revert: CanonicalJsonObject;
  readonly settings: StoreMutationIntent;
  readonly "secret-metadata": StoreMutationIntent;
  readonly "store-import": StoreMutationIntent;
  readonly "resource-lifecycle": CanonicalJsonObject;
  readonly "sync-uninstall": CanonicalJsonObject;
}

export interface MutationOperationRecoveryDescriptor {
  readonly strategy: "kernel-journal-evidence";
  readonly allowedActionKinds: readonly string[];
  readonly externalEffects: "manual-only";
}

export interface MutationOperationAdapter<
  Operation extends MutationOperation = MutationOperation,
  Intent extends CanonicalJsonObject = MutationOperationIntentByOperation[Operation],
  Receipt extends OperationResult = OperationResult,
> {
  readonly operation: Operation;
  readonly recovery: MutationOperationRecoveryDescriptor;
  readonly selectContract: (plan: MutationPlan) => MutationPlanContract | null;
  readonly normalizeIntent: (plan: MutationPlan) => Intent;
  readonly bindProvenance: (plan: MutationPlan) => CanonicalJsonValue | null;
  readonly validateActionSet: (plan: MutationPlan) => boolean;
  readonly prepareEffects: <Prepared>(plan: MutationPlan, prepare: () => Prepared) => Prepared;
  readonly projectReceipt: (plan: MutationPlan, result: OperationResult) => Receipt;
}

export type AnyMutationOperationAdapter = {
  readonly [Operation in MutationOperation]: MutationOperationAdapter<Operation>;
}[MutationOperation];

export interface MutationOperationRegistry {
  readonly get: (operation: string) => AnyMutationOperationAdapter | null;
  readonly values: () => readonly AnyMutationOperationAdapter[];
}

const recoveryActionKinds = {
  initialize: ["mkdir", "preserve-file", "publish-file"],
  apply: ["copy", "merge", "overwrite", "sync-gitignore", "symlink", "write"],
  revert: ["detach-consumer", "remove-target", "restore-snapshot", "sync-gitignore"],
  settings: ["publish-file"],
  "secret-metadata": ["keychain-secret-delete", "keychain-secret-set", "publish-file"],
  "store-import": [
    "add-mcp",
    "add-rules",
    "add-skill-provenance",
    "add-skills",
    "install-resource-revision",
    "inventory-collection-membership",
    "inventory-resource-content",
    "inventory-resource-metadata",
    "publish-file",
    "publish-resource-metadata",
    "scan-mcp",
    "scan-rules",
    "scan-skills",
  ],
  "resource-lifecycle": [
    "install-resource-content",
    "preserve-file",
    "publish-file",
    "publish-resource-metadata",
    "remove-resource-path",
    "rename-resource-content",
    "write-resource-bundle",
  ],
  "sync-uninstall": ["detach-consumer", "remove-target", "sync-gitignore"],
} as const satisfies Readonly<Record<MutationOperation, readonly string[]>>;

function defineAdapter<Operation extends MutationOperation>(
  operation: Operation,
): MutationOperationAdapter<Operation> {
  const allowedActionKinds = recoveryActionKinds[operation];
  return Object.freeze({
    operation,
    recovery: Object.freeze({
      strategy: "kernel-journal-evidence" as const,
      allowedActionKinds,
      externalEffects: "manual-only" as const,
    }),
    normalizeIntent: (plan: MutationPlan) =>
      requireContract(operation, plan).normalizeIntent(
        plan,
      ) as MutationOperationIntentByOperation[Operation],
    bindProvenance: (plan: MutationPlan) => requireContract(operation, plan).bindProvenance(plan),
    selectContract: (plan: MutationPlan) => {
      const contract = mutationPlanContractFor(plan);
      return contract?.operation === operation ? contract : null;
    },
    validateActionSet: (plan: MutationPlan) => {
      const contract = mutationPlanContractFor(plan);
      return contract?.operation === operation && contract.validateActionSet(plan);
    },
    prepareEffects: <Prepared>(plan: MutationPlan, prepare: () => Prepared): Prepared =>
      requireContract(operation, plan).prepareEffects(prepare),
    projectReceipt: (plan: MutationPlan, result: OperationResult) =>
      requireContract(operation, plan).projectReceipt(result),
  });
}

function requireContract(operation: MutationOperation, plan: MutationPlan): MutationPlanContract {
  const contract = mutationPlanContractFor(plan);
  if (!contract || contract.operation !== operation) {
    throw new TypeError(`${operation} mutation plan has no registered contract`);
  }
  return contract;
}

const adaptersByOperation = {
  initialize: defineAdapter("initialize"),
  apply: defineAdapter("apply"),
  revert: defineAdapter("revert"),
  settings: defineAdapter("settings"),
  "secret-metadata": defineAdapter("secret-metadata"),
  "store-import": defineAdapter("store-import"),
  "resource-lifecycle": defineAdapter("resource-lifecycle"),
  "sync-uninstall": defineAdapter("sync-uninstall"),
} as const satisfies {
  readonly [Operation in MutationOperation]: MutationOperationAdapter<Operation>;
};

export const mutationOperationAdapters = Object.freeze([
  adaptersByOperation.initialize,
  adaptersByOperation.apply,
  adaptersByOperation.revert,
  adaptersByOperation.settings,
  adaptersByOperation["secret-metadata"],
  adaptersByOperation["store-import"],
  adaptersByOperation["resource-lifecycle"],
  adaptersByOperation["sync-uninstall"],
] satisfies readonly AnyMutationOperationAdapter[]);

export function createMutationOperationRegistry(
  adapters: readonly AnyMutationOperationAdapter[],
): MutationOperationRegistry {
  const registered = new Map<string, AnyMutationOperationAdapter>();
  for (const adapter of adapters) {
    if (registered.has(adapter.operation)) {
      throw new TypeError(`duplicate mutation operation adapter: ${adapter.operation}`);
    }
    registered.set(adapter.operation, adapter);
  }
  const missing = Object.keys(recoveryActionKinds).filter(
    (operation) => !registered.has(operation),
  );
  if (missing.length > 0) {
    throw new TypeError(`incomplete mutation operation adapter registry: ${missing.join(", ")}`);
  }
  return Object.freeze({
    get: (operation: string) => registered.get(operation) ?? null,
    values: () => Object.freeze([...registered.values()]),
  });
}

const registry = createMutationOperationRegistry(mutationOperationAdapters);

export function mutationOperationAdapterFor<Operation extends MutationOperation>(
  operation: Operation,
): MutationOperationAdapter<Operation> {
  const adapter = registry.get(operation);
  if (!adapter) throw new TypeError(`unknown mutation operation adapter: ${operation}`);
  return adapter as MutationOperationAdapter<Operation>;
}

export function resolveAuthorizedMutationOperationAdapter(
  env: Env,
  storeRoot: string,
  plan: unknown,
  expectedOperation?: MutationOperation,
): AnyMutationOperationAdapter | null {
  try {
    assertStrictMutationPlanRuntime(plan);
  } catch {
    return null;
  }
  if (!verifyMutationPlanAuthorization(env, storeRoot, plan)) return null;
  return resolveMutationOperationAdapter(plan, expectedOperation);
}

export function resolveMutationOperationAdapter(
  plan: unknown,
  expectedOperation?: MutationOperation,
): AnyMutationOperationAdapter | null {
  try {
    assertStrictMutationPlanRuntime(plan, expectedOperation);
  } catch {
    return null;
  }
  if (!verifyMutationPlanDigest(plan)) return null;
  return resolveMutationOperationAdapterAfterIntegrity(plan, expectedOperation);
}

export function resolveMutationOperationAdapterAfterIntegrity(
  plan: MutationPlan,
  expectedOperation?: MutationOperation,
): AnyMutationOperationAdapter | null {
  if (expectedOperation !== undefined && plan.operation !== expectedOperation) return null;
  const adapter = registry.get(plan.operation);
  if (!adapter) return null;
  try {
    assertMutationPlanActionAlignment(plan);
    adapter.normalizeIntent(plan);
    if (!adapter.validateActionSet(plan)) return null;
  } catch {
    return null;
  }
  return adapter;
}

export function assertMutationPlanActionAlignment(plan: MutationPlan): void {
  const actionIds = new Set(plan.actions.map((action) => action.actionId));
  const preconditionsByAction = new Map(
    plan.targetPreconditions.map((precondition) => [precondition.actionId, precondition]),
  );
  if (
    actionIds.size !== plan.actions.length ||
    preconditionsByAction.size !== plan.targetPreconditions.length ||
    plan.actions.length !== plan.targetPreconditions.length ||
    plan.actions.some((action, index) => {
      const ordered = plan.targetPreconditions[index];
      return (
        ordered?.actionId !== action.actionId ||
        ordered.target !== action.target ||
        preconditionsByAction.get(action.actionId)?.target !== action.target
      );
    })
  ) {
    throw new TypeError("mutation plan actions and target preconditions are not one-to-one");
  }
}

export function characterizeMutationOperationPlan(
  adapter: AnyMutationOperationAdapter,
  plan: MutationPlan,
): {
  readonly canonicalPlan: string;
  readonly authorityScope: {
    readonly authorityId: string;
    readonly authorityEpoch: number;
    readonly domain: string;
  };
  readonly orderedEffects: readonly {
    readonly actionId: string;
    readonly kind: string;
    readonly target: string;
  }[];
  readonly receiptProjection: "kernel-operation-receipt-v1";
  readonly recovery: MutationOperationRecoveryDescriptor;
} {
  assertMutationPlanActionAlignment(plan);
  const contract = adapter.selectContract(plan);
  if (adapter.operation !== plan.operation || !contract || !contract.validateActionSet(plan)) {
    throw new TypeError("mutation plan does not match its operation adapter");
  }
  return Object.freeze({
    canonicalPlan: canonicalMutationPlan(plan),
    authorityScope: Object.freeze({
      authorityId: plan.authorization.authorityId,
      authorityEpoch: plan.authorization.authorityEpoch,
      domain: plan.authorization.domain,
    }),
    orderedEffects: Object.freeze(
      plan.actions.map(({ actionId, kind, target }) => Object.freeze({ actionId, kind, target })),
    ),
    receiptProjection: "kernel-operation-receipt-v1",
    recovery: adapter.recovery,
  });
}
