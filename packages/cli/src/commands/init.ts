import { initializeStore } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { safeConsole as console } from "../output.js";

// 初始化库房:委托给 core 并发安全 initializer(不变量 1:CLI 不写 fs 业务逻辑)。
export function initCommand(): Command {
  return new Command("init")
    .description("初始化库房(全局)")
    .option("--global", "初始化全局库房(默认)")
    .action(async () => {
      const { env, storeRoot } = await resolveContext({}, "provision");
      const result = await initializeStore(env, storeRoot);
      const note = result.createdConfig ? "" : " (config.json 已存在,保留)";
      if (!result.operation.ok) throw new Error("initializer returned without a committed receipt");
      console.log(
        `库房已初始化:${result.storeRoot}${note} (operation ${result.operation.receipt.operationId}, revision ${result.operation.receipt.resultingRevision})`,
      );
    });
}
