import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { startServer } from "@cellarer/web";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { safeConsole as console } from "../output.js";

interface UiOpts {
  port?: string;
  token?: string;
}

// 启动本地 Web UI(仅 127.0.0.1)。静态 SPA 取 @cellarer/web 包内 client/dist。
export function uiCommand(): Command {
  return new Command("ui")
    .description("启动本地 Web UI(仅监听 127.0.0.1)")
    .option("--port <port>", "端口(默认 4317)")
    .option("--token <token>", "访问 token(设置后 API 需 Bearer 校验)")
    .action(async (opts: UiOpts) => {
      const port = opts.port ? Number.parseInt(opts.port, 10) : undefined;
      if (opts.port && Number.isNaN(port)) {
        console.error(`无效 --port "${opts.port}"`);
        process.exitCode = 1;
        return;
      }
      // 解析 @cellarer/web 包目录 → client/dist(SPA 产物)。
      const require = createRequire(import.meta.url);
      const webPkg = require.resolve("@cellarer/web/package.json");
      const staticRoot = join(dirname(webPkg), "client", "dist");

      const { env: composedEnv, storeRoot } = await resolveContext({});
      const { secretStore: _secretStore, ...env } = composedEnv;
      const { port: actual } = startServer({
        port,
        token: opts.token,
        staticRoot,
        env,
        storeRoot,
      });
      console.log(`cellarer UI: http://127.0.0.1:${actual}`);
      if (opts.token) console.log("(已启用访问 token)");
      console.log("Ctrl-C 退出。");
    });
}
