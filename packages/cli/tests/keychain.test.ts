import { describe, expect, it } from "vitest";
import { createKeychainStore, type EntryCtor } from "../src/keychain.js";

// 用 fake Entry(不依赖真实系统 keychain)验证 keychain SecretStore 的判别式映射:
// getPassword 返回 null / 字符串 / 抛错 → {found:false} / {found:true,value} / {error}。
// 这是横评点名「keychain 仅 fake SecretStore、无真实接线集成测试」的补齐 —— 覆盖
// Entry→SecretStore 这层真实构造逻辑(而非只 fake 顶层 SecretStore)。
function fakeEntryCtor(behavior: (account: string) => string | null | (() => never)): EntryCtor {
  return class {
    account: string;
    constructor(_service: string, account: string) {
      this.account = account;
    }
    getPassword(): string | null {
      const r = behavior(this.account);
      if (typeof r === "function") return r(); // 触发抛错分支
      return r;
    }
    setPassword(): void {}
    deleteCredential(): boolean {
      return true;
    }
  };
}

describe("cli/keychain createKeychainStore mapping", () => {
  it("maps a found password to {found:true,value}", async () => {
    const store = createKeychainStore(fakeEntryCtor(() => "s3cret-value"));
    expect(await store.get("cellarer", "K")).toEqual({ found: true, value: "s3cret-value" });
  });

  it("maps null (no entry) to {found:false}", async () => {
    const store = createKeychainStore(fakeEntryCtor(() => null));
    expect(await store.get("cellarer", "K")).toEqual({ found: false });
  });

  it("maps a thrown error (locked/transient) to {error} — not swallowed to no-entry", async () => {
    const store = createKeychainStore(
      fakeEntryCtor(() => () => {
        throw new Error("keyring is locked");
      }),
    );
    const got = await store.get("cellarer", "K");
    expect(got).toEqual({ error: "keyring is locked" });
  });
});
