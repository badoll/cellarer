import type { resolveContext } from "../context.js";
import {
  type CommandDomain,
  defineCommandDomain,
  defineContractMetadata,
} from "../protocol/command-contract.js";
import { commandSchemaFragments as s } from "../protocol/command-schema-fragments.js";
import { createDiscoverySummaryCommandContract } from "./control-plane-read.js";
import {
  createCapabilitiesCommandContract,
  createSchemaCommandContract,
  type ProtocolDiscoveryProvider,
} from "./discovery.js";
import type { InitInventoryImportConfirmer } from "./init.js";
import { createInitCommandContract } from "./init.js";
import { createScanCommandContract } from "./scan.js";

export function createInitializationDiscoveryDomain(
  options: {
    readonly initInventoryImportConfirmer?: InitInventoryImportConfirmer;
    readonly scanContextResolver?: typeof resolveContext;
  },
  provider: ProtocolDiscoveryProvider,
): CommandDomain {
  return defineCommandDomain({
    id: "initialization-discovery",
    contracts: [
      createInitCommandContract(
        defineContractMetadata({
          command: "init",
          catalogOrder: 0,
          mutability: "write",
          requiredFeatures: [
            "mutation-authority",
            "unified-resource-inventory",
            "inventory-store-import",
          ],
          input: s.jsonSchema.object({
            global: s.jsonSchema.boolean(),
            dryRun: s.jsonSchema.boolean(),
          }),
          bindings: [s.option("global"), s.option("dryRun")],
          output: {
            oneOf: [
              s.dataObject(["dryRun", "storeRoot"], {
                dryRun: { const: true },
                storeRoot: s.jsonSchema.string(),
              }),
              s.dataObject(["store", "inventory", "confirmation", "import"], {
                store: s.dataObject(["storeRoot", "createdConfig", "operation"], {
                  storeRoot: s.jsonSchema.string(),
                  createdConfig: s.jsonSchema.boolean(),
                  operation: s.presentedOperationResult,
                }),
                inventory: s.inventoryRefreshOutput,
                confirmation: {
                  oneOf: [
                    s.dataObject(["status", "candidateIds", "reason"], {
                      status: { const: "not-offered" },
                      candidateIds: s.stringArray,
                      reason: s.jsonSchema.enumeration([
                        "inventory-incomplete",
                        "no-ready-candidates",
                        "non-interactive",
                      ]),
                    }),
                    s.dataObject(["status", "candidateIds"], {
                      status: { const: "declined" },
                      candidateIds: s.stringArray,
                    }),
                    s.dataObject(["status", "candidateIds"], {
                      status: { const: "confirmed" },
                      candidateIds: s.stringArray,
                    }),
                  ],
                },
                import: {
                  oneOf: [
                    s.dataObject(["status"], { status: { const: "not-started" } }),
                    s.dataObject(["status", "error"], {
                      status: { const: "failed" },
                      error: s.dataObject(["code", "reason"], {
                        code: s.jsonSchema.string({ minLength: 1 }),
                        reason: s.jsonSchema.string({ minLength: 1 }),
                      }),
                    }),
                    s.dataObject(
                      ["status", "candidateIds", "resourceIds", "operation", "warnings"],
                      {
                        status: { const: "applied" },
                        candidateIds: s.stringArray,
                        resourceIds: s.stringArray,
                        operation: s.presentedOperationResult,
                        warnings: s.stringArray,
                      },
                    ),
                  ],
                },
              }),
            ],
          },
        }),
        options.initInventoryImportConfirmer,
      ),
      createScanCommandContract(
        defineContractMetadata({
          command: "scan",
          catalogOrder: 6,
          mutability: "write",
          streaming: true,
          requiredFeatures: ["mutation-authority", "protected-secret-channel"],
          input: s.jsonSchema.object(
            {
              agent: s.jsonSchema.string({ minLength: 1 }),
              dir: s.jsonSchema.string({ minLength: 1 }),
              capabilities: s.capabilityArray,
              intoCollection: s.jsonSchema.string({ minLength: 1 }),
              conflict: s.jsonSchema.enumeration(["keep-theirs", "keep-mine", "copy"]),
              select: s.jsonSchema.array(s.exactResourceSelector),
              dryRun: s.jsonSchema.boolean(),
              secretMode: s.secretMode,
              vaultPassphraseFd: s.jsonSchema.integer(
                s.PROTECTED_DESCRIPTOR_MIN,
                s.PROTECTED_DESCRIPTOR_MAX,
              ),
              keychainService: s.jsonSchema.string({ minLength: 1 }),
            },
            ["agent"],
          ),
          bindings: [
            s.option("agent"),
            s.option("dir"),
            ...s.capabilityBindings(),
            s.option("intoCollection"),
            s.option("conflict"),
            s.option("select", undefined, s.stringifyJson),
            s.option("dryRun"),
            s.option("secretMode"),
            s.option("vaultPassphraseFd", undefined, s.stringify),
            s.option("keychainService"),
          ],
          output: s.dataObject(["plan", "imported"], {
            plan: s.scanPlan,
            imported: s.jsonSchema.array(s.scanItem),
            operation: s.presentedOperationResult,
          }),
          event: s.progressEvent,
        }),
        options.scanContextResolver,
      ),
      createCapabilitiesCommandContract(
        defineContractMetadata({
          command: "capabilities",
          catalogOrder: 14,
          mutability: "read",
          input: s.jsonSchema.object(),
          bindings: [],
          output: s.jsonSchema.object(
            {
              protocolVersions: s.stringArray,
              commands: s.jsonSchema.array(s.commandCapability),
            },
            ["protocolVersions", "commands"],
          ),
        }),
        provider,
      ),
      createSchemaCommandContract(
        defineContractMetadata({
          command: "schema",
          catalogOrder: 15,
          mutability: "read",
          input: s.jsonSchema.object({ schemaId: s.jsonSchema.string({ minLength: 1 }) }),
          bindings: [s.positional("schemaId", 0)],
          output: s.jsonSchema.object(
            {
              bundleVersion: { const: 1 },
              protocolVersion: { const: s.CLI_PROTOCOL_VERSION },
              schemas: s.jsonSchema.array(s.protocolSchemaEntry),
            },
            ["bundleVersion", "protocolVersion", "schemas"],
          ),
        }),
        provider,
      ),
      createDiscoverySummaryCommandContract(
        defineContractMetadata({
          command: "discovery.summary",
          catalogOrder: 41,
          mutability: "read",
          input: s.jsonSchema.object(
            {
              destination: s.destination,
              dir: s.jsonSchema.string({ minLength: 1 }),
              agents: s.stringArray,
            },
            ["destination"],
          ),
          bindings: [
            s.option("destination"),
            s.option("dir"),
            s.option("agents", "agent", s.joinList),
          ],
          output: s.discoverySummaryOutput,
        }),
      ),
    ],
  });
}
