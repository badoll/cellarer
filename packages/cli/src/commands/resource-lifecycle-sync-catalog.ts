import {
  type CommandDomain,
  defineCommandDomain,
  defineContractMetadata,
} from "../protocol/command-contract.js";
import { commandSchemaFragments as s } from "../protocol/command-schema-fragments.js";
import {
  createDeploymentBaselineCommandContract,
  createDeploymentUpgradeCommandContract,
  createProfileCommandContract,
  createResourceLifecycleCommandContract,
  createSyncCommandContract,
} from "./resource-lifecycle.js";

export function createResourceLifecycleSyncDomain(): CommandDomain {
  return defineCommandDomain({
    id: "resource-lifecycle-sync",
    contracts: [
      createDeploymentBaselineCommandContract(
        defineContractMetadata({
          command: "sync.baseline",
          catalogOrder: 68,
          mutability: "write",
          requiredFeatures: ["mutation-authority", "plan-apply"],
          input: s.jsonSchema.object(
            {
              deploymentId: s.jsonSchema.string({ minLength: 1 }),
              selectors: s.stringArray,
              plan: s.opaquePlan,
              dryRun: s.jsonSchema.boolean(),
            },
            ["deploymentId", "selectors"],
          ),
          bindings: [
            s.option("deploymentId"),
            s.option("selectors", undefined, s.joinList),
            s.option("plan", undefined, s.stringifyJson),
            s.option("dryRun"),
          ],
          output: s.opaqueJsonMap,
        }),
      ),
      createDeploymentUpgradeCommandContract(
        defineContractMetadata({
          command: "sync.upgrade-state",
          catalogOrder: 67,
          mutability: "write",
          requiredFeatures: ["mutation-authority", "plan-apply"],
          input: s.jsonSchema.object({ plan: s.opaquePlan, dryRun: s.jsonSchema.boolean() }),
          bindings: [s.option("plan", undefined, s.stringifyJson), s.option("dryRun")],
          output: s.opaqueJsonMap,
        }),
      ),
      createResourceLifecycleCommandContract(
        defineContractMetadata({
          command: "resource.dependencies",
          catalogOrder: 46,
          mutability: "read",
          requiredFeatures: ["exact-resource-selector"],
          input: s.jsonSchema.object({ resourceId: s.resourceId }, ["resourceId"]),
          bindings: [s.positional("resourceId", 0)],
          output: s.opaqueJsonMap,
        }),
        "dependencies",
      ),
      createResourceLifecycleCommandContract(
        defineContractMetadata({
          command: "resource.check",
          catalogOrder: 47,
          mutability: "read",
          requiredFeatures: ["exact-resource-selector", "resource-provenance"],
          input: s.jsonSchema.object({ resourceId: s.resourceId }, ["resourceId"]),
          bindings: [s.positional("resourceId", 0)],
          output: s.opaqueJsonMap,
        }),
        "check",
      ),
      createResourceLifecycleCommandContract(
        defineContractMetadata({
          command: "resource.update",
          catalogOrder: 48,
          mutability: "write",
          requiredFeatures: ["mutation-authority", "plan-apply", "resource-provenance"],
          input: s.jsonSchema.object(
            { resourceId: s.resourceId, plan: s.opaquePlan, dryRun: s.jsonSchema.boolean() },
            ["resourceId"],
          ),
          bindings: [
            s.positional("resourceId", 0),
            s.option("plan", undefined, s.stringifyJson),
            s.option("dryRun"),
          ],
          output: s.opaqueJsonMap,
        }),
        "update",
      ),
      createResourceLifecycleCommandContract(
        defineContractMetadata({
          command: "resource.rename",
          catalogOrder: 49,
          mutability: "write",
          requiredFeatures: ["mutation-authority", "plan-apply", "exact-resource-selector"],
          input: s.jsonSchema.object(
            {
              resourceId: s.resourceId,
              newName: s.jsonSchema.string({ minLength: 1 }),
              localFork: s.jsonSchema.boolean(),
              plan: s.opaquePlan,
              dryRun: s.jsonSchema.boolean(),
            },
            ["resourceId", "newName"],
          ),
          bindings: [
            s.positional("resourceId", 0),
            s.positional("newName", 1),
            s.option("localFork"),
            s.option("plan", undefined, s.stringifyJson),
            s.option("dryRun"),
          ],
          output: s.opaqueJsonMap,
        }),
        "rename",
      ),
      createResourceLifecycleCommandContract(
        defineContractMetadata({
          command: "resource.remove",
          catalogOrder: 50,
          mutability: "write",
          requiredFeatures: ["mutation-authority", "plan-apply", "exact-resource-selector"],
          input: s.jsonSchema.object(
            {
              resourceId: s.resourceId,
              cascade: s.jsonSchema.boolean(),
              plan: s.opaquePlan,
              dryRun: s.jsonSchema.boolean(),
            },
            ["resourceId"],
          ),
          bindings: [
            s.positional("resourceId", 0),
            s.option("cascade"),
            s.option("plan", undefined, s.stringifyJson),
            s.option("dryRun"),
          ],
          output: s.opaqueJsonMap,
        }),
        "remove",
      ),
      createResourceLifecycleCommandContract(
        defineContractMetadata({
          command: "resource.export",
          catalogOrder: 51,
          mutability: "write",
          requiredFeatures: ["mutation-authority", "plan-apply", "reference-only-export"],
          input: s.jsonSchema.object(
            {
              resourceId: s.resourceId,
              bundlePath: s.jsonSchema.string({ minLength: 1 }),
              plan: s.opaquePlan,
              dryRun: s.jsonSchema.boolean(),
            },
            ["resourceId", "bundlePath"],
          ),
          bindings: [
            s.positional("resourceId", 0),
            s.positional("bundlePath", 1),
            s.option("plan", undefined, s.stringifyJson),
            s.option("dryRun"),
          ],
          output: s.opaqueJsonMap,
        }),
        "export",
      ),
      createResourceLifecycleCommandContract(
        defineContractMetadata({
          command: "resource.import",
          catalogOrder: 52,
          mutability: "write",
          requiredFeatures: ["mutation-authority", "plan-apply", "reference-only-export"],
          input: s.jsonSchema.object(
            {
              bundlePath: s.jsonSchema.string({ minLength: 1 }),
              plan: s.opaquePlan,
              dryRun: s.jsonSchema.boolean(),
            },
            ["bundlePath"],
          ),
          bindings: [
            s.positional("bundlePath", 0),
            s.option("plan", undefined, s.stringifyJson),
            s.option("dryRun"),
          ],
          output: s.opaqueJsonMap,
        }),
        "import",
      ),
      createProfileCommandContract(
        defineContractMetadata({
          command: "profile.list",
          catalogOrder: 53,
          mutability: "read",
          input: s.jsonSchema.object(),
          bindings: [],
          output: s.opaqueJsonMap,
        }),
        "list",
      ),
      createProfileCommandContract(
        defineContractMetadata({
          command: "profile.show",
          catalogOrder: 54,
          mutability: "read",
          input: s.jsonSchema.object({ profileId: s.syncProfileId }, ["profileId"]),
          bindings: [s.positional("profileId", 0)],
          output: s.opaqueJsonMap,
        }),
        "show",
      ),
      ...(["create", "update"] as const).map((action, index) =>
        createProfileCommandContract(
          defineContractMetadata({
            command: `profile.${action}`,
            catalogOrder: 55 + index,
            mutability: "write",
            requiredFeatures: ["mutation-authority", "plan-apply", "sync-profiles"],
            input: s.jsonSchema.object(
              {
                profileId: s.syncProfileId,
                desired: s.syncProfileDesired,
                dryRun: s.jsonSchema.boolean(),
              },
              ["profileId", "desired"],
            ),
            bindings: [
              s.positional("profileId", 0),
              s.option("desired", undefined, s.stringifyJson),
              s.option("dryRun"),
            ],
            output: s.opaqueJsonMap,
          }),
          action,
        ),
      ),
      createProfileCommandContract(
        defineContractMetadata({
          command: "profile.delete",
          catalogOrder: 57,
          mutability: "write",
          requiredFeatures: ["mutation-authority", "plan-apply", "sync-profiles"],
          input: s.jsonSchema.object(
            { profileId: s.syncProfileId, dryRun: s.jsonSchema.boolean() },
            ["profileId"],
          ),
          bindings: [s.positional("profileId", 0), s.option("dryRun")],
          output: s.opaqueJsonMap,
        }),
        "delete",
      ),
      createSyncCommandContract(
        defineContractMetadata({
          command: "sync.plan",
          catalogOrder: 58,
          mutability: "read",
          requiredFeatures: ["mutation-authority", "plan-apply", "sync-profiles"],
          input: s.profileInvocationInput(true),
          bindings: s.profileInvocationBindings(true),
          output: s.opaqueJsonMap,
        }),
        "plan",
      ),
      createSyncCommandContract(
        defineContractMetadata({
          command: "sync.apply",
          catalogOrder: 59,
          mutability: "write",
          requiredFeatures: ["mutation-authority", "plan-apply", "sync-profiles"],
          input: s.jsonSchema.object(
            { ...s.profileInvocationProperties(true), plan: s.opaquePlan },
            ["profileId", "plan"],
          ),
          bindings: [
            ...s.profileInvocationBindings(true),
            s.option("plan", undefined, s.stringifyJson),
          ],
          output: s.opaqueJsonMap,
        }),
        "apply",
      ),
      createSyncCommandContract(
        defineContractMetadata({
          command: "sync.verify",
          catalogOrder: 60,
          mutability: "read",
          requiredFeatures: ["mutation-authority", "sync-profiles"],
          input: s.profileInvocationInput(),
          bindings: s.profileInvocationBindings(),
          output: s.opaqueJsonMap,
        }),
        "verify",
      ),
      createSyncCommandContract(
        defineContractMetadata({
          command: "sync.uninstall",
          catalogOrder: 61,
          mutability: "write",
          requiredFeatures: ["mutation-authority", "plan-apply", "sync-profiles"],
          input: s.jsonSchema.object(
            {
              ...s.profileInvocationProperties(),
              plan: s.opaquePlan,
              acknowledgements: s.stringArray,
              dryRun: s.jsonSchema.boolean(),
            },
            ["profileId"],
          ),
          bindings: [
            ...s.profileInvocationBindings(),
            s.option("plan", undefined, s.stringifyJson),
            s.option("acknowledgements", "acknowledge", s.joinList),
            s.option("dryRun"),
          ],
          output: s.opaqueJsonMap,
        }),
        "uninstall",
      ),
    ],
  });
}
