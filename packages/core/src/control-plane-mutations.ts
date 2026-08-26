import { join } from "node:path";
import { z } from "zod";
import {
  planConfigMutation,
  validateConfigFinalPublicationBytes,
  validateConfigPublication,
} from "./config-mutation.js";
import { ControlPlaneValidationError } from "./control-plane-validation.js";
import type { Env } from "./env.js";
import { refreshInventory } from "./inventory/projector.js";
import { canonicalJson } from "./protocol/canonical.js";
import type {
  InventoryCompleteness,
  InventoryRefreshResult,
  PostCommitInventoryRefresh,
} from "./protocol/client-types.js";
import { invalidPlanResult } from "./protocol/execute.js";
import type {
  CanonicalJsonObject,
  MutationPlan,
  OperationReceipt,
  OperationResult,
} from "./protocol/models.js";
import { type MutationPresentation, mutationPresentation } from "./protocol/presentation.js";
import {
  applyStorePublicationPlan,
  StoreMutationConflictError,
  type StorePublicationInput,
} from "./protocol/store-mutation.js";
import { registerObservablePublicControlPlanePlan } from "./secrets/observable.js";
import { activeSecretPublicationGuard } from "./secrets/publication-guard.js";
import {
  type AdapterBodyConfig,
  type AdapterOverrideConfig,
  type AdapterPatchConfig,
  type CellarerConfig,
  CONFIG_FILENAME,
  initialConfigText,
  loadConfig,
  packagedConfigText,
  parseAgentId,
  parseConfig,
  parsePackagedConfigForSettings,
  parseSnapshottedAdapterBodyConfig,
  parseSnapshottedAdapterPatchConfig,
  snapshotConfigRuntimeValue,
} from "./store/config.js";
import { loadLedger } from "./store/ledger.js";
import { listMcpArtifacts, listRuleArtifacts, listSkillArtifacts } from "./store/store.js";

export interface PlannedControlPlaneMutationDto {
  readonly plan: MutationPlan;
  readonly changedFields: readonly string[];
  readonly receipt?: OperationReceipt & { readonly changedFields: readonly string[] };
  readonly postCommitInventoryRefresh?: PostCommitInventoryRefresh;
}

export interface AppliedControlPlaneMutationPlanDto {
  readonly plan: MutationPlan;
  readonly changedFields: readonly string[];
  readonly operation: Awaited<ReturnType<typeof applyStorePublicationPlan>>["operation"];
  readonly mutation: MutationPresentation;
  readonly receipt?: OperationReceipt & { readonly changedFields: readonly string[] };
  readonly postCommitInventoryRefresh?: PostCommitInventoryRefresh;
}

export interface ApplyControlPlaneMutationPlanOptions {
  readonly storeRoot: string;
}

const CONTROL_PLANE_MUTATION_KINDS = [
  "builtin-agent-enable",
  "builtin-agent-disable",
  "builtin-agent-configure",
  "builtin-agent-reset",
  "custom-adapter-add",
  "custom-adapter-update",
  "custom-adapter-remove",
  "custom-adapter-upsert",
  "config-update",
  "config-reset",
  "collection-create",
  "collection-update",
  "collection-delete",
  "collection-set-members",
  "collection-set-defaults",
] as const;

interface ControlPlaneMutationBase {
  readonly storeRoot: string;
  readonly dryRun?: boolean;
}

export type BuiltinAgentMutationOptions = ControlPlaneMutationBase &
  (
    | {
        readonly action: "enable" | "disable" | "reset";
        readonly agentId: string;
      }
    | {
        readonly action: "configure";
        readonly agentId: string;
        readonly adapter: AdapterPatchConfig;
      }
  );

export type CustomAdapterMutationOptions = ControlPlaneMutationBase &
  (
    | {
        readonly action: "add" | "update";
        readonly agentId: string;
        readonly adapter: AdapterBodyConfig;
      }
    | {
        readonly action: "remove";
        readonly agentId: string;
      }
  );

export type AgentAdapterMutationOptions = ControlPlaneMutationBase &
  (
    | {
        readonly kind: "builtin";
        readonly agentId: string;
        readonly adapter: AdapterPatchConfig;
      }
    | {
        readonly kind: "custom";
        readonly agentId: string;
        readonly adapter: AdapterBodyConfig;
      }
  );

export type AgentAdapterMutationBody =
  | {
      readonly kind: "builtin";
      readonly adapter: AdapterPatchConfig;
      readonly dryRun?: boolean;
    }
  | {
      readonly kind: "custom";
      readonly adapter: AdapterBodyConfig;
      readonly dryRun?: boolean;
    };

export interface AgentEnabledMutationBody {
  readonly enabled: boolean;
  readonly dryRun?: boolean;
}

export interface ControlPlaneSettingsMutationBody {
  readonly settings: ControlPlaneSettingsPatch;
  readonly dryRun?: boolean;
}

export interface CollectionCreateMutationBody {
  readonly collectionName: string;
  readonly description?: string;
  readonly resourceIds: readonly string[];
  readonly dryRun?: boolean;
}

export interface CollectionUpdateMutationBody {
  readonly description: string;
  readonly dryRun?: boolean;
}

export interface CollectionMembersMutationBody {
  readonly resourceIds: readonly string[];
  readonly dryRun?: boolean;
}

export interface CollectionDefaultsMutationBody {
  readonly collectionNames: readonly string[];
  readonly dryRun?: boolean;
}

const methodSchema = z.enum(["symlink", "copy"]);
const secretModeSchema = z.enum(["env", "vault", "keychain"]);
const osMethodSchema = z.object({ method: methodSchema.optional() }).strict();
const settingsPatchSchema = z
  .object({
    method: methodSchema.optional(),
    secretMode: secretModeSchema.optional(),
    os: z
      .object({
        win32: osMethodSchema.optional(),
        darwin: osMethodSchema.optional(),
        linux: osMethodSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((settings) => Object.keys(settings).length > 0, "settings update cannot be empty");
const settingFieldSchema = z.enum(["method", "secretMode", "os"]);

const mutationBaseFields = {
  storeRoot: z.string().min(1),
  dryRun: z.boolean().optional(),
};
const builtinAgentMutationInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...mutationBaseFields,
      action: z.enum(["enable", "disable", "reset"]),
      agentId: z.unknown(),
    })
    .strict(),
  z
    .object({
      ...mutationBaseFields,
      action: z.literal("configure"),
      agentId: z.unknown(),
      adapter: z.unknown(),
    })
    .strict(),
]);
const customAdapterMutationInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...mutationBaseFields,
      action: z.enum(["add", "update"]),
      agentId: z.unknown(),
      adapter: z.unknown(),
    })
    .strict(),
  z
    .object({
      ...mutationBaseFields,
      action: z.literal("remove"),
      agentId: z.unknown(),
    })
    .strict(),
]);
const agentAdapterMutationInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...mutationBaseFields,
      kind: z.literal("builtin"),
      agentId: z.unknown(),
      adapter: z.unknown(),
    })
    .strict(),
  z
    .object({
      ...mutationBaseFields,
      kind: z.literal("custom"),
      agentId: z.unknown(),
      adapter: z.unknown(),
    })
    .strict(),
]);
const agentAdapterMutationBodySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("builtin"),
      adapter: z.unknown(),
      dryRun: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom"),
      adapter: z.unknown(),
      dryRun: z.boolean().optional(),
    })
    .strict(),
]);
const agentEnabledMutationBodySchema = z
  .object({ enabled: z.boolean(), dryRun: z.boolean().optional() })
  .strict();
const settingsMutationBodySchema = z
  .object({ settings: settingsPatchSchema, dryRun: z.boolean().optional() })
  .strict();
const collectionCreateMutationBodySchema = z
  .object({
    collectionName: z.string(),
    description: z.string().optional(),
    resourceIds: z.array(z.string()),
    dryRun: z.boolean().optional(),
  })
  .strict();
const collectionUpdateMutationBodySchema = z
  .object({ description: z.string(), dryRun: z.boolean().optional() })
  .strict();
const collectionMembersMutationBodySchema = z
  .object({ resourceIds: z.array(z.string()), dryRun: z.boolean().optional() })
  .strict();
const collectionDefaultsMutationBodySchema = z
  .object({ collectionNames: z.array(z.string()), dryRun: z.boolean().optional() })
  .strict();
const settingsMutationInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...mutationBaseFields,
      action: z.literal("update"),
      settings: settingsPatchSchema,
    })
    .strict(),
  z
    .object({
      ...mutationBaseFields,
      action: z.literal("reset"),
      fields: z.array(settingFieldSchema).optional(),
    })
    .strict(),
]);
const collectionMutationInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...mutationBaseFields,
      action: z.literal("create"),
      collectionName: z.string(),
      description: z.string().optional(),
      resourceIds: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      ...mutationBaseFields,
      action: z.literal("update"),
      collectionName: z.string(),
      description: z.string(),
    })
    .strict(),
  z
    .object({
      ...mutationBaseFields,
      action: z.literal("delete"),
      collectionName: z.string(),
    })
    .strict(),
  z
    .object({
      ...mutationBaseFields,
      action: z.literal("set-members"),
      collectionName: z.string(),
      resourceIds: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      ...mutationBaseFields,
      action: z.literal("set-defaults"),
      collectionNames: z.array(z.string()),
    })
    .strict(),
]);
const applyControlPlaneMutationPlanOptionsSchema = z
  .object({ storeRoot: z.string().min(1) })
  .strict();
const builtinCapabilitySnapshotSchema = z
  .object({ builtinAdapterIds: z.array(z.unknown()) })
  .strict();
const packagedDefaultsSnapshotSchema = z
  .object({
    method: methodSchema,
    secretMode: secretModeSchema,
    os: z
      .object({
        win32: osMethodSchema.optional(),
        darwin: osMethodSchema.optional(),
        linux: osMethodSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const controlPlaneBusinessInputSchema = z.union([
  z
    .object({
      kind: z.literal("builtin"),
      action: z.enum(["enable", "disable", "reset"]),
      agentId: z.unknown(),
      capabilitySnapshot: builtinCapabilitySnapshotSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("builtin"),
      action: z.literal("configure"),
      agentId: z.unknown(),
      adapter: z.unknown(),
      capabilitySnapshot: builtinCapabilitySnapshotSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom"),
      action: z.enum(["add", "update", "upsert"]),
      agentId: z.unknown(),
      adapter: z.unknown(),
      capabilitySnapshot: builtinCapabilitySnapshotSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom"),
      action: z.literal("remove"),
      agentId: z.unknown(),
      capabilitySnapshot: builtinCapabilitySnapshotSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("settings"),
      action: z.literal("update"),
      settings: settingsPatchSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("settings"),
      action: z.literal("reset"),
      fields: z.array(settingFieldSchema),
      capabilitySnapshot: z.object({ packagedDefaults: packagedDefaultsSnapshotSchema }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("collection"),
      action: z.literal("create"),
      collectionName: z.string(),
      description: z.string().optional(),
      resourceIds: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("collection"),
      action: z.literal("update"),
      collectionName: z.string(),
      description: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("collection"),
      action: z.literal("delete"),
      collectionName: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("collection"),
      action: z.literal("set-members"),
      collectionName: z.string(),
      resourceIds: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      kind: z.literal("collection"),
      action: z.literal("set-defaults"),
      collectionNames: z.array(z.string()),
    })
    .strict(),
]);

export type ControlPlaneSettingsPatch = z.infer<typeof settingsPatchSchema>;
export type ControlPlaneSettingField = z.infer<typeof settingFieldSchema>;

export type ControlPlaneSettingsMutationOptions = ControlPlaneMutationBase &
  (
    | { readonly action: "update"; readonly settings: ControlPlaneSettingsPatch }
    | { readonly action: "reset"; readonly fields?: readonly ControlPlaneSettingField[] }
  );

export type CollectionMutationOptions = ControlPlaneMutationBase &
  (
    | {
        readonly action: "create";
        readonly collectionName: string;
        readonly description?: string;
        readonly resourceIds: readonly string[];
      }
    | {
        readonly action: "update";
        readonly collectionName: string;
        readonly description: string;
      }
    | {
        readonly action: "delete";
        readonly collectionName: string;
      }
    | {
        readonly action: "set-members";
        readonly collectionName: string;
        readonly resourceIds: readonly string[];
      }
    | {
        readonly action: "set-defaults";
        readonly collectionNames: readonly string[];
      }
  );

export interface ControlPlaneMutationDependencies {
  readonly ownedTargets: readonly string[];
  readonly desiredSelections: readonly string[];
}

type BuiltinCapabilitySnapshot = {
  readonly builtinAdapterIds: readonly string[];
};

type PackagedDefaultsSnapshot = Pick<CellarerConfig["defaults"], "method" | "secretMode"> &
  Pick<Partial<CellarerConfig["defaults"]>, "os">;

type ControlPlaneBusinessInput =
  | {
      readonly kind: "builtin";
      readonly action: "enable" | "disable" | "reset";
      readonly agentId: string;
      readonly capabilitySnapshot: BuiltinCapabilitySnapshot;
    }
  | {
      readonly kind: "builtin";
      readonly action: "configure";
      readonly agentId: string;
      readonly adapter: AdapterPatchConfig;
      readonly capabilitySnapshot: BuiltinCapabilitySnapshot;
    }
  | {
      readonly kind: "custom";
      readonly action: "add" | "update" | "upsert";
      readonly agentId: string;
      readonly adapter: AdapterBodyConfig;
      readonly capabilitySnapshot: BuiltinCapabilitySnapshot;
    }
  | {
      readonly kind: "custom";
      readonly action: "remove";
      readonly agentId: string;
      readonly capabilitySnapshot: BuiltinCapabilitySnapshot;
    }
  | {
      readonly kind: "settings";
      readonly action: "update";
      readonly settings: ControlPlaneSettingsPatch;
    }
  | {
      readonly kind: "settings";
      readonly action: "reset";
      readonly fields: readonly ControlPlaneSettingField[];
      readonly capabilitySnapshot: { readonly packagedDefaults: PackagedDefaultsSnapshot };
    }
  | {
      readonly kind: "collection";
      readonly action: "create";
      readonly collectionName: string;
      readonly description?: string;
      readonly resourceIds: readonly string[];
    }
  | {
      readonly kind: "collection";
      readonly action: "update";
      readonly collectionName: string;
      readonly description: string;
    }
  | {
      readonly kind: "collection";
      readonly action: "delete";
      readonly collectionName: string;
    }
  | {
      readonly kind: "collection";
      readonly action: "set-members";
      readonly collectionName: string;
      readonly resourceIds: readonly string[];
    }
  | {
      readonly kind: "collection";
      readonly action: "set-defaults";
      readonly collectionNames: readonly string[];
    };

export { ControlPlaneValidationError } from "./control-plane-validation.js";

export class ControlPlaneDependencyError extends ControlPlaneValidationError {
  override readonly code = "DEPENDENCY_CONFLICT" as const;

  constructor(
    readonly agentId: string,
    readonly dependencies: ControlPlaneMutationDependencies,
  ) {
    super(`custom adapter "${agentId}" has dependent targets or desired selections`, {
      agentId,
      dependencies,
    });
    this.name = "ControlPlaneDependencyError";
  }
}

export class ControlPlaneCollectionDependencyError extends ControlPlaneValidationError {
  override readonly code = "DEPENDENCY_CONFLICT" as const;

  constructor(
    readonly collectionName: string,
    readonly dependencies: { readonly desiredSelections: readonly string[] },
  ) {
    super(`collection "${collectionName}" is selected by desired defaults`, {
      collectionName,
      dependencies,
    });
    this.name = "ControlPlaneCollectionDependencyError";
  }
}

export async function mutateBuiltinAgent(
  env: Env,
  opts: BuiltinAgentMutationOptions,
): Promise<PlannedControlPlaneMutationDto> {
  const input = preflightBuiltinAgentMutation(opts);
  const capabilitySnapshot = await builtinCapabilitySnapshot(env);
  const businessInput: ControlPlaneBusinessInput =
    input.action === "configure"
      ? {
          kind: "builtin",
          action: input.action,
          agentId: input.agentId,
          adapter: input.adapter,
          capabilitySnapshot,
        }
      : {
          kind: "builtin",
          action: input.action,
          agentId: input.agentId,
          capabilitySnapshot,
        };
  return mutateConfig(env, input, businessInput);
}

export async function mutateCustomAdapter(
  env: Env,
  opts: CustomAdapterMutationOptions,
): Promise<PlannedControlPlaneMutationDto> {
  const input = preflightCustomAdapterMutation(opts);
  const capabilitySnapshot = await builtinCapabilitySnapshot(env);
  const businessInput: ControlPlaneBusinessInput =
    input.action === "remove"
      ? {
          kind: "custom",
          action: input.action,
          agentId: input.agentId,
          capabilitySnapshot,
        }
      : {
          kind: "custom",
          action: input.action,
          agentId: input.agentId,
          adapter: input.adapter,
          capabilitySnapshot,
        };
  return mutateConfig(env, input, businessInput);
}

export async function mutateAgentAdapter(
  env: Env,
  opts: AgentAdapterMutationOptions,
): Promise<PlannedControlPlaneMutationDto> {
  const input = preflightAgentAdapterMutation(opts);
  const capabilitySnapshot = await builtinCapabilitySnapshot(env);
  const businessInput: ControlPlaneBusinessInput =
    input.kind === "builtin"
      ? {
          kind: input.kind,
          action: "configure",
          agentId: input.agentId,
          adapter: input.adapter,
          capabilitySnapshot,
        }
      : {
          kind: input.kind,
          action: "upsert",
          agentId: input.agentId,
          adapter: input.adapter,
          capabilitySnapshot,
        };
  return mutateConfig(env, input, businessInput);
}

export async function mutateControlPlaneSettings(
  env: Env,
  opts: ControlPlaneSettingsMutationOptions,
): Promise<PlannedControlPlaneMutationDto> {
  const input = preflightSettingsMutation(opts);
  const businessInput: ControlPlaneBusinessInput =
    input.action === "update"
      ? { kind: "settings", action: input.action, settings: input.settings }
      : {
          kind: "settings",
          action: input.action,
          fields: normalizeResetFields(input.fields),
          capabilitySnapshot: { packagedDefaults: await packagedDefaultsSnapshot(env) },
        };
  return mutateConfig(env, input, businessInput);
}

export async function mutateCollection(
  env: Env,
  opts: CollectionMutationOptions,
): Promise<PlannedControlPlaneMutationDto> {
  const input = preflightCollectionMutation(opts);
  const businessInput: ControlPlaneBusinessInput =
    input.action === "set-defaults"
      ? { kind: "collection", action: input.action, collectionNames: input.collectionNames }
      : input.action === "create"
        ? {
            kind: "collection",
            action: input.action,
            collectionName: input.collectionName,
            ...(input.description === undefined ? {} : { description: input.description }),
            resourceIds: input.resourceIds,
          }
        : input.action === "set-members"
          ? {
              kind: "collection",
              action: input.action,
              collectionName: input.collectionName,
              resourceIds: input.resourceIds,
            }
          : input.action === "update"
            ? {
                kind: "collection",
                action: input.action,
                collectionName: input.collectionName,
                description: input.description,
              }
            : {
                kind: "collection",
                action: input.action,
                collectionName: input.collectionName,
              };
  return mutateConfig(env, input, businessInput);
}

export async function applyControlPlaneMutationPlan(
  env: Env,
  plan: MutationPlan,
  opts: ApplyControlPlaneMutationPlanOptions,
): Promise<AppliedControlPlaneMutationPlanDto> {
  const input = preflightMutationInput(
    opts,
    applyControlPlaneMutationPlanOptionsSchema,
    "control-plane apply options do not match the public schema",
    "INVALID_APPLY_OPTIONS",
  );
  const normalizedPlan = parseDomainInput(
    "serialized control-plane plan is not safe runtime data",
    { reason: "INVALID_SERIALIZED_PLAN" },
    () => snapshotConfigRuntimeValue(plan) as MutationPlan,
  );
  const businessInput = decodeControlPlaneBusinessInput(normalizedPlan);
  if (!businessInput) return invalidAppliedControlPlanePlan(normalizedPlan);
  registerObservablePublicControlPlanePlan(normalizedPlan);
  const requiredTarget = join(input.storeRoot, CONFIG_FILENAME);
  const requiredProvenancePathsByMutationKind = Object.fromEntries(
    CONTROL_PLANE_MUTATION_KINDS.map((mutationKind) => [
      mutationKind,
      controlPlaneProvenancePaths(input.storeRoot, mutationKind),
    ]),
  );
  const applied = await applyStorePublicationPlan(env, input.storeRoot, normalizedPlan, {
    secretPublicationGuard: activeSecretPublicationGuard,
    operation: "settings",
    allowedMutationKinds: CONTROL_PLANE_MUTATION_KINDS,
    requiredTarget,
    requiredProvenancePathsByMutationKind,
    requiredNormalizedInputKeys: ["businessInput"],
    validatePublicationData: validateConfigPublication,
    validateFinalPublicationBytes: validateConfigFinalPublicationBytes,
    validatePlanUnderLock: async (lockedPlan, publication) =>
      validateControlPlanePlanUnderLock(
        env,
        input.storeRoot,
        lockedPlan,
        publication,
        businessInput,
      ),
  });
  const postCommitInventoryRefresh = applied.operation.ok
    ? await refreshCommittedCustomAdapter(env, input.storeRoot, businessInput)
    : undefined;
  return {
    ...applied,
    mutation: mutationPresentation(normalizedPlan, applied.operation),
    ...(applied.operation.ok
      ? { receipt: { ...applied.operation.receipt, changedFields: applied.changedFields } }
      : {}),
    ...(postCommitInventoryRefresh ? { postCommitInventoryRefresh } : {}),
  };
}

async function mutateConfig(
  env: Env,
  opts: ControlPlaneMutationBase,
  businessInput: ControlPlaneBusinessInput,
): Promise<PlannedControlPlaneMutationDto> {
  const mutationKind = mutationKindForBusinessInput(businessInput);
  const changedFields = changedFieldsForBusinessInput(businessInput);
  const normalizedBusinessInput = snapshotBusinessInput(businessInput);
  const mutationOptions = {
    storeRoot: opts.storeRoot,
    mutationKind,
    changedFields,
    provenancePaths: controlPlaneProvenancePaths(opts.storeRoot, mutationKind),
    normalizedInputs: {
      businessInput: normalizedBusinessInput as unknown as CanonicalJsonObject,
    },
  };
  const prepare = () => prepareControlPlaneConfig(env, opts.storeRoot, normalizedBusinessInput);
  if (opts.dryRun) {
    const planned = await planConfigMutation(env, mutationOptions, prepare);
    return {
      plan: registerObservablePublicControlPlanePlan(planned.plan),
      changedFields,
    };
  }
  const planned = await planConfigMutation(env, mutationOptions, prepare);
  const publicPlan = registerObservablePublicControlPlanePlan(planned.plan);
  const applied = await applyControlPlaneMutationPlan(env, publicPlan, {
    storeRoot: opts.storeRoot,
  });
  if (!applied.operation.ok) throw new StoreMutationConflictError(applied.operation.conflict);
  return {
    plan: publicPlan,
    changedFields,
    receipt: { ...applied.operation.receipt, changedFields },
    ...(applied.postCommitInventoryRefresh
      ? { postCommitInventoryRefresh: applied.postCommitInventoryRefresh }
      : {}),
  };
}

async function refreshCommittedCustomAdapter(
  env: Env,
  storeRoot: string,
  input: ControlPlaneBusinessInput,
): Promise<PostCommitInventoryRefresh | undefined> {
  if (input.kind !== "custom" || input.action === "remove") return undefined;
  const inventory = await refreshInventory(env, { storeRoot, agentId: input.agentId });
  if (inventory.completeness === "complete") {
    return Object.freeze({
      agentId: input.agentId,
      status: "complete",
      inventory: inventoryWithCompleteness(inventory, "complete"),
    });
  }
  const retryCommand = `cellarer inventory refresh --agent ${input.agentId}` as const;
  return inventory.completeness === "partial"
    ? Object.freeze({
        agentId: input.agentId,
        status: "partial",
        inventory: inventoryWithCompleteness(inventory, "partial"),
        retryCommand,
      })
    : Object.freeze({
        agentId: input.agentId,
        status: "failed",
        inventory: inventoryWithCompleteness(inventory, "failed"),
        retryCommand,
      });
}

function inventoryWithCompleteness<TCompleteness extends InventoryCompleteness>(
  inventory: InventoryRefreshResult,
  completeness: TCompleteness,
): InventoryRefreshResult & { readonly completeness: TCompleteness } {
  if (inventory.completeness !== completeness) {
    throw new TypeError("Inventory completeness changed while composing the post-commit result");
  }
  return inventory as InventoryRefreshResult & { readonly completeness: TCompleteness };
}

function invalidAppliedControlPlanePlan(plan: MutationPlan): AppliedControlPlaneMutationPlanDto {
  const operation = invalidPlanResult();
  return {
    plan,
    changedFields: [],
    operation,
    mutation: mutationPresentation(plan, operation),
  };
}

function decodeControlPlaneBusinessInput(plan: MutationPlan): ControlPlaneBusinessInput | null {
  if (
    !hasExactObjectKeys(plan.normalizedInputs, [
      "businessInput",
      "changedFields",
      "mutationKind",
      "storeProvenance",
    ])
  ) {
    return null;
  }
  try {
    const businessInput = parseControlPlaneBusinessInput(plan.normalizedInputs.businessInput);
    if (plan.normalizedInputs.mutationKind !== mutationKindForBusinessInput(businessInput)) {
      return null;
    }
    if (
      canonicalJson(plan.normalizedInputs.changedFields) !==
      canonicalJson(changedFieldsForBusinessInput(businessInput))
    ) {
      return null;
    }
    return businessInput;
  } catch {
    return null;
  }
}

function parseControlPlaneBusinessInput(value: unknown): ControlPlaneBusinessInput {
  const input = controlPlaneBusinessInputSchema.parse(value);
  if (input.kind === "builtin") {
    const agentId = validateAgentId(input.agentId);
    const capabilitySnapshot = parseBuiltinCapabilitySnapshot(input.capabilitySnapshot);
    return input.action === "configure"
      ? {
          ...input,
          agentId,
          adapter: parseSnapshottedAdapterPatchInput(input.adapter, agentId),
          capabilitySnapshot,
        }
      : { ...input, agentId, capabilitySnapshot };
  }
  if (input.kind === "custom") {
    const agentId = validateAgentId(input.agentId);
    const capabilitySnapshot = parseBuiltinCapabilitySnapshot(input.capabilitySnapshot);
    return input.action === "remove"
      ? { ...input, agentId, capabilitySnapshot }
      : {
          ...input,
          agentId,
          adapter: parseSnapshottedAdapterBodyInput(input.adapter, agentId),
          capabilitySnapshot,
        };
  }
  if (input.kind === "settings") {
    return input.action === "update"
      ? input
      : { ...input, fields: normalizeResetFields(input.fields) };
  }
  if (input.action === "set-defaults") {
    return {
      ...input,
      collectionNames: uniqueCollectionNames(input.collectionNames, "collectionNames"),
    };
  }
  const collectionName = parseCollectionName(input.collectionName);
  return input.action === "create" || input.action === "set-members"
    ? { ...input, collectionName, resourceIds: normalizeResourceIds(input.resourceIds) }
    : { ...input, collectionName };
}

function parseBuiltinCapabilitySnapshot(
  snapshot: z.output<typeof builtinCapabilitySnapshotSchema>,
): BuiltinCapabilitySnapshot {
  const builtinAdapterIds = snapshot.builtinAdapterIds.map(validateAgentId);
  const normalized = [...new Set(builtinAdapterIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  if (canonicalJson(builtinAdapterIds) !== canonicalJson(normalized)) {
    throw new ControlPlaneValidationError("built-in adapter capability snapshot is not canonical", {
      reason: "INVALID_CAPABILITY_SNAPSHOT",
    });
  }
  return { builtinAdapterIds };
}

function snapshotBusinessInput(input: ControlPlaneBusinessInput): ControlPlaneBusinessInput {
  return parseControlPlaneBusinessInput(
    snapshotConfigRuntimeValue(input, { omitUndefinedObjectProperties: true }),
  );
}

async function builtinCapabilitySnapshot(env: Env): Promise<BuiltinCapabilitySnapshot> {
  return {
    builtinAdapterIds: [...(await loadBuiltinAdapterIds(env))].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

async function packagedDefaultsSnapshot(env: Env): Promise<PackagedDefaultsSnapshot> {
  const defaults = parseConfig(await initialConfigText(env)).defaults;
  return snapshotConfigRuntimeValue(
    {
      method: defaults.method,
      secretMode: defaults.secretMode,
      ...(defaults.os === undefined ? {} : { os: defaults.os }),
    },
    { omitUndefinedObjectProperties: true },
  ) as PackagedDefaultsSnapshot;
}

function mutationKindForBusinessInput(input: ControlPlaneBusinessInput): string {
  if (input.kind === "builtin") return `builtin-agent-${input.action}`;
  if (input.kind === "custom") return `custom-adapter-${input.action}`;
  if (input.kind === "settings") return `config-${input.action}`;
  return `collection-${input.action}`;
}

function changedFieldsForBusinessInput(input: ControlPlaneBusinessInput): string[] {
  if (input.kind === "builtin") {
    if (input.action === "reset") return [`adapterOverrides.${input.agentId}`];
    if (input.action === "enable" || input.action === "disable") {
      return [`adapterOverrides.${input.agentId}.enabled`];
    }
    return adapterChangedFields(input.agentId, "adapter" in input ? input.adapter : {});
  }
  if (input.kind === "custom") {
    return input.action === "remove"
      ? [`customAdapters.${input.agentId}`, `adapterOverrides.${input.agentId}`]
      : [`customAdapters.${input.agentId}`];
  }
  if (input.kind === "settings") {
    const fields =
      input.action === "update"
        ? Object.keys(input.settings).map((field) => settingFieldSchema.parse(field))
        : input.fields;
    return fields.map((field) => `defaults.${field}`);
  }
  return collectionChangedFields(input);
}

async function validateControlPlanePlanUnderLock(
  env: Env,
  storeRoot: string,
  plan: MutationPlan,
  publication: StorePublicationInput,
  expectedBusinessInput: ControlPlaneBusinessInput,
): Promise<OperationResult | null> {
  const decoded = decodeControlPlaneBusinessInput(plan);
  if (!decoded || canonicalJson(decoded) !== canonicalJson(expectedBusinessInput)) {
    return invalidPlanResult();
  }
  try {
    const expectedConfig = await prepareControlPlaneConfig(env, storeRoot, decoded);
    const expectedData = `${JSON.stringify(expectedConfig, null, 2)}\n`;
    if (
      publication.path !== join(storeRoot, CONFIG_FILENAME) ||
      publication.mode !== 0o600 ||
      publication.currentUserOnly === true ||
      publication.data !== expectedData
    ) {
      return invalidPlanResult();
    }
    return null;
  } catch {
    return invalidPlanResult();
  }
}

async function prepareControlPlaneConfig(
  env: Env,
  storeRoot: string,
  input: ControlPlaneBusinessInput,
): Promise<CellarerConfig> {
  const config = await loadConfig(env, storeRoot);
  let dependencies: ControlPlaneMutationDependencies | undefined;
  if (input.kind === "builtin" || input.kind === "custom") {
    const current = await builtinCapabilitySnapshot(env);
    if (canonicalJson(current) !== canonicalJson(input.capabilitySnapshot)) {
      throw new ControlPlaneValidationError("built-in adapter capability snapshot changed", {
        reason: "CAPABILITY_SNAPSHOT_DRIFT",
      });
    }
    if (input.kind === "custom" && input.action === "remove") {
      dependencies = await customAdapterDependencies(env, storeRoot, input.agentId, config);
    }
  } else if (input.kind === "settings" && input.action === "reset") {
    const current = await packagedDefaultsSnapshot(env);
    if (canonicalJson(current) !== canonicalJson(input.capabilitySnapshot.packagedDefaults)) {
      throw new ControlPlaneValidationError("packaged defaults capability snapshot changed", {
        reason: "CAPABILITY_SNAPSHOT_DRIFT",
      });
    }
  } else if (
    input.kind === "collection" &&
    (input.action === "create" || input.action === "set-members")
  ) {
    await exactManagedResourceIds(env, storeRoot, input.resourceIds);
  }
  return reduceControlPlaneConfig(config, input, dependencies);
}

function reduceControlPlaneConfig(
  config: CellarerConfig,
  input: ControlPlaneBusinessInput,
  dependencies?: ControlPlaneMutationDependencies,
): CellarerConfig {
  if (input.kind === "builtin") {
    const builtinIds = new Set(input.capabilitySnapshot.builtinAdapterIds);
    if (input.action === "enable" || input.action === "disable") {
      if (!builtinIds.has(input.agentId) && !config.customAdapters[input.agentId]) {
        throw new ControlPlaneValidationError(`adapter "${input.agentId}" does not exist`, {
          agentId: input.agentId,
        });
      }
    } else if (!builtinIds.has(input.agentId)) {
      throw new ControlPlaneValidationError(`built-in adapter "${input.agentId}" does not exist`, {
        agentId: input.agentId,
      });
    }
    const adapterOverrides = { ...config.adapterOverrides };
    if (input.action === "reset") {
      delete adapterOverrides[input.agentId];
    } else if (input.action === "enable" || input.action === "disable") {
      adapterOverrides[input.agentId] = {
        ...adapterOverrides[input.agentId],
        enabled: input.action === "enable",
      };
    } else {
      adapterOverrides[input.agentId] = mergeOverride(
        adapterOverrides[input.agentId] ?? {},
        "adapter" in input ? input.adapter : {},
      );
    }
    return { ...config, adapterOverrides };
  }

  if (input.kind === "custom") {
    if (input.capabilitySnapshot.builtinAdapterIds.includes(input.agentId)) {
      throw new ControlPlaneValidationError(
        `adapter "${input.agentId}" is built-in and cannot be a custom adapter`,
        { agentId: input.agentId },
      );
    }
    const exists = Object.hasOwn(config.customAdapters, input.agentId);
    if (input.action === "add" && exists) {
      throw new ControlPlaneValidationError(`custom adapter "${input.agentId}" already exists`, {
        agentId: input.agentId,
      });
    }
    if ((input.action === "update" || input.action === "remove") && !exists) {
      throw new ControlPlaneValidationError(`custom adapter "${input.agentId}" does not exist`, {
        agentId: input.agentId,
      });
    }
    if (input.action === "remove") {
      if (
        !dependencies ||
        dependencies.ownedTargets.length > 0 ||
        dependencies.desiredSelections.length > 0
      ) {
        throw new ControlPlaneDependencyError(
          input.agentId,
          dependencies ?? { ownedTargets: [], desiredSelections: ["unverified"] },
        );
      }
      const customAdapters = { ...config.customAdapters };
      const adapterOverrides = { ...config.adapterOverrides };
      delete customAdapters[input.agentId];
      delete adapterOverrides[input.agentId];
      return { ...config, customAdapters, adapterOverrides };
    }
    return {
      ...config,
      customAdapters: { ...config.customAdapters, [input.agentId]: input.adapter },
    };
  }

  if (input.kind === "settings") {
    if (input.action === "update") {
      return { ...config, defaults: { ...config.defaults, ...input.settings } };
    }
    const defaults = { ...config.defaults };
    const packagedDefaults = input.capabilitySnapshot.packagedDefaults;
    for (const field of input.fields) {
      if (field === "os") {
        if (packagedDefaults.os === undefined) delete defaults.os;
        else defaults.os = packagedDefaults.os;
      } else if (field === "method") {
        defaults.method = packagedDefaults.method;
      } else {
        defaults.secretMode = packagedDefaults.secretMode;
      }
    }
    return { ...config, defaults };
  }

  if (input.action === "set-defaults") {
    assertCollectionsExist(config, input.collectionNames);
    return {
      ...config,
      defaults: { ...config.defaults, collections: [...input.collectionNames] },
    };
  }
  const exists = Object.hasOwn(config.collections, input.collectionName);
  if (input.action === "create" && exists) {
    throw new ControlPlaneValidationError(`collection "${input.collectionName}" already exists`, {
      collectionName: input.collectionName,
    });
  }
  if (input.action !== "create" && !exists) {
    throw new ControlPlaneValidationError(`collection "${input.collectionName}" does not exist`, {
      collectionName: input.collectionName,
    });
  }
  if (input.action === "delete") {
    if (config.defaults.collections.includes(input.collectionName)) {
      throw new ControlPlaneCollectionDependencyError(input.collectionName, {
        desiredSelections: [`defaults.collections:${input.collectionName}`],
      });
    }
    const collections = { ...config.collections };
    delete collections[input.collectionName];
    return {
      ...config,
      collections,
      artifacts: setCollectionMembers(config, input.collectionName, []),
    };
  }
  if (input.action === "update") {
    return {
      ...config,
      collections: {
        ...config.collections,
        [input.collectionName]: { description: input.description },
      },
    };
  }
  if (input.action === "set-members") {
    return {
      ...config,
      artifacts: setCollectionMembers(config, input.collectionName, input.resourceIds),
    };
  }
  return {
    ...config,
    collections: {
      ...config.collections,
      [input.collectionName]: {
        ...(input.description === undefined ? {} : { description: input.description }),
      },
    },
    artifacts: setCollectionMembers(config, input.collectionName, input.resourceIds),
  };
}

function hasExactObjectKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function validateAgentId(value: unknown): string {
  try {
    return parseAgentId(value);
  } catch {
    throw new ControlPlaneValidationError("agentId must be an exact legal agent identifier", {
      agentId: value,
    });
  }
}

function preflightBuiltinAgentMutation(value: unknown): BuiltinAgentMutationOptions {
  const input = preflightMutationInput(
    value,
    builtinAgentMutationInputSchema,
    "built-in agent mutation options do not match the public schema",
    "INVALID_ADAPTER_PATCH",
  );
  const agentId = validateAgentId(input.agentId);
  if (input.action === "configure") {
    return {
      ...input,
      agentId,
      adapter: parseSnapshottedAdapterPatchInput(input.adapter, agentId),
    };
  }
  return { ...input, agentId };
}

function preflightCustomAdapterMutation(value: unknown): CustomAdapterMutationOptions {
  const input = preflightMutationInput(
    value,
    customAdapterMutationInputSchema,
    "custom adapter mutation options do not match the public schema",
    "INVALID_ADAPTER_DEFINITION",
  );
  const agentId = validateAgentId(input.agentId);
  if (input.action === "remove") return { ...input, agentId };
  return {
    ...input,
    agentId,
    adapter: parseSnapshottedAdapterBodyInput(input.adapter, agentId),
  };
}

function preflightAgentAdapterMutation(value: unknown): AgentAdapterMutationOptions {
  const input = preflightMutationInput(
    value,
    agentAdapterMutationInputSchema,
    "agent adapter mutation options do not match the public schema",
    "INVALID_ADAPTER_MUTATION",
  );
  const agentId = validateAgentId(input.agentId);
  return input.kind === "builtin"
    ? {
        ...input,
        agentId,
        adapter: parseSnapshottedAdapterPatchInput(input.adapter, agentId),
      }
    : {
        ...input,
        agentId,
        adapter: parseSnapshottedAdapterBodyInput(input.adapter, agentId),
      };
}

export function parseAgentAdapterMutationBody(value: unknown): AgentAdapterMutationBody {
  const input = preflightMutationInput(
    value,
    agentAdapterMutationBodySchema,
    "agent adapter mutation body does not match the public schema",
    "INVALID_ADAPTER_MUTATION",
  );
  return input.kind === "builtin"
    ? {
        ...input,
        adapter: parseSnapshottedAdapterPatchInput(input.adapter, "request"),
      }
    : {
        ...input,
        adapter: parseSnapshottedAdapterBodyInput(input.adapter, "request"),
      };
}

export function parseAgentEnabledMutationBody(value: unknown): AgentEnabledMutationBody {
  return preflightMutationInput(
    value,
    agentEnabledMutationBodySchema,
    "agent enabled mutation body does not match the public schema",
    "INVALID_AGENT_ENABLED_BODY",
  );
}

export function parseControlPlaneSettingsMutationBody(
  value: unknown,
): ControlPlaneSettingsMutationBody {
  return preflightMutationInput(
    value,
    settingsMutationBodySchema,
    "settings mutation body does not match the public schema",
    "INVALID_SETTINGS_PATCH",
  );
}

export function parseCollectionCreateMutationBody(value: unknown): CollectionCreateMutationBody {
  return preflightMutationInput(
    value,
    collectionCreateMutationBodySchema,
    "collection create body does not match the public schema",
    "INVALID_COLLECTION_MUTATION",
  );
}

export function parseCollectionUpdateMutationBody(value: unknown): CollectionUpdateMutationBody {
  return preflightMutationInput(
    value,
    collectionUpdateMutationBodySchema,
    "collection update body does not match the public schema",
    "INVALID_COLLECTION_MUTATION",
  );
}

export function parseCollectionMembersMutationBody(value: unknown): CollectionMembersMutationBody {
  return preflightMutationInput(
    value,
    collectionMembersMutationBodySchema,
    "collection members body does not match the public schema",
    "INVALID_COLLECTION_MUTATION",
  );
}

export function parseCollectionDefaultsMutationBody(
  value: unknown,
): CollectionDefaultsMutationBody {
  return preflightMutationInput(
    value,
    collectionDefaultsMutationBodySchema,
    "collection defaults body does not match the public schema",
    "INVALID_COLLECTION_MUTATION",
  );
}

function preflightSettingsMutation(value: unknown): ControlPlaneSettingsMutationOptions {
  const input = preflightMutationInput(
    value,
    settingsMutationInputSchema,
    "settings mutation options do not match the public schema",
    "INVALID_SETTINGS_PATCH",
  );
  return input.action === "update"
    ? input
    : { ...input, fields: normalizeResetFields(input.fields) };
}

function preflightCollectionMutation(value: unknown): CollectionMutationOptions {
  const input = preflightMutationInput(
    value,
    collectionMutationInputSchema,
    "collection mutation options do not match the public schema",
    "INVALID_COLLECTION_MUTATION",
  );
  if (input.action === "set-defaults") {
    const collectionNames = uniqueCollectionNames(input.collectionNames, "collectionNames");
    if (collectionNames.length === 0) {
      throw new ControlPlaneValidationError("collection defaults cannot be empty", {
        collectionNames,
      });
    }
    return { ...input, collectionNames };
  }
  const collectionName = parseCollectionName(input.collectionName);
  if (input.action === "create" || input.action === "set-members") {
    return {
      ...input,
      collectionName,
      resourceIds: normalizeResourceIds(input.resourceIds),
    };
  }
  return { ...input, collectionName };
}

function preflightMutationInput<TSchema extends z.ZodType>(
  value: unknown,
  schema: TSchema,
  message: string,
  reason: string,
): z.output<TSchema> {
  return parseDomainInput(message, { reason }, () =>
    schema.parse(
      snapshotConfigRuntimeValue(value, {
        omitUndefinedObjectProperties: true,
      }),
    ),
  );
}

function parseSnapshottedAdapterPatchInput(value: unknown, agentId: string): AdapterPatchConfig {
  return parseDomainInput(
    `adapter patch for "${agentId}" does not match the config schema`,
    { agentId, reason: "INVALID_ADAPTER_PATCH" },
    () => parseSnapshottedAdapterPatchConfig(value),
  );
}

function parseSnapshottedAdapterBodyInput(value: unknown, agentId: string): AdapterBodyConfig {
  return parseDomainInput(
    `adapter definition for "${agentId}" does not match the config schema`,
    { agentId, reason: "INVALID_ADAPTER_DEFINITION" },
    () => parseSnapshottedAdapterBodyConfig(value),
  );
}

function parseDomainInput<T>(
  message: string,
  details: Readonly<Record<string, unknown>>,
  parse: () => T,
): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ControlPlaneValidationError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new ControlPlaneValidationError(`${message}: ${reason}`, details);
  }
}

function controlPlaneProvenancePaths(storeRoot: string, mutationKind: string): string[] {
  const paths = [join(storeRoot, CONFIG_FILENAME)];
  if (mutationKind === "custom-adapter-remove") paths.push(join(storeRoot, "state.json"));
  if (mutationKind === "collection-create" || mutationKind === "collection-set-members") {
    paths.push(
      join(storeRoot, "store", "mcp"),
      join(storeRoot, "store", "rules"),
      join(storeRoot, "store", "skills"),
    );
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

export function parseControlPlaneSettingsPatch(input: unknown): ControlPlaneSettingsPatch {
  return settingsPatchSchema.parse(snapshotConfigRuntimeValue(input));
}

export function parseControlPlaneSettingFields(
  fields: readonly unknown[] | undefined,
): ControlPlaneSettingField[] {
  return parseResetFields(fields as readonly ControlPlaneSettingField[] | undefined);
}

async function loadBuiltinAdapterIds(env: Env): Promise<Set<string>> {
  const packaged = parsePackagedConfigForSettings(await packagedConfigText(env));
  return new Set(Object.keys(packaged.builtinAdapters));
}

async function customAdapterDependencies(
  env: Env,
  storeRoot: string,
  agentId: string,
  config: CellarerConfig,
): Promise<ControlPlaneMutationDependencies> {
  const ledger = await loadLedger(env, storeRoot);
  return {
    ownedTargets: ledger.owners
      .filter((owner) => owner.agent === agentId)
      .map((owner) => owner.target)
      .sort((left, right) => left.localeCompare(right)),
    desiredSelections:
      config.adapterOverrides[agentId]?.enabled === false ? [] : [`agent:${agentId}:enabled`],
  };
}

function mergeOverride(
  current: AdapterOverrideConfig,
  patch: AdapterPatchConfig,
): AdapterOverrideConfig {
  return {
    ...current,
    ...patch,
    ...(patch.detect ? { detect: { ...current.detect, ...patch.detect } } : {}),
    ...(patch.rules ? { rules: { ...current.rules, ...patch.rules } } : {}),
    ...(patch.mcp
      ? {
          mcp: {
            ...current.mcp,
            ...patch.mcp,
            ...(patch.mcp.dialect
              ? { dialect: { ...current.mcp?.dialect, ...patch.mcp.dialect } }
              : {}),
          },
        }
      : {}),
    ...(patch.skills ? { skills: { ...current.skills, ...patch.skills } } : {}),
    ...(patch.capabilities
      ? { capabilities: { ...current.capabilities, ...patch.capabilities } }
      : {}),
  };
}

function adapterChangedFields(agentId: string, adapter: AdapterPatchConfig): string[] {
  return Object.keys(adapter)
    .sort((left, right) => left.localeCompare(right))
    .map((field) => `adapterOverrides.${agentId}.${field}`);
}

function parseResetFields(fields: readonly unknown[] | undefined): ControlPlaneSettingField[] {
  if (fields === undefined) return normalizeResetFields(undefined);
  const parsed = parseDomainInput(
    "settings reset fields do not match the config schema",
    { reason: "INVALID_SETTINGS_RESET_FIELDS" },
    () => z.array(settingFieldSchema).parse(snapshotConfigRuntimeValue(fields)),
  );
  return normalizeResetFields(parsed);
}

function normalizeResetFields(
  fields: readonly ControlPlaneSettingField[] | undefined,
): ControlPlaneSettingField[] {
  const parsed: ControlPlaneSettingField[] =
    fields === undefined ? ["method", "secretMode", "os"] : [...fields];
  if (new Set(parsed).size !== parsed.length) {
    throw new ControlPlaneValidationError("settings reset fields must be unique", {
      fields: parsed,
    });
  }
  return parsed;
}

function collectionChangedFields(
  opts:
    | CollectionMutationOptions
    | Extract<ControlPlaneBusinessInput, { readonly kind: "collection" }>,
): string[] {
  if (opts.action === "set-defaults") return ["defaults.collections"];
  if (opts.action === "create") {
    return [`collections.${opts.collectionName}`, `collections.${opts.collectionName}.members`];
  }
  if (opts.action === "set-members") return [`collections.${opts.collectionName}.members`];
  return [`collections.${opts.collectionName}`];
}

function parseCollectionName(value: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new ControlPlaneValidationError("collection name must be a non-empty exact value", {
      collectionName: value,
    });
  }
  return value;
}

function uniqueCollectionNames(values: readonly string[], field: string): string[] {
  const parsed = values.map(parseCollectionName);
  if (new Set(parsed).size !== parsed.length) {
    throw new ControlPlaneValidationError(`${field} must contain unique collection names`, {
      [field]: parsed,
    });
  }
  return parsed;
}

function assertCollectionsExist(config: CellarerConfig, collectionNames: readonly string[]): void {
  const missing = collectionNames.filter((name) => !Object.hasOwn(config.collections, name));
  if (missing.length > 0) {
    throw new ControlPlaneValidationError("collection selection contains unknown collections", {
      collectionNames: missing,
    });
  }
}

async function exactManagedResourceIds(
  env: Env,
  storeRoot: string,
  resourceIds: readonly string[],
): Promise<string[]> {
  const artifacts = await Promise.all([
    listRuleArtifacts(env, storeRoot),
    listMcpArtifacts(env, storeRoot),
    listSkillArtifacts(env, storeRoot),
  ]);
  const available = new Set(artifacts.flat().map((artifact) => artifact.id));
  const missing = resourceIds.filter((resourceId) => !available.has(resourceId));
  if (missing.length > 0) {
    throw new ControlPlaneValidationError("collection members contain unknown resource IDs", {
      resourceIds: missing,
    });
  }
  return [...resourceIds];
}

function normalizeResourceIds(resourceIds: readonly string[]): string[] {
  if (new Set(resourceIds).size !== resourceIds.length) {
    throw new ControlPlaneValidationError("resourceIds must contain unique immutable IDs", {
      resourceIds,
    });
  }
  const malformed = resourceIds.filter(
    (resourceId) => !/^(rules|mcp|skills)\/[^/*,\s]+$/.test(resourceId),
  );
  if (malformed.length > 0) {
    throw new ControlPlaneValidationError("collection members require immutable resource IDs", {
      resourceIds: malformed,
    });
  }
  return [...resourceIds];
}

function setCollectionMembers(
  config: CellarerConfig,
  collectionName: string,
  resourceIds: readonly string[],
): CellarerConfig["artifacts"] {
  const artifacts = Object.fromEntries(
    Object.entries(config.artifacts).map(([resourceId, artifact]) => [
      resourceId,
      {
        ...artifact,
        collections: artifact.collections.filter((name) => name !== collectionName),
      },
    ]),
  ) as CellarerConfig["artifacts"];
  for (const resourceId of resourceIds) {
    const artifact = artifacts[resourceId] ?? { collections: [] };
    artifacts[resourceId] = {
      ...artifact,
      collections: [...artifact.collections, collectionName],
    };
  }
  return artifacts;
}
