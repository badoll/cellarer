import {
  type CommandDomain,
  defineCommandDomain,
  defineContractMetadata,
} from "../protocol/command-contract.js";
import { commandSchemaFragments as s } from "../protocol/command-schema-fragments.js";
import {
  createCapabilitiesCommandContract,
  createSchemaCommandContract,
  type ProtocolDiscoveryProvider,
} from "./discovery.js";
import type { InitInventoryImportConfirmer } from "./init.js";
import { createInitCommandContract } from "./init.js";

export function createInitializationDiscoveryDomain(
  options: {
    readonly initInventoryImportConfirmer?: InitInventoryImportConfirmer;
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
    ],
  });
}
