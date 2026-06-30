import { createRealEnv, loadVault, resolveStoreRoot, saveVault } from "@cellarer/core";
import { Command } from "commander";

// 密钥管理子命令(密钥分层第 3 层 age vault;见计划 §10)。
// 安全红线:ls 只列名不列值;真值只进 vault(加密落盘),绝不打印/绝不入库房制品。
// 注:口令经 --passphrase 传入(或环境变量 CELLARER_VAULT_PASSPHRASE);v1 不做交互式 TTY 读取。
interface SecretOpts {
  passphrase?: string;
}

function resolvePassphrase(opts: SecretOpts, env: Record<string, string | undefined>): string {
  const pp = opts.passphrase ?? env.CELLARER_VAULT_PASSPHRASE;
  if (!pp || pp.length === 0) {
    throw new Error("需要 vault 口令:--passphrase <pp> 或环境变量 CELLARER_VAULT_PASSPHRASE");
  }
  return pp;
}

export function secretCommand(): Command {
  const cmd = new Command("secret").description("密钥管理(age vault;ls 只列名不列值)");

  // add <name> <value>:写入一个密钥真值(加密)。
  cmd
    .command("add <name> <value>")
    .description("新增/更新一个密钥(真值加密入 vault,绝不打印)")
    .option("--passphrase <pp>", "vault 口令")
    .action(async (name: string, value: string, opts: SecretOpts) => {
      const env = createRealEnv();
      const storeRoot = resolveStoreRoot(env);
      const pp = resolvePassphrase(opts, env.env);
      const data = await loadVault(env, storeRoot, pp);
      data[name] = value;
      await saveVault(env, storeRoot, data, pp);
      console.log(`✓ 已写入密钥 "${name}"(真值已加密,未回显)。`);
    });

  // ls:只列引用名,绝不列值。
  cmd
    .command("ls")
    .description("列出 vault 中的密钥引用名(不显示真值)")
    .option("--passphrase <pp>", "vault 口令")
    .action(async (opts: SecretOpts) => {
      const env = createRealEnv();
      const storeRoot = resolveStoreRoot(env);
      const pp = resolvePassphrase(opts, env.env);
      const data = await loadVault(env, storeRoot, pp);
      const names = Object.keys(data).sort();
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
    .option("--passphrase <pp>", "vault 口令")
    .action(async (name: string, opts: SecretOpts) => {
      const env = createRealEnv();
      const storeRoot = resolveStoreRoot(env);
      const pp = resolvePassphrase(opts, env.env);
      const data = await loadVault(env, storeRoot, pp);
      if (!(name in data)) {
        console.log(`vault 中无密钥 "${name}"。`);
        return;
      }
      delete data[name];
      await saveVault(env, storeRoot, data, pp);
      console.log(`✓ 已删除密钥 "${name}"。`);
    });

  return cmd;
}
