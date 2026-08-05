import { initializeStore } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { safeConsole as console } from "../output.js";
import { commandSuccess, executeCliCommand, publicOperationResult } from "../protocol/execution.js";

// 初始化库房:委托给 core 并发安全 initializer(不变量 1:CLI 不写 fs 业务逻辑)。
export function initCommand(): Command {
  return new Command("init")
    .description("初始化库房(全局)")
    .option("--global", "初始化全局库房(默认)")
    .action(async (_opts: { global?: boolean }, command: Command) => {
      await executeCliCommand(
        command,
        async () => {
          const { env, storeRoot } = await resolveContext({}, "provision");
          const result = await initializeStore(env, storeRoot);
          return commandSuccess({
            storeRoot: result.storeRoot,
            createdConfig: result.createdConfig,
            operation: publicOperationResult(result.operation),
          });
        },
        (outcome) => {
          if (!outcome.ok) return;
          const note = outcome.data.createdConfig ? "" : " (config.json 已存在,保留)";
          if (!outcome.data.operation.ok) return;
          console.log(
            `库房已初始化:${outcome.data.storeRoot}${note} (operation ${outcome.data.operation.receipt.operationId}, revision ${outcome.data.operation.receipt.resultingRevision})`,
          );
        },
      );
    });
}
