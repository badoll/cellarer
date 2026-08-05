import { Command } from "commander";
import { safeConsole as console } from "../output.js";
import { getCliCapabilities, getProtocolSchemaBundle } from "../protocol/command-registry.js";
import { commandSuccess, executeCliCommand } from "../protocol/execution.js";
import { CliInputError } from "../protocol/input.js";

export function capabilitiesCommand(): Command {
  return new Command("capabilities")
    .description("列出本地 CLI 协议版本、命令特征与 schema 标识符")
    .action(async (_opts: object, command: Command) => {
      await executeCliCommand(
        command,
        async () => commandSuccess(getCliCapabilities()),
        (outcome) => {
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
      );
    });
}

export function schemaCommand(): Command {
  return new Command("schema")
    .description("输出指定 CLI JSON Schema；省略标识符时输出本地 schema bundle")
    .argument("[schema-id]", "capabilities 报告的 schema 标识符")
    .action(async (schemaId: string | undefined, _opts: object, command: Command) => {
      await executeCliCommand(
        command,
        async (execution) => {
          const bundle = getProtocolSchemaBundle(schemaId);
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
        (outcome) => {
          if (!outcome.ok) return;
          console.log(
            outcome.data.schemas.length === 1 ? outcome.data.schemas[0]?.schema : outcome.data,
          );
        },
      );
    });
}
