import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { startServer } from "@cellarer/web";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { safeConsole as console } from "../output.js";
import { commandSuccess, executeCliCommand } from "../protocol/execution.js";
import { CliInputError } from "../protocol/input.js";
import { readProtectedDescriptorInput } from "./secret.js";

interface UiOpts {
  port?: string;
  tokenFd?: string;
}

// 启动本地 Web UI(仅 127.0.0.1)。静态 SPA 取 @cellarer/web 包内 client/dist。
export function uiCommand(): Command {
  return new Command("ui")
    .description("启动本地 Web UI(仅监听 127.0.0.1)")
    .option("--port <port>", "端口(默认 4317)")
    .option("--token-fd <number>", "从继承的文件描述符读取访问 token")
    .action(async (opts: UiOpts, command: Command) => {
      await executeCliCommand(
        command,
        async (execution) => {
          let port: number | undefined;
          if (opts.port !== undefined) {
            const candidate = Number(opts.port);
            if (
              !/^[1-9][0-9]*$/.test(opts.port) ||
              !Number.isSafeInteger(candidate) ||
              candidate < 1 ||
              candidate > 65_535
            ) {
              throw new CliInputError(
                "INVALID_INPUT",
                "Invalid UI port",
                { fields: ["port"] },
                execution.invocation,
              );
            }
            port = candidate;
          }
          const token =
            opts.tokenFd === undefined
              ? undefined
              : await readProtectedDescriptorInput(opts.tokenFd, {
                  field: "tokenFd",
                  label: "UI token",
                  invocation: execution.invocation,
                });
          const require = createRequire(import.meta.url);
          const webPkg = require.resolve("@cellarer/web/package.json");
          const staticRoot = join(dirname(webPkg), "client", "dist");
          const { env: composedEnv, storeRoot } = await resolveContext({});
          const { secretStore: _secretStore, ...env } = composedEnv;
          const { port: actual } = startServer({
            port,
            token,
            staticRoot,
            env,
            storeRoot,
          });
          return commandSuccess({ url: `http://127.0.0.1:${actual}`, port: actual });
        },
        (outcome) => {
          if (!outcome.ok) return;
          console.log(`cellarer UI: ${outcome.data.url}`);
          if (opts.tokenFd) console.log("(已启用访问 token)");
          console.log("Ctrl-C 退出。");
        },
      );
    });
}
