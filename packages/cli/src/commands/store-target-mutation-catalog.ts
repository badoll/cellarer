import {
  type CommandDomain,
  defineCommandDomain,
  defineContractMetadata,
} from "../protocol/command-contract.js";
import { commandSchemaFragments as s } from "../protocol/command-schema-fragments.js";
import type { CommandInputBinding } from "../protocol/command-types.js";
import type { JsonSchema } from "../protocol/schemas.js";
import { createApplyCommandContract } from "./apply.js";
import {
  createBuiltinAgentMutationCommandContract,
  createCollectionMutationCommandContract,
  createConfigMutationCommandContract,
  createCustomAdapterMutationCommandContract,
} from "./control-plane-mutations.js";
import { createRevertCommandContract } from "./revert.js";

export function createStoreTargetMutationDomain(): CommandDomain {
  return defineCommandDomain({
    id: "store-target-mutations",
    contracts: [
      createApplyCommandContract(
        defineContractMetadata({
          command: "apply",
          catalogOrder: 4,
          mutability: "write",
          streaming: true,
          requiredFeatures: ["mutation-authority", "plan-apply", "protected-secret-channel"],
          input: s.jsonSchema.object({
            plan: s.applyMutationPlan,
            agents: s.stringArray,
            dir: s.jsonSchema.string({ minLength: 1 }),
            collection: s.jsonSchema.string({ minLength: 1 }),
            capabilities: s.capabilityArray,
            copy: s.jsonSchema.boolean(),
            mcpOverwrite: s.jsonSchema.boolean(),
            secretMode: s.secretMode,
            vaultPassphraseFd: s.jsonSchema.integer(
              s.PROTECTED_DESCRIPTOR_MIN,
              s.PROTECTED_DESCRIPTOR_MAX,
            ),
            keychainService: s.jsonSchema.string({ minLength: 1 }),
            replaceUnowned: s.stringArray,
            overrideDrift: s.stringArray,
            snapshotPassphraseFd: s.jsonSchema.integer(
              s.PROTECTED_DESCRIPTOR_MIN,
              s.PROTECTED_DESCRIPTOR_MAX,
            ),
            dryRun: s.jsonSchema.boolean(),
          }),
          bindings: [
            s.option("plan", undefined, s.stringifyJson),
            s.option("agents", "agent", s.joinList),
            s.option("dir"),
            s.option("collection"),
            ...s.capabilityBindings(),
            s.option("copy"),
            s.option("mcpOverwrite"),
            s.option("secretMode"),
            s.option("vaultPassphraseFd", undefined, s.stringify),
            s.option("keychainService"),
            s.option("replaceUnowned", undefined, s.joinList),
            s.option("overrideDrift", undefined, s.joinList),
            s.option("snapshotPassphraseFd", undefined, s.stringify),
            s.option("dryRun"),
          ],
          output: { oneOf: [s.distributionApplyOutput, s.settingsApplyOutput] },
          event: s.progressEvent,
        }),
      ),
      createRevertCommandContract(
        defineContractMetadata({
          command: "revert",
          catalogOrder: 7,
          mutability: "write",
          streaming: true,
          requiredFeatures: ["mutation-authority", "plan-apply"],
          input: s.jsonSchema.object({
            agents: s.stringArray,
            dir: s.jsonSchema.string({ minLength: 1 }),
            all: s.jsonSchema.boolean(),
            keepBackups: s.jsonSchema.boolean(),
            acknowledgements: s.stringArray,
            snapshotPassphraseFd: s.jsonSchema.integer(
              s.PROTECTED_DESCRIPTOR_MIN,
              s.PROTECTED_DESCRIPTOR_MAX,
            ),
            dryRun: s.jsonSchema.boolean(),
          }),
          bindings: [
            s.option("agents", "agent", s.joinList),
            s.option("dir"),
            s.option("all"),
            s.option("keepBackups"),
            s.option("acknowledgements", "acknowledge", s.joinList),
            s.option("snapshotPassphraseFd", undefined, s.stringify),
            s.option("dryRun"),
          ],
          output: s.dataObject(["plan", "reverted", "failures", "mutation", "warnings"], {
            plan: s.revertPlan,
            reverted: s.jsonSchema.array(s.ledgerEntry),
            failures: s.jsonSchema.array(s.revertFailure),
            mutation: s.mutationPresentation,
            warnings: s.stringArray,
          }),
          event: s.progressEvent,
        }),
      ),
      createBuiltinAgentMutationCommandContract(
        mutationMetadata(
          "agent.enable",
          20,
          { agentId: s.agentId },
          ["agentId"],
          [s.positional("agentId", 0)],
        ),
        "enable",
      ),
      createBuiltinAgentMutationCommandContract(
        mutationMetadata(
          "agent.disable",
          21,
          { agentId: s.agentId },
          ["agentId"],
          [s.positional("agentId", 0)],
        ),
        "disable",
      ),
      createBuiltinAgentMutationCommandContract(
        mutationMetadata(
          "agent.configure",
          22,
          { agentId: s.agentId, adapter: s.adapterPatch },
          ["agentId", "adapter"],
          [s.positional("agentId", 0), s.option("adapter")],
        ),
        "configure",
      ),
      createBuiltinAgentMutationCommandContract(
        mutationMetadata(
          "agent.reset",
          23,
          { agentId: s.agentId },
          ["agentId"],
          [s.positional("agentId", 0)],
        ),
        "reset",
      ),
      createCustomAdapterMutationCommandContract(
        mutationMetadata(
          "agent.add",
          24,
          { agentId: s.agentId, adapter: s.adapterBody },
          ["agentId", "adapter"],
          [s.positional("agentId", 0), s.option("adapter")],
          [],
          s.customAdapterMutationOutput,
        ),
        "add",
      ),
      createCustomAdapterMutationCommandContract(
        mutationMetadata(
          "agent.update",
          25,
          { agentId: s.agentId, adapter: s.adapterBody },
          ["agentId", "adapter"],
          [s.positional("agentId", 0), s.option("adapter")],
          [],
          s.customAdapterMutationOutput,
        ),
        "update",
      ),
      createCustomAdapterMutationCommandContract(
        mutationMetadata(
          "agent.remove",
          26,
          { agentId: s.agentId },
          ["agentId"],
          [s.positional("agentId", 0)],
        ),
        "remove",
      ),
      createCollectionMutationCommandContract(
        mutationMetadata(
          "collection.create",
          29,
          {
            collectionName: s.jsonSchema.string({ minLength: 1 }),
            description: s.jsonSchema.string(),
            resourceIds: s.stringArray,
          },
          ["collectionName", "resourceIds"],
          [
            s.positional("collectionName", 0),
            s.option("description"),
            s.option("resourceIds", "resource", s.joinList),
          ],
          ["exact-resource-selector"],
        ),
        "create",
      ),
      createCollectionMutationCommandContract(
        mutationMetadata(
          "collection.update",
          30,
          {
            collectionName: s.jsonSchema.string({ minLength: 1 }),
            description: s.jsonSchema.string(),
          },
          ["collectionName", "description"],
          [s.positional("collectionName", 0), s.option("description")],
        ),
        "update",
      ),
      createCollectionMutationCommandContract(
        mutationMetadata(
          "collection.delete",
          31,
          { collectionName: s.jsonSchema.string({ minLength: 1 }) },
          ["collectionName"],
          [s.positional("collectionName", 0)],
        ),
        "delete",
      ),
      createCollectionMutationCommandContract(
        mutationMetadata(
          "collection.members.set",
          32,
          {
            collectionName: s.jsonSchema.string({ minLength: 1 }),
            resourceIds: s.stringArray,
          },
          ["collectionName", "resourceIds"],
          [s.positional("collectionName", 0), s.option("resourceIds", "resource", s.joinList)],
          ["exact-resource-selector"],
        ),
        "set-members",
      ),
      createCollectionMutationCommandContract(
        mutationMetadata(
          "collection.defaults.set",
          33,
          { collectionNames: s.stringArray },
          ["collectionNames"],
          [s.option("collectionNames", "collection", s.joinList)],
        ),
        "set-defaults",
      ),
      createConfigMutationCommandContract(
        mutationMetadata(
          "config.update",
          36,
          { settings: s.settingsPatch },
          ["settings"],
          [s.option("settings")],
        ),
        "update",
      ),
      createConfigMutationCommandContract(
        mutationMetadata(
          "config.reset",
          37,
          { fields: s.stringArray },
          [],
          [s.option("fields", "field", s.joinList)],
        ),
        "reset",
      ),
    ],
  });
}

function mutationMetadata<TCommand extends string>(
  command: TCommand,
  catalogOrder: number,
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
  bindings: readonly CommandInputBinding[],
  requiredFeatures: readonly string[] = [],
  output: JsonSchema = s.plannedMutationOutput,
) {
  return defineContractMetadata({
    command,
    catalogOrder,
    mutability: "write",
    requiredFeatures: ["mutation-authority", "plan-apply", ...new Set(requiredFeatures)],
    input: s.jsonSchema.object({ ...properties, dryRun: s.jsonSchema.boolean() }, required),
    bindings: [...bindings, s.option("dryRun")],
    output,
  });
}
