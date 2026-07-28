// age vault(age-encryption / typage,纯 JS 零 native;见计划 §10)。
// 库房 secrets/vault.age 存「引用名 → 真值」的加密 JSON;口令(scrypt)加密。
// age-encryption 是纯算法库(类比 node:crypto),不碰 fs/process,可在 core 直接 import;
// 文件读写仍走 Env(armor 文本形态,适配 Env 的 string-only fs)。
import { join } from "node:path";
import { armor, Decrypter, Encrypter } from "age-encryption";
import type { Env } from "../env.js";
import { readFileOrNull } from "../fs/probe.js";
import {
  executeStorePublicationMutation,
  unwrapStorePublicationMutation,
} from "../protocol/store-mutation.js";

// vault 解密后的明文结构:引用名 → 真值。
type VaultData = Record<string, string>;

export function vaultPath(storeRoot: string): string {
  return join(storeRoot, "secrets", "vault.age");
}

const td = new TextDecoder();
const te = new TextEncoder();

// 用口令加密一组密钥,产出 armored age 文本(可安全写盘:本身是密文)。
export async function encryptVault(data: VaultData, passphrase: string): Promise<string> {
  const enc = new Encrypter();
  enc.setPassphrase(passphrase);
  const plaintext = te.encode(JSON.stringify(data));
  const ciphertext = await enc.encrypt(plaintext);
  return armor.encode(ciphertext);
}

// 解密 armored age 文本为密钥集合。口令错误/损坏 → 抛错(调用方给可操作信息)。
export async function decryptVault(armored: string, passphrase: string): Promise<VaultData> {
  const dec = new Decrypter();
  dec.addPassphrase(passphrase);
  const raw = armor.decode(armored);
  const plaintext = await dec.decrypt(raw, "uint8array");
  const json = td.decode(plaintext);
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("vault: decrypted payload is not an object");
  }
  return parsed as VaultData;
}

// 从库房读取并解密 vault;文件不存在 → 空集合(尚未存任何密钥)。
export async function loadVault(
  env: Env,
  storeRoot: string,
  passphrase: string,
): Promise<VaultData> {
  const path = vaultPath(storeRoot);
  const armored = await readFileOrNull(env, path);
  if (armored === null) return {};
  try {
    return await decryptVault(armored, passphrase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`vault: failed to decrypt ${path} (${msg})`);
  }
}

// 加密并写回库房 vault(原子写)。仅 secret 子命令用;下发只读不写。
export async function saveVault(
  env: Env,
  storeRoot: string,
  data: VaultData,
  passphrase: string,
): Promise<void> {
  const result = await executeStorePublicationMutation(
    env,
    storeRoot,
    "secret-metadata",
    "vault-update",
    async () => ({
      value: undefined,
      publications: [
        {
          path: vaultPath(storeRoot),
          data: await encryptVault(data, passphrase),
          mode: 0o600,
        },
      ],
    }),
  );
  unwrapStorePublicationMutation(result);
}
