import { readFileSync } from "node:fs";
import process from "node:process";
import {
  deleteStoredSecret,
  listStoredSecretNames,
  type PresentedOperationResult,
  type StoredSecretProvider,
  setStoredSecret,
} from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { safeConsole as console } from "../output.js";
import {
  cliErrorFromOperation,
  commandFailure,
  commandSuccess,
  executeCliCommand,
  publicOperationResult,
} from "../protocol/execution.js";
import { CliInputError, type CliInvocation } from "../protocol/input.js";
import { PROTECTED_DESCRIPTOR_MAX, PROTECTED_DESCRIPTOR_MIN } from "../protocol/schemas.js";

// 密钥管理子命令(密钥分层第 3 层 age vault;见计划 §10)。
// 安全红线:ls 只列名不列值;真值只进 vault(加密落盘),绝不打印/绝不入库房资源。
interface SecretOpts {
  passphraseFd?: string;
  provider?: string;
  stdin?: boolean;
  fd?: string;
}

export interface SecretInputIo {
  readonly isInteractive: boolean;
  readonly readDescriptor: (fd: number) => Promise<string>;
  readonly readHidden: (confirm: boolean) => Promise<string>;
}

export interface ProtectedInputOptions {
  readonly nonInteractive?: boolean;
  readonly invocation?: CliInvocation;
}

export interface ProtectedDescriptorOptions {
  readonly field: string;
  readonly label: string;
  readonly invocation?: CliInvocation;
}

interface SecretMutationData {
  readonly provider: StoredSecretProvider;
  readonly name: string;
  readonly operation: PresentedOperationResult;
}

export function secretCommand(): Command {
  const cmd = new Command("secret").description("密钥管理(age vault;ls 只列名不列值)");

  // add <name>:值仅可来自 hidden TTY、stdin 或继承描述符，绝不进入 argv。
  cmd
    .command("add [name]")
    .description("新增/更新一个密钥(真值加密入 vault,绝不打印)")
    .option("--provider <provider>", "存储提供方:vault(默认)|keychain", "vault")
    .option("--stdin", "从标准输入读取密钥值")
    .option("--fd <number>", "从继承的文件描述符读取密钥值")
    .option("--passphrase-fd <number>", "从继承的文件描述符读取 vault 口令")
    .action(async (name: string | undefined, opts: SecretOpts, command: Command) => {
      await executeCliCommand(
        command,
        async (execution) => {
          const invocation = execution.invocation;
          const requiredName = requireSecretName(name, invocation);
          const provider = resolveProvider(opts.provider, invocation);
          const protectedOptions = { nonInteractive: invocation.nonInteractive, invocation };
          const plaintext = await readProtectedSecretInput(opts, undefined, protectedOptions);
          const vaultPassphrase =
            provider === "vault"
              ? await readProtectedPassphraseInput(opts.passphraseFd, undefined, protectedOptions)
              : undefined;
          const { env, storeRoot } = await resolveContext({}, "required");
          const result = await setStoredSecret(env, storeRoot, {
            provider,
            name: requiredName,
            value: plaintext,
            ...(provider === "vault" ? { vaultPassphrase } : {}),
          });
          const data: SecretMutationData = {
            provider: result.provider,
            name: result.name,
            operation: publicOperationResult(result.operation),
          };
          const error = cliErrorFromOperation(result.operation);
          return error ? commandFailure(error, data, [], result) : commandSuccess(data, [], result);
        },
        (outcome) => {
          if (!outcome.data) return;
          if (outcome.ok) {
            console.log(
              `✓ 已写入密钥 "${outcome.data.name}"(${outcome.data.provider},未回显真值)。`,
            );
          } else {
            console.error(outcome.error.message);
          }
        },
      );
    });

  // ls:只列引用名,绝不列值。
  cmd
    .command("ls")
    .description("列出 vault 中的密钥引用名(不显示真值)")
    .option("--passphrase-fd <number>", "从继承的文件描述符读取 vault 口令")
    .action(async (opts: SecretOpts, command: Command) => {
      await executeCliCommand(
        command,
        async (execution) => {
          const invocation = execution.invocation;
          const passphrase = await readProtectedPassphraseInput(opts.passphraseFd, undefined, {
            nonInteractive: invocation.nonInteractive,
            invocation,
          });
          const { env, storeRoot } = await resolveContext({});
          const names = await listStoredSecretNames(env, storeRoot, {
            provider: "vault",
            vaultPassphrase: passphrase,
          });
          return commandSuccess({ names });
        },
        (outcome) => {
          if (!outcome.ok) return;
          if (outcome.data.names.length === 0) {
            console.log("vault 为空。");
            return;
          }
          console.log("密钥引用名:");
          for (const name of outcome.data.names) console.log(`  ${name}`);
        },
      );
    });

  // rm <name>:删除一个密钥。
  cmd
    .command("rm [name]")
    .description("删除一个密钥")
    .option("--provider <provider>", "存储提供方:vault(默认)|keychain", "vault")
    .option("--passphrase-fd <number>", "从继承的文件描述符读取 vault 口令")
    .action(async (name: string | undefined, opts: SecretOpts, command: Command) => {
      await executeCliCommand(
        command,
        async (execution) => {
          const invocation = execution.invocation;
          const requiredName = requireSecretName(name, invocation);
          const provider = resolveProvider(opts.provider, invocation);
          const vaultPassphrase =
            provider === "vault"
              ? await readProtectedPassphraseInput(opts.passphraseFd, undefined, {
                  nonInteractive: invocation.nonInteractive,
                  invocation,
                })
              : undefined;
          const { env, storeRoot } = await resolveContext({}, "required");
          const result = await deleteStoredSecret(env, storeRoot, {
            provider,
            name: requiredName,
            ...(provider === "vault" ? { vaultPassphrase } : {}),
          });
          const data: SecretMutationData = {
            provider: result.provider,
            name: result.name,
            operation: publicOperationResult(result.operation),
          };
          const error = cliErrorFromOperation(result.operation);
          return error ? commandFailure(error, data, [], result) : commandSuccess(data, [], result);
        },
        (outcome) => {
          if (!outcome.data) return;
          if (outcome.ok) {
            console.log(`✓ 已删除密钥 "${outcome.data.name}"(${outcome.data.provider})。`);
          } else {
            console.error(outcome.error.message);
          }
        },
      );
    });

  return cmd;
}

export async function readProtectedSecretInput(
  opts: Pick<SecretOpts, "stdin" | "fd">,
  io: SecretInputIo = defaultSecretInputIo(),
  options: ProtectedInputOptions = {},
): Promise<string> {
  const selectedChannels = Number(opts.stdin === true) + Number(opts.fd !== undefined);
  if (selectedChannels > 1) {
    throw new CliInputError(
      "INPUT_AMBIGUITY",
      "select exactly one secret input channel: --stdin or --fd",
      { fields: ["stdin", "fd"] },
      options.invocation,
    );
  }
  let value: string;
  if (opts.stdin) {
    value = await io.readDescriptor(0);
  } else if (opts.fd !== undefined) {
    const fd = Number(opts.fd);
    if (
      !Number.isSafeInteger(fd) ||
      fd < PROTECTED_DESCRIPTOR_MIN ||
      fd > PROTECTED_DESCRIPTOR_MAX
    ) {
      throw new CliInputError(
        "INVALID_INPUT",
        `--fd must name an inherited descriptor numbered from ${PROTECTED_DESCRIPTOR_MIN} through ${PROTECTED_DESCRIPTOR_MAX}`,
        { fields: ["fd"] },
        options.invocation,
      );
    }
    try {
      value = await io.readDescriptor(fd);
    } catch (error) {
      if (!isExpectedDescriptorReadError(error)) throw error;
      throw new CliInputError(
        "INVALID_INPUT",
        "unable to read secret value from inherited descriptor",
        { fields: ["fd"] },
        options.invocation,
      );
    }
  } else {
    if (options.nonInteractive || !io.isInteractive) {
      throw new CliInputError(
        "INPUT_REQUIRED",
        "non-interactive secret input requires --stdin or --fd",
        { fields: ["stdin|fd"] },
        options.invocation,
      );
    }
    value = await io.readHidden(true);
  }
  const normalized = stripSingleLineTerminator(value);
  if (normalized.length === 0) {
    throw new CliInputError(
      "INVALID_INPUT",
      "secret value must not be empty",
      undefined,
      options.invocation,
    );
  }
  return normalized;
}

export async function readProtectedPassphraseInput(
  fdOption: string | undefined,
  io: SecretInputIo = defaultSecretInputIo(),
  options: ProtectedInputOptions = {},
): Promise<string> {
  let value: string;
  if (fdOption !== undefined) {
    return readProtectedDescriptorInput(
      fdOption,
      { field: "passphraseFd", label: "passphrase", invocation: options.invocation },
      io,
    );
  } else {
    if (options.nonInteractive || !io.isInteractive) {
      throw new CliInputError(
        "INPUT_REQUIRED",
        "non-interactive passphrase input requires an inherited descriptor",
        { fields: ["passphraseFd"] },
        options.invocation,
      );
    }
    value = await io.readHidden(false);
  }
  const normalized = stripSingleLineTerminator(value);
  if (normalized.length === 0) {
    throw new CliInputError(
      "INVALID_INPUT",
      "passphrase must not be empty",
      undefined,
      options.invocation,
    );
  }
  return normalized;
}

export async function readProtectedDescriptorInput(
  fdOption: string,
  options: ProtectedDescriptorOptions,
  io: SecretInputIo = defaultSecretInputIo(),
): Promise<string> {
  const fd = Number(fdOption);
  if (!Number.isSafeInteger(fd) || fd < PROTECTED_DESCRIPTOR_MIN || fd > PROTECTED_DESCRIPTOR_MAX) {
    throw new CliInputError(
      "INVALID_INPUT",
      `${options.label} fd must name an inherited descriptor numbered from ${PROTECTED_DESCRIPTOR_MIN} through ${PROTECTED_DESCRIPTOR_MAX}`,
      { fields: [options.field] },
      options.invocation,
    );
  }
  let value: string;
  try {
    value = await io.readDescriptor(fd);
  } catch (error) {
    if (!isExpectedDescriptorReadError(error)) throw error;
    throw new CliInputError(
      "INVALID_INPUT",
      `unable to read ${options.label} from inherited descriptor`,
      { fields: [options.field] },
      options.invocation,
    );
  }
  const normalized = stripSingleLineTerminator(value);
  if (normalized.length === 0) {
    throw new CliInputError(
      "INVALID_INPUT",
      `${options.label} must not be empty`,
      { fields: [options.field] },
      options.invocation,
    );
  }
  return normalized;
}

function defaultSecretInputIo(): SecretInputIo {
  return {
    isInteractive: process.stdin.isTTY === true && process.stderr.isTTY === true,
    readDescriptor: async (fd) => readFileSync(fd, "utf8"),
    readHidden: readHiddenSecret,
  };
}

async function readHiddenSecret(confirm: boolean): Promise<string> {
  const first = await readHiddenLine("Secret value: ");
  if (!confirm) return first;
  const second = await readHiddenLine("Confirm secret value: ");
  if (first !== second) throw new Error("secret values do not match");
  return first;
}

async function readHiddenLine(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("hidden secret input requires an interactive terminal");
  }
  process.stderr.write(prompt);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;
    const wasPaused = input.isPaused();
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(Boolean(wasRaw));
      if (wasPaused) input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString()) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003") {
          finish(new Error("secret input cancelled"));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

function stripSingleLineTerminator(value: string): string {
  return value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
}

function isExpectedDescriptorReadError(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return (
    typeof code === "string" &&
    ["EACCES", "EBADF", "EINVAL", "EIO", "EISDIR", "ENXIO", "ESPIPE"].includes(code)
  );
}

function resolveProvider(
  value: string | undefined,
  invocation: CliInvocation,
): StoredSecretProvider {
  if (value === undefined || value === "vault") return "vault";
  if (value === "keychain") return "keychain";
  throw new CliInputError(
    "INVALID_INPUT",
    "Invalid provider; expected vault or keychain",
    { fields: ["provider"] },
    invocation,
  );
}

function requireSecretName(value: string | undefined, invocation: CliInvocation): string {
  if (value) return value;
  throw new CliInputError(
    "INPUT_REQUIRED",
    invocation.nonInteractive
      ? "non-interactive secret command requires a name"
      : "secret name is required",
    { fields: ["name"] },
    invocation,
  );
}
