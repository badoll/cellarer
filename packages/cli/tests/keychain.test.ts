import {
  MUTATION_AUTHORITY_ACCOUNT_PREFIX,
  MUTATION_AUTHORITY_CREDENTIAL_SERVICE,
} from "@cellarer/core";
import { describe, expect, it } from "vitest";
import {
  createAuthorityCredentialStore,
  createKeychainStore,
  type EntryCtor,
} from "../src/keychain.js";

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
    expect(got).toEqual({ error: "keychain provider get failed" });
    expect(JSON.stringify(got)).not.toContain("keyring is locked");
  });

  it.each([
    ["get", MUTATION_AUTHORITY_CREDENTIAL_SERVICE, "ordinary-secret"],
    ["set", MUTATION_AUTHORITY_CREDENTIAL_SERVICE, "ordinary-secret"],
    ["delete", MUTATION_AUTHORITY_CREDENTIAL_SERVICE, "ordinary-secret"],
    ["get", "cellarer", `${MUTATION_AUTHORITY_ACCOUNT_PREFIX}${"a".repeat(64)}`],
    ["set", "cellarer", `${MUTATION_AUTHORITY_ACCOUNT_PREFIX}${"a".repeat(64)}`],
    ["delete", "cellarer", `${MUTATION_AUTHORITY_ACCOUNT_PREFIX}${"a".repeat(64)}`],
  ] as const)("rejects ordinary %s access to the reserved mutation-authority namespace", async (operation, service, account) => {
    let constructions = 0;
    const Entry = class {
      constructor(_service: string, _account: string) {
        constructions += 1;
      }
      getPassword() {
        return null;
      }
      setPassword() {}
      deleteCredential() {
        return true;
      }
    };
    const store = createKeychainStore(Entry);
    const call =
      operation === "get"
        ? store.get(service, account)
        : operation === "set"
          ? store.set(service, account, "ordinary-secret")
          : store.delete(service, account);

    await expect(call).rejects.toThrow("reserved mutation authority credential namespace");
    expect(constructions).toBe(0);
  });

  it("gives the dedicated credential store access only to the internal authority grammar", async () => {
    const calls: string[] = [];
    const Entry = class {
      constructor(service: string, account: string) {
        calls.push(`${service}/${account}`);
      }
      getPassword() {
        return null;
      }
      setPassword() {}
      deleteCredential() {
        return true;
      }
    };
    const store = createAuthorityCredentialStore(Entry);
    const account = `${MUTATION_AUTHORITY_ACCOUNT_PREFIX}${"b".repeat(64)}`;

    await expect(store.get(MUTATION_AUTHORITY_CREDENTIAL_SERVICE, account)).resolves.toEqual({
      found: false,
    });
    await expect(store.get("cellarer", "ordinary")).rejects.toThrow(
      "invalid mutation authority credential namespace",
    );
    expect(calls).toEqual([`${MUTATION_AUTHORITY_CREDENTIAL_SERVICE}/${account}`]);
  });
});
