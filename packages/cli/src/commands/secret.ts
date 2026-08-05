import { readFileSync } from "node:fs";
import process from "node:process";
import {
  deleteStoredSecret,
  listStoredSecretNames,
  type StoredSecretProvider,
  setStoredSecret,
} from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { safeConsole as console } from "../output.js";

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

export function secretCommand(): Command {
  const cmd = new Command("secret").description("密钥管理(age vault;ls 只列名不列值)");

  // add <name>:值仅可来自 hidden TTY、stdin 或继承描述符，绝不进入 argv。
  cmd
    .command("add <name>")
    .description("新增/更新一个密钥(真值加密入 vault,绝不打印)")
    .option("--provider <provider>", "存储提供方:vault(默认)|keychain", "vault")
    .option("--stdin", "从标准输入读取密钥值")
    .option("--fd <number>", "从继承的文件描述符读取密钥值")
    .option("--passphrase-fd <number>", "从继承的文件描述符读取 vault 口令")
    .action(async (name: string, opts: SecretOpts) => {
      const { env, storeRoot } = await resolveContext({}, "required");
      const provider = resolveProvider(opts.provider);
      const plaintext = await readProtectedSecretInput(opts);
      const result = await setStoredSecret(env, storeRoot, {
        provider,
        name,
        value: plaintext,
        ...(provider === "vault"
          ? { vaultPassphrase: await readProtectedPassphraseInput(opts.passphraseFd) }
          : {}),
      });
      assertSecretMutationCommitted(result.operation);
      console.log(`✓ 已写入密钥 "${name}"(${provider},未回显真值)。`);
    });

  // ls:只列引用名,绝不列值。
  cmd
    .command("ls")
    .description("列出 vault 中的密钥引用名(不显示真值)")
    .option("--passphrase-fd <number>", "从继承的文件描述符读取 vault 口令")
    .action(async (opts: SecretOpts) => {
      const { env, storeRoot } = await resolveContext({});
      const pp = await readProtectedPassphraseInput(opts.passphraseFd);
      const names = await listStoredSecretNames(env, storeRoot, {
        provider: "vault",
        vaultPassphrase: pp,
      });
      if (names.length === 0) {
        console.log("vault 为空。");
        return;
      }
      console.log("密钥引用名:");
      for (const n of names) console.log(`  ${n}`);
    });

  // rm <name>:删除一个密钥。
  cmd
    .command("rm <name>")
    .description("删除一个密钥")
    .option("--provider <provider>", "存储提供方:vault(默认)|keychain", "vault")
    .option("--passphrase-fd <number>", "从继承的文件描述符读取 vault 口令")
    .action(async (name: string, opts: SecretOpts) => {
      const { env, storeRoot } = await resolveContext({}, "required");
      const provider = resolveProvider(opts.provider);
      const result = await deleteStoredSecret(env, storeRoot, {
        provider,
        name,
        ...(provider === "vault"
          ? { vaultPassphrase: await readProtectedPassphraseInput(opts.passphraseFd) }
          : {}),
      });
      assertSecretMutationCommitted(result.operation);
      console.log(`✓ 已删除密钥 "${name}"(${provider})。`);
    });

  return cmd;
}

export async function readProtectedSecretInput(
  opts: Pick<SecretOpts, "stdin" | "fd">,
  io: SecretInputIo = defaultSecretInputIo(),
): Promise<string> {
  const selectedChannels = Number(opts.stdin === true) + Number(opts.fd !== undefined);
  if (selectedChannels > 1) {
    throw new Error("select exactly one secret input channel: --stdin or --fd");
  }
  let value: string;
  if (opts.stdin) {
    value = await io.readDescriptor(0);
  } else if (opts.fd !== undefined) {
    const fd = Number(opts.fd);
    if (!Number.isSafeInteger(fd) || fd < 3) {
      throw new Error("--fd must name an inherited descriptor numbered 3 or greater");
    }
    value = await io.readDescriptor(fd);
  } else {
    if (!io.isInteractive) {
      throw new Error("non-interactive secret input requires --stdin or --fd");
    }
    value = await io.readHidden(true);
  }
  const normalized = stripSingleLineTerminator(value);
  if (normalized.length === 0) throw new Error("secret value must not be empty");
  return normalized;
}

export async function readProtectedPassphraseInput(
  fdOption: string | undefined,
  io: SecretInputIo = defaultSecretInputIo(),
): Promise<string> {
  let value: string;
  if (fdOption !== undefined) {
    const fd = Number(fdOption);
    if (!Number.isSafeInteger(fd) || fd < 3) {
      throw new Error("passphrase fd must name an inherited descriptor numbered 3 or greater");
    }
    value = await io.readDescriptor(fd);
  } else {
    if (!io.isInteractive) {
      throw new Error("non-interactive passphrase input requires an inherited descriptor");
    }
    value = await io.readHidden(false);
  }
  const normalized = stripSingleLineTerminator(value);
  if (normalized.length === 0) throw new Error("passphrase must not be empty");
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

function resolveProvider(value: string | undefined): StoredSecretProvider {
  if (value === undefined || value === "vault") return "vault";
  if (value === "keychain") return "keychain";
  throw new Error(`无效 provider "${value}":仅支持 vault | keychain`);
}

function assertSecretMutationCommitted(
  operation: Awaited<ReturnType<typeof setStoredSecret>>["operation"],
): void {
  if (!operation.ok) throw new Error(operation.conflict.message);
}
