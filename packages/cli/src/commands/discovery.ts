import { Command } from "commander";
import { safeConsole as console } from "../output.js";
import {
  type CommandContractMetadata,
  defineCommandContract,
} from "../protocol/command-contract.js";
import type { CliCapabilities, ProtocolSchemaBundle } from "../protocol/command-types.js";
import { commandSuccess } from "../protocol/execution.js";
import { CliInputError } from "../protocol/input.js";

export interface ProtocolDiscoveryProvider {
  getCapabilities(): CliCapabilities;
  getSchemaBundle(schemaId?: string): ProtocolSchemaBundle | undefined;
}

interface SchemaInput {
  readonly schemaId?: string;
}

export function createCapabilitiesCommandContract(
  definition: CommandContractMetadata<"capabilities">,
  provider: ProtocolDiscoveryProvider,
) {
  return defineCommandContract<"capabilities", undefined, CliCapabilities>(definition, {
    createCommand: () =>
      new Command("capabilities").description("列出本地 CLI 协议版本、命令特征与 schema 标识符"),
    normalize: () => undefined,
    execute: async () => commandSuccess(provider.getCapabilities()),
    presentText: (outcome) => {
      if (!outcome.ok) return;
      console.log(`protocol versions: ${outcome.data.protocolVersions.join(", ")}`);
      for (const capability of outcome.data.commands) {
        const streaming = capability.streaming ? "streaming" : "terminal";
        console.log(`${capability.command} (${capability.mutability}, ${streaming})`);
        console.log(`  input: ${capability.inputSchemaId}`);
        console.log(`  output: ${capability.outputSchemaId}`);
        if (capability.eventSchemaId) console.log(`  event: ${capability.eventSchemaId}`);
      }
    },
    mapError: () => undefined,
  });
}

export function createSchemaCommandContract(
  definition: CommandContractMetadata<"schema">,
  provider: ProtocolDiscoveryProvider,
) {
  return defineCommandContract<"schema", SchemaInput, ProtocolSchemaBundle>(definition, {
    createCommand: () =>
      new Command("schema")
        .description("输出指定 CLI JSON Schema；省略标识符时输出本地 schema bundle")
        .argument("[schema-id]", "capabilities 报告的 schema 标识符"),
    normalize: ({ actionArguments }) => ({
      schemaId: actionArguments[0] as string | undefined,
    }),
    execute: async ({ schemaId }, execution) => {
      const bundle = provider.getSchemaBundle(schemaId);
      if (bundle === undefined) {
        throw new CliInputError(
          "INVALID_INPUT",
          "Unknown CLI protocol schema identifier",
          { schemaId },
          execution.invocation,
        );
      }
      return commandSuccess(bundle);
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      console.log(
        outcome.data.schemas.length === 1 ? outcome.data.schemas[0]?.schema : outcome.data,
      );
    },
    mapError: () => undefined,
  });
}
