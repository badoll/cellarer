import type { resolveContext } from "../context.js";
import {
  type CommandCatalog,
  type CommandDomain,
  createCommandCatalog,
  defineCommandDomain,
  defineContractMetadata,
} from "../protocol/command-contract.js";
import { commandSchemaFragments as s } from "../protocol/command-schema-fragments.js";
import {
  createAgentListCommandContract,
  createAgentShowCommandContract,
  createCollectionListCommandContract,
  createCollectionShowCommandContract,
  createConfigShowCommandContract,
  createConfigValidateCommandContract,
  createDiffCommandContract,
  createOperationListCommandContract,
  createOperationShowCommandContract,
  createPlanCommandContract,
  createResourceListCommandContract,
  createResourceShowCommandContract,
  createSummaryCommandContract,
  createVerifyCommandContract,
} from "./control-plane-read.js";
import { createDiagnosticsServiceDomain } from "./diagnostics-service-catalog.js";
import type { ProtocolDiscoveryProvider } from "./discovery.js";
import type { InitAgentSelector } from "./init.js";
import { createInitializationDiscoveryDomain } from "./initialization-discovery-catalog.js";
import { createResourceLifecycleSyncDomain } from "./resource-lifecycle-sync-catalog.js";
import { createSecretAuthorityRecoveryDomain } from "./secret-authority-recovery-catalog.js";
import { createStoreArtifactDomain } from "./store-artifact-catalog.js";
import { createStoreTargetMutationDomain } from "./store-target-mutation-catalog.js";

export function createCliCommandCatalog(
  options: {
    readonly initAgentSelector?: InitAgentSelector;
    readonly scanContextResolver?: typeof resolveContext;
  } = {},
): CommandCatalog {
  let catalog: CommandCatalog | undefined;
  const provider: ProtocolDiscoveryProvider = {
    getCapabilities: () => requireCatalog(catalog).getCapabilities(),
    getSchemaBundle: (schemaId) => requireCatalog(catalog).getSchemaBundle(schemaId),
  };
  catalog = createCommandCatalog([
    createInitializationDiscoveryDomain(options, provider),
    createStoreArtifactDomain(),
    createControlPlaneReadDomain(),
    createStoreTargetMutationDomain(),
    createResourceLifecycleSyncDomain(),
    createSecretAuthorityRecoveryDomain(),
    createDiagnosticsServiceDomain(),
  ]);
  return catalog;
}

let defaultCliCommandCatalog: CommandCatalog | undefined;

export function getDefaultCliCommandCatalog(): CommandCatalog {
  defaultCliCommandCatalog ??= createCliCommandCatalog();
  return defaultCliCommandCatalog;
}

function createControlPlaneReadDomain(): CommandDomain {
  return defineCommandDomain({
    id: "control-plane-read",
    contracts: [
      createResourceListCommandContract(
        defineContractMetadata({
          command: "resource.list",
          catalogOrder: 16,
          mutability: "read",
          requiredFeatures: ["exact-resource-selector"],
          input: s.resourceQueryInput(),
          bindings: s.resourceQueryBindings(),
          output: s.resourceListOutput,
        }),
      ),
      createResourceShowCommandContract(
        defineContractMetadata({
          command: "resource.show",
          catalogOrder: 17,
          mutability: "read",
          requiredFeatures: ["exact-resource-selector"],
          input: s.jsonSchema.object(
            {
              resourceId: s.jsonSchema.string({ minLength: 1 }),
              ...s.resourceQueryProperties(),
            },
            ["resourceId"],
          ),
          bindings: [s.positional("resourceId", 0), ...s.resourceQueryBindings()],
          output: s.dataObject(["resource", "warnings"], {
            resource: s.nullableObject(s.controlPlaneResource),
            warnings: s.stringArray,
          }),
        }),
      ),
      createAgentListCommandContract(
        defineContractMetadata({
          command: "agent.list",
          catalogOrder: 18,
          mutability: "read",
          input: s.controlPlaneScopeInput(),
          bindings: s.controlPlaneScopeBindings(),
          output: s.agentListOutput,
        }),
      ),
      createAgentShowCommandContract(
        defineContractMetadata({
          command: "agent.show",
          catalogOrder: 19,
          mutability: "read",
          input: s.jsonSchema.object({ agentId: s.agentId, ...s.controlPlaneScopeProperties() }, [
            "agentId",
          ]),
          bindings: [s.positional("agentId", 0), ...s.controlPlaneScopeBindings()],
          output: s.dataObject(["agent", "warnings"], {
            agent: s.nullableObject(s.controlPlaneAgent),
            warnings: s.stringArray,
          }),
        }),
      ),
      createCollectionListCommandContract(
        defineContractMetadata({
          command: "collection.list",
          catalogOrder: 27,
          mutability: "read",
          input: s.jsonSchema.object(),
          bindings: [],
          output: s.collectionListOutput,
        }),
      ),
      createCollectionShowCommandContract(
        defineContractMetadata({
          command: "collection.show",
          catalogOrder: 28,
          mutability: "read",
          input: s.jsonSchema.object({ collectionName: s.jsonSchema.string({ minLength: 1 }) }, [
            "collectionName",
          ]),
          bindings: [s.positional("collectionName", 0)],
          output: s.dataObject(["revision", "collection"], {
            revision: s.jsonSchema.integer(),
            collection: s.nullableObject(s.controlPlaneCollection),
          }),
        }),
      ),
      createConfigShowCommandContract(
        defineContractMetadata({
          command: "config.show",
          catalogOrder: 34,
          mutability: "read",
          input: s.jsonSchema.object(),
          bindings: [],
          output: s.configOutput,
        }),
      ),
      createConfigValidateCommandContract(
        defineContractMetadata({
          command: "config.validate",
          catalogOrder: 35,
          mutability: "read",
          input: s.jsonSchema.object({ config: s.controlPlaneConfigValidationInput }, ["config"]),
          bindings: [s.option("config")],
          output: s.dataObject(["valid", "issues"], {
            valid: s.jsonSchema.boolean(),
            config: s.controlPlaneConfig,
            issues: s.jsonSchema.array(s.validationIssue),
          }),
        }),
      ),
      createDiffCommandContract(
        defineContractMetadata({
          command: "diff",
          catalogOrder: 38,
          mutability: "read",
          input: s.verificationInput(),
          bindings: s.verificationBindings(),
          output: s.diffOutput,
        }),
      ),
      createVerifyCommandContract(
        defineContractMetadata({
          command: "verify",
          catalogOrder: 39,
          mutability: "read",
          input: s.verificationInput(),
          bindings: s.verificationBindings(),
          output: s.verifyOutput,
        }),
      ),
      createSummaryCommandContract(
        defineContractMetadata({
          command: "summary",
          catalogOrder: 40,
          mutability: "read",
          input: s.jsonSchema.object({
            ...s.verificationProperties(),
            activityLimit: s.jsonSchema.integer(),
            includePlanCoverage: s.jsonSchema.boolean(),
          }),
          bindings: [
            ...s.verificationBindings(),
            s.option("activityLimit", "limit", s.stringify),
            s.option("includePlanCoverage"),
          ],
          output: s.summaryOutput,
        }),
      ),
      createPlanCommandContract(
        defineContractMetadata({
          command: "plan",
          catalogOrder: 45,
          mutability: "read",
          requiredFeatures: ["mutation-authority", "plan-apply", "exact-resource-selector"],
          input: s.jsonSchema.object(
            {
              agents: s.stringArray,
              scope: s.scope,
              dir: s.jsonSchema.string({ minLength: 1 }),
              collections: s.stringArray,
              capabilities: s.capabilityArray,
              method: s.jsonSchema.enumeration(["symlink", "copy"]),
              mcpStrategy: s.jsonSchema.enumeration(["merge", "overwrite"]),
            },
            ["agents"],
          ),
          bindings: [
            s.option("agents", "agent", s.joinList),
            s.option("scope"),
            s.option("dir"),
            s.option("collections", "collection", s.joinList),
            ...s.capabilityBindings(),
            s.option("method"),
            s.option("mcpStrategy"),
          ],
          output: s.dataObject(["plan", "preview"], {
            plan: s.distributionMutationPlan,
            preview: s.distributePlan,
          }),
        }),
      ),
      createOperationListCommandContract(
        defineContractMetadata({
          command: "operation.list",
          catalogOrder: 42,
          mutability: "read",
          input: s.jsonSchema.object({ limit: s.jsonSchema.integer() }),
          bindings: [s.option("limit", undefined, s.stringify)],
          output: s.dataObject(["operations"], {
            operations: s.jsonSchema.array(s.operationSummary),
          }),
        }),
      ),
      createOperationShowCommandContract(
        defineContractMetadata({
          command: "operation.show",
          catalogOrder: 43,
          mutability: "read",
          input: s.jsonSchema.object({ operationId: s.jsonSchema.string({ minLength: 1 }) }, [
            "operationId",
          ]),
          bindings: [s.positional("operationId", 0)],
          output: s.dataObject(["operation"], {
            operation: s.nullableObject(s.operationDetail),
          }),
        }),
      ),
    ],
  });
}

function requireCatalog(catalog: CommandCatalog | undefined): CommandCatalog {
  if (!catalog) throw new TypeError("CLI command catalog is not composed");
  return catalog;
}
