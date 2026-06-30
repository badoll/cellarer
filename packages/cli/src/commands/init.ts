import { join } from "node:path";
import { createRealEnv, resolveStoreRoot } from "@cellarer/core";
import { Command } from "commander";

// 初始化库房:建 ~/.cellarer/store/{rules} 骨架 + 空 cellarer.toml。
export function initCommand(): Command {
  return new Command("init")
    .description("初始化库房(全局)")
    .option("--global", "初始化全局库房(默认)")
    .action(async () => {
      const env = createRealEnv();
      const storeRoot = resolveStoreRoot(env);
      await env.fs.mkdir(join(storeRoot, "store", "rules"), { recursive: true });
      await env.fs.mkdir(join(storeRoot, "adapters"), { recursive: true });
      const tomlPath = join(storeRoot, "cellarer.toml");
      try {
        await env.fs.readFile(tomlPath);
      } catch {
        await env.fs.writeFile(
          tomlPath,
          `# cellarer 库房配置
[defaults]
method = "symlink"
channels = ["common"]
secret_mode = "env"

[defaults.os.win32]
method = "copy"

[channels.common]
description = "通用"
`,
        );
      }
      console.log(`库房已初始化:${storeRoot}`);
    });
}
