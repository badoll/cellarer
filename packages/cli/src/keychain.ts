// 系统 keychain 的 SecretStore 实现(密钥分层第 4 层,见计划 §10)。
// 关键约束(不变量 2):core 绝不 import @napi-rs/keyring;keychain 经此工厂构造,
// 在 CLI/Web 组合根注入 Env.secretStore。
//
// native 加载是「模块求值时抛错」(无 native binding 的 headless Linux / 不支持的架构):
// 故用 createRequire 懒加载并整体 try/catch —— 顶层静态 import 会让加载失败崩掉整个 CLI,
// 而不是优雅降级到 vault(tryKeychainStore 返回 null,调用方降级)。
import { createRequire } from "node:module";
import {
  assertMutationAuthorityCredentialTarget,
  assertOrdinarySecretCredentialTarget,
  type Env,
} from "@cellarer/core";

type SecretStore = NonNullable<Env["secretStore"]>;

export type KeychainAvailability =
  | { readonly available: true; readonly store: SecretStore }
  | { readonly available: false; readonly reason: "module-unavailable" };

// @napi-rs/keyring 的 Entry 类型(只取用到的同步方法,避免给 core 引入类型依赖)。
export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(secret: string): void;
  deleteCredential(): boolean;
}
export type EntryCtor = new (service: string, account: string) => KeyringEntry;

const require = createRequire(import.meta.url);
type KeyringLoader = () => { Entry: EntryCtor };

// getPassword 在「无此条目」时返回 null;真错误(keychain 锁定/瞬时故障)会抛。
// 判别式映射(横评 §5.1):null → {found:false};字符串 → {found:true,value};抛错 → {error} ——
// 三态不再塌缩成 null,调用方(resolver)据此区分「无条目」与「取不到」并给出不同诊断。
// 导出以便注入 fake Entry 做映射测试(不依赖真实系统 keychain)。
export function createKeychainStore(Entry: EntryCtor): SecretStore {
  return createProtectedKeychainStore(Entry, assertOrdinarySecretCredentialTarget);
}

export function createAuthorityCredentialStore(Entry: EntryCtor): SecretStore {
  return createProtectedKeychainStore(Entry, assertMutationAuthorityCredentialTarget);
}

function createProtectedKeychainStore(
  Entry: EntryCtor,
  assertTarget: (service: string, account: string) => void,
): SecretStore {
  return {
    async get(service, account) {
      assertTarget(service, account);
      try {
        const pw = new Entry(service, account).getPassword();
        return pw === null ? { found: false } : { found: true, value: pw };
      } catch {
        return { error: "keychain provider get failed" };
      }
    },
    async set(service, account, secret) {
      assertTarget(service, account);
      try {
        new Entry(service, account).setPassword(secret);
      } catch {
        throw new Error("keychain provider set failed");
      }
    },
    async delete(service, account) {
      assertTarget(service, account);
      try {
        return new Entry(service, account).deleteCredential();
      } catch {
        throw new Error("keychain provider delete failed");
      }
    },
  };
}

// 构造 keychain SecretStore;native 模块加载失败(Linux headless 等)→ null,调用方降级 vault。
export function loadKeychainStore(
  load: KeyringLoader = () => require("@napi-rs/keyring") as { Entry: EntryCtor },
): KeychainAvailability {
  try {
    return { available: true, store: createKeychainStore(load().Entry) };
  } catch {
    return { available: false, reason: "module-unavailable" };
  }
}

export function tryKeychainStore(): SecretStore | null {
  const availability = loadKeychainStore();
  return availability.available ? availability.store : null;
}

export function tryAuthorityCredentialStore(): SecretStore | null {
  try {
    const { Entry } = require("@napi-rs/keyring") as { Entry: EntryCtor };
    return createAuthorityCredentialStore(Entry);
  } catch {
    return null;
  }
}
