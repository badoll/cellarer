// age vault(age-encryption / typage,纯 JS 零 native;见计划 §10)。
// 库房 secrets/vault.age 存「引用名 → 真值」的加密 JSON;口令(scrypt)加密。
// age-encryption 是纯算法库(类比 node:crypto),不碰 fs/process,可在 core 直接 import;
// 文件读写仍走 Env(armor 文本形态,适配 Env 的 string-only fs)。
import { armor, Decrypter, Encrypter } from "age-encryption";
import type { CurrentUserOnlyPermissions, FileStat, FsLike, Platform } from "../env.js";
import { readFileOrNull } from "../fs/probe.js";
import type { VaultData } from "./provider-ports.js";
import { vaultPath } from "./vault-path.js";

export { vaultPath } from "./vault-path.js";

export interface VaultObservationEnv {
  readonly fs: Pick<FsLike, "lstat" | "readFile">;
  readonly platform: Platform;
  readonly currentUserOnlyPermissions?: Pick<CurrentUserOnlyPermissions, "supported" | "verify">;
}

// vault 解密后的明文结构:引用名 → 真值。

export class VaultSecurityError extends Error {
  readonly code = "INSECURE_VAULT_PERMISSIONS" as const;

  constructor(readonly path: string) {
    super(`vault security policy rejected ${path}: current-user-only access is required`);
    this.name = "VaultSecurityError";
  }
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
  env: VaultObservationEnv,
  storeRoot: string,
  passphrase: string,
): Promise<VaultData> {
  const path = vaultPath(storeRoot);
  await assertVaultSecurity(env, path);
  const armored = await readFileOrNull(env, path);
  if (armored === null) return {};
  try {
    return await decryptVault(armored, passphrase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`vault: failed to decrypt ${path} (${msg})`);
  }
}

export async function assertVaultSecurity(env: VaultObservationEnv, path: string): Promise<void> {
  let stat: FileStat;
  try {
    stat = await env.fs.lstat(path);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") {
      if (env.platform === "win32") assertVaultMutationSupported(env, path);
      return;
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new VaultSecurityError(path);
  if (env.platform === "win32") {
    const permissions = env.currentUserOnlyPermissions;
    if (!permissions?.supported(env.platform) || !(await permissions.verify(path))) {
      throw new VaultSecurityError(path);
    }
    return;
  }
  if ((stat.mode & 0o077) !== 0) throw new VaultSecurityError(path);
}

export function assertVaultMutationSupported(
  env: Pick<VaultObservationEnv, "platform" | "currentUserOnlyPermissions">,
  path: string,
): void {
  if (env.platform === "win32" && !env.currentUserOnlyPermissions?.supported(env.platform)) {
    throw new VaultSecurityError(path);
  }
}
