import { describe, expect, it } from "vitest";
import type { SecretStore } from "../src/env.js";
import {
  MUTATION_AUTHORITY_ACCOUNT_PREFIX,
  MUTATION_AUTHORITY_CREDENTIAL_SERVICE,
} from "../src/secrets/authority-namespace.js";
import {
  deleteKeychainSecret,
  getKeychainSecret,
  setKeychainSecret,
} from "../src/secrets/keychain-provider.js";
import { createSecretValue } from "../src/secrets/observable.js";
import { cellarerSecretReference } from "../src/secrets/reference.js";

describe("reserved mutation authority credential namespace", () => {
  it.each([
    ["get", MUTATION_AUTHORITY_CREDENTIAL_SERVICE, "ordinary-secret"],
    ["set", MUTATION_AUTHORITY_CREDENTIAL_SERVICE, "ordinary-secret"],
    ["delete", MUTATION_AUTHORITY_CREDENTIAL_SERVICE, "ordinary-secret"],
    ["get", "cellarer", `${MUTATION_AUTHORITY_ACCOUNT_PREFIX}${"c".repeat(64)}`],
    ["set", "cellarer", `${MUTATION_AUTHORITY_ACCOUNT_PREFIX}${"c".repeat(64)}`],
    ["delete", "cellarer", `${MUTATION_AUTHORITY_ACCOUNT_PREFIX}${"c".repeat(64)}`],
  ] as const)("rejects ordinary provider %s before calling the injected SecretStore", async (operation, service, account) => {
    let calls = 0;
    const store: SecretStore = {
      async get() {
        calls += 1;
        return { found: false };
      },
      async set() {
        calls += 1;
      },
      async delete() {
        calls += 1;
        return false;
      },
    };
    const request =
      operation === "get"
        ? getKeychainSecret(store, service, account)
        : operation === "set"
          ? setKeychainSecret(store, service, account, createSecretValue("ordinary-secret"))
          : deleteKeychainSecret(store, service, account);

    await expect(request).rejects.toThrow("reserved mutation authority credential namespace");
    expect(calls).toBe(0);
  });

  it("keeps the internal account grammar unreachable from cellarer secret references", () => {
    expect(() =>
      cellarerSecretReference(`${MUTATION_AUTHORITY_ACCOUNT_PREFIX}${"d".repeat(64)}`),
    ).toThrow("invalid cellarer secret reference name");
  });
});
