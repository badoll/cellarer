// 系统 keychain 的 SecretStore 实现(密钥分层第 4 层,见计划 §10)。
// 关键约束(不变量 2):core 绝不 import @napi-rs/keyring;keychain 经此工厂构造,
// 在 CLI/Web 组合根注入 Env.secretStore。
//
// native 加载是「模块求值时抛错」(无 native binding 的 headless Linux / 不支持的架构):
// 故用 createRequire 懒加载并整体 try/catch —— 顶层静态 import 会让加载失败崩掉整个 CLI,
// 而不是优雅降级到 vault(tryKeychainStore 返回 null,调用方降级)。
import { createRequire } from "node:module";
import type { SecretStore } from "@cellarer/core";

// @napi-rs/keyring 的 Entry 类型(只取用到的同步方法,避免给 core 引入类型依赖)。
interface KeyringEntry {
  getPassword(): string | null;
  setPassword(secret: string): void;
  deleteCredential(): boolean;
}
type EntryCtor = new (service: string, account: string) => KeyringEntry;

const require = createRequire(import.meta.url);

// getPassword 在「无此条目」时返回 null;真错误(keychain 锁定/瞬时故障)会抛 —— 此处吞为 null,
// 调用方据 null 视为「未解析」保留占位符(不泄明文)。诊断信息有限是已知取舍(见 M3 待办)。
function createKeychainStore(Entry: EntryCtor): SecretStore {
  return {
    async get(service, account) {
      try {
        return new Entry(service, account).getPassword();
      } catch {
        return null;
      }
    },
    async set(service, account, secret) {
      new Entry(service, account).setPassword(secret);
    },
    async delete(service, account) {
      try {
        return new Entry(service, account).deleteCredential();
      } catch {
        return false;
      }
    },
  };
}

// 构造 keychain SecretStore;native 模块加载失败(Linux headless 等)→ null,调用方降级 vault。
export function tryKeychainStore(): SecretStore | null {
  try {
    // 懒加载:require 在 try 内,加载失败被捕获,不波及 CLI 其余命令。
    const { Entry } = require("@napi-rs/keyring") as { Entry: EntryCtor };
    return createKeychainStore(Entry);
  } catch {
    return null;
  }
}
