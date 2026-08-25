import { createReadStream } from "node:fs";
import { startServer, WEB_CLIENT_ASSET_ROOT } from "@cellarer/web";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { safeConsole as console } from "../output.js";
import {
  type CommandContractMetadata,
  defineCommandContract,
} from "../protocol/command-contract.js";
import { commandSuccess } from "../protocol/execution.js";
import { CliInputError, type CliInvocation } from "../protocol/input.js";
import { PROTECTED_DESCRIPTOR_MAX, PROTECTED_DESCRIPTOR_MIN } from "../protocol/schemas.js";
import { readProtectedDescriptorInput } from "./secret.js";

interface UiOpts {
  readonly port?: string;
  readonly tokenFd?: string;
  readonly lifetimeFd?: string;
}

type UiCommandData = Awaited<ReturnType<typeof startServer>>["ready"];

// 启动本地 Web UI(仅 127.0.0.1)。静态 SPA 取 @cellarer/web 包内 client/dist。
export function createUiCommandContract(definition: CommandContractMetadata<"ui">) {
  return defineCommandContract<"ui", UiOpts, UiCommandData>(definition, {
    createCommand: () =>
      new Command("ui")
        .description("启动本地 Web UI(仅监听 127.0.0.1)")
        .option("--port <port>", "端口(默认 4317)")
        .option("--token-fd <number>", "从继承的文件描述符读取访问 token")
        .option("--lifetime-fd <number>", "由继承的所有权描述符 EOF 触发关闭"),
    normalize: ({ command }) => command.opts<UiOpts>(),
    execute: async (opts, execution) => {
      let port: number | undefined;
      if (opts.port !== undefined) {
        const candidate = Number(opts.port);
        if (
          !/^(0|[1-9][0-9]*)$/.test(opts.port) ||
          !Number.isSafeInteger(candidate) ||
          candidate < 0 ||
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
      const lifetimeFd = parseLifetimeDescriptor(opts.lifetimeFd, execution.invocation);
      if (opts.tokenFd !== undefined && Number(opts.tokenFd) === lifetimeFd) {
        throw new CliInputError(
          "INPUT_AMBIGUITY",
          "token and lifetime channels must use different inherited descriptors",
          { fields: ["tokenFd", "lifetimeFd"] },
          execution.invocation,
        );
      }
      const lifetime =
        lifetimeFd === undefined
          ? undefined
          : createReadStream("", { fd: lifetimeFd, autoClose: true });
      const { env: composedEnv, storeRoot } = await resolveContext({});
      const { secretStore: _secretStore, ...env } = composedEnv;
      const handle = await startServer({
        port,
        auth: token ? { mode: "bearer", token } : { mode: "browser-session" },
        staticRoot: WEB_CLIENT_ASSET_ROOT,
        env,
        storeRoot,
        lifetime,
      });
      installSignalShutdown(handle.close, handle.closed);
      return commandSuccess(handle.ready);
    },
    presentText: (outcome, opts) => {
      if (!outcome.ok) return;
      console.log(`cellarer UI: ${outcome.data.baseUrl}`);
      if (opts.tokenFd) console.log("(已启用访问 token)");
      console.log("Ctrl-C 退出。");
    },
    mapError: () => undefined,
  });
}

function parseLifetimeDescriptor(
  value: string | undefined,
  invocation: CliInvocation,
): number | undefined {
  if (value === undefined) return undefined;
  const fd = Number(value);
  if (!Number.isSafeInteger(fd) || fd < PROTECTED_DESCRIPTOR_MIN || fd > PROTECTED_DESCRIPTOR_MAX) {
    throw new CliInputError(
      "INVALID_INPUT",
      `lifetime fd must name an inherited descriptor numbered from ${PROTECTED_DESCRIPTOR_MIN} through ${PROTECTED_DESCRIPTOR_MAX}`,
      { fields: ["lifetimeFd"] },
      invocation,
    );
  }
  return fd;
}

export interface ShutdownSignalSource {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export function installSignalShutdown(
  close: () => Promise<void>,
  closed: Promise<void>,
  signalSource: ShutdownSignalSource = process,
): void {
  const shutdown = () => {
    void close();
  };
  signalSource.once("SIGINT", shutdown);
  signalSource.once("SIGTERM", shutdown);
  void closed.finally(() => {
    signalSource.off("SIGINT", shutdown);
    signalSource.off("SIGTERM", shutdown);
  });
}
