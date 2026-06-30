import { createRealEnv, initStore, resolveStoreRoot } from "@cellarer/core";
import { Command } from "commander";

// 初始化库房:委托给 core initStore(不变量 1:CLI 不写 fs 业务逻辑)。
export function initCommand(): Command {
  return new Command("init")
    .description("初始化库房(全局)")
    .option("--global", "初始化全局库房(默认)")
    .action(async () => {
      const env = createRealEnv();
      const result = await initStore(env, resolveStoreRoot(env));
      const note = result.createdConfig ? "" : "(cellarer.toml 已存在,保留)";
      console.log(`库房已初始化:${result.storeRoot} ${note}`.trimEnd());
    });
}
