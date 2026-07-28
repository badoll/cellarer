import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env, SecretStore } from "../src/env.js";
import { readOperationJournal } from "../src/protocol/journal.js";
import { readStoreRevision } from "../src/protocol/store-revision.js";
import { resolveFields, resolveSecretValue } from "../src/secrets/resolver.js";
import {
  decryptVault,
  encryptVault,
  loadVault,
  saveVault,
  vaultPath,
} from "../src/secrets/vault.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const REAL = "ghp_0123456789abcdefghijklmnopqrstuvwx";

describe("secrets/vault (age passphrase)", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  it("encrypts and decrypts a round-trip", async () => {
    const armored = await encryptVault({ MY_KEY: REAL }, "correct horse battery");
    expect(armored).toContain("BEGIN AGE ENCRYPTED FILE");
    // 密文里不出现明文真值(安全红线)。
    expect(armored).not.toContain(REAL);
    const data = await decryptVault(armored, "correct horse battery");
    expect(data.MY_KEY).toBe(REAL);
  });

  it("wrong passphrase fails to decrypt", async () => {
    const armored = await encryptVault({ K: "v" }, "right-pass");
    await expect(decryptVault(armored, "wrong-pass")).rejects.toThrow();
  });

  it("saveVault writes ciphertext to disk with NO plaintext (grep assertion)", async () => {
    const storeRoot = t.path("home", ".cellarer");
    await saveVault(t.env, storeRoot, { COMPANY_TOKEN: REAL }, "vault-pass-1234");
    const onDisk = await t.env.fs.readFile(vaultPath(storeRoot));
    // 落盘断言:磁盘上的 vault 文件绝不含明文真值。
    expect(onDisk).not.toContain(REAL);
    expect(onDisk).not.toContain("0123456789abcdef");
    // 但能解回。
    const data = await loadVault(t.env, storeRoot, "vault-pass-1234");
    expect(data.COMPANY_TOKEN).toBe(REAL);
  });

  it("loadVault returns empty when no vault file exists", async () => {
    const data = await loadVault(t.env, t.path("home", ".cellarer"), "any");
    expect(data).toEqual({});
  });

  it("rejects external vault drift before the lock without overwriting it", async () => {
    const storeRoot = t.path("home", ".cellarer");
    const external = await encryptVault({ EXTERNAL: "must-survive" }, "external-pass");
    await t.env.fs.mkdir(t.path("home", ".cellarer", "secrets"), { recursive: true });
    const driftEnv = driftBeforeMutationLock(t.env, async () => {
      await t.env.fs.writeFile(vaultPath(storeRoot), external);
    });

    await expect(saveVault(driftEnv, storeRoot, { MINE: REAL }, "mine-pass")).rejects.toMatchObject(
      {
        code: "TARGET_PRECONDITION_CONFLICT",
        conflict: { code: "TARGET_PRECONDITION_CONFLICT", target: vaultPath(storeRoot) },
      },
    );
    await expect(t.env.fs.readFile(vaultPath(storeRoot))).resolves.toBe(external);
  });

  it("does not commit when the signed vault publication mode is silently changed", async () => {
    const storeRoot = t.path("home", ".cellarer");
    const path = vaultPath(storeRoot);
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (target, data, opts) => {
          await publishFileAtomically(target, data, opts);
          if (target === path) await t.env.fs.chmod(target, 0o644);
        },
      },
    };

    await expect(
      saveVault(env, storeRoot, { COMPANY_TOKEN: REAL }, "vault-pass"),
    ).rejects.toMatchObject({ code: "PARTIAL_FAILURE" });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "recovery-required",
      actions: [
        {
          status: "failed",
          receipt: { error: { code: "PUBLICATION_POSTCONDITION_FAILED" } },
        },
      ],
    });
  });
});

function driftBeforeMutationLock(env: Env, drift: () => Promise<void>): Env {
  const writeFileExclusive = env.fs.writeFileExclusive;
  let injected = false;
  return {
    ...env,
    fs: {
      ...env.fs,
      writeFileExclusive: async (path, data, opts) => {
        if (!injected && path.endsWith("mutation.lock")) {
          injected = true;
          await drift();
        }
        return writeFileExclusive(path, data, opts);
      },
    },
  };
}

describe("secrets/resolver", () => {
  let t: TmpEnv;
  afterEach(() => t?.cleanup());

  it("resolves ${ENV_VAR} from injected env (not process.env)", async () => {
    t = makeTmpEnv({ env: { GH_TOKEN: REAL } });
    await ensureBaseDirs(t);
    const out = await resolveSecretValue(t.env, t.path("home", ".cellarer"), "${GH_TOKEN}", {
      mode: "env",
    });
    expect(out.resolved).toBe(true);
    expect(out.value).toBe(REAL);
  });

  it("reports unresolved when env var is missing (no plaintext leak)", async () => {
    t = makeTmpEnv({ env: {} });
    await ensureBaseDirs(t);
    const out = await resolveSecretValue(t.env, t.path("home", ".cellarer"), "${MISSING}", {
      mode: "env",
    });
    expect(out.resolved).toBe(false);
    expect(out.value).toBeUndefined();
    expect(out.reason).toContain("MISSING");
  });

  it("passes through non-placeholder values unchanged", async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    const out = await resolveSecretValue(t.env, t.path("home", ".cellarer"), "npx", {
      mode: "env",
    });
    expect(out).toEqual({ resolved: true, value: "npx" });
  });

  it("resolves ${CELLARER_SECRET:name} from vault", async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    const storeRoot = t.path("home", ".cellarer");
    await saveVault(t.env, storeRoot, { COMPANY_TOKEN: REAL }, "p");
    const out = await resolveSecretValue(t.env, storeRoot, "${CELLARER_SECRET:COMPANY_TOKEN}", {
      mode: "vault",
      vaultPassphrase: "p",
    });
    expect(out.value).toBe(REAL);
  });

  it("resolves via injected keychain SecretStore", async () => {
    const fakeStore: SecretStore = {
      get: async (_s, account) =>
        account === "KC_KEY" ? { found: true, value: REAL } : { found: false },
      set: async () => {},
      delete: async () => true,
    };
    t = makeTmpEnv();
    t.env.secretStore = fakeStore;
    await ensureBaseDirs(t);
    const out = await resolveSecretValue(
      t.env,
      t.path("home", ".cellarer"),
      "${CELLARER_SECRET:KC_KEY}",
      { mode: "keychain" },
    );
    expect(out.value).toBe(REAL);
  });

  it("keychain no-entry vs error surface distinct reasons (never leaking values)", async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    const storeRoot = t.path("home", ".cellarer");

    // 无此条目:{found:false} → reason 提「no entry」。
    t.env.secretStore = {
      get: async () => ({ found: false }),
      set: async () => {},
      delete: async () => true,
    };
    const noEntry = await resolveSecretValue(t.env, storeRoot, "${CELLARER_SECRET:X}", {
      mode: "keychain",
    });
    expect(noEntry.resolved).toBe(false);
    expect(noEntry.reason).toMatch(/no entry/);
    expect(noEntry.value).toBeUndefined();

    // keychain 错误(锁定/瞬态):{error} → reason 提「keychain error」,与 no-entry 区分。
    t.env.secretStore = {
      get: async () => ({ error: "keyring is locked" }),
      set: async () => {},
      delete: async () => true,
    };
    const errored = await resolveSecretValue(t.env, storeRoot, "${CELLARER_SECRET:X}", {
      mode: "keychain",
    });
    expect(errored.resolved).toBe(false);
    expect(errored.reason).toMatch(/keychain error/);
    expect(errored.reason).toContain("keyring is locked");
    expect(errored.value).toBeUndefined();
  });

  it("resolveFields collects unresolved without leaking, keeps placeholders", async () => {
    t = makeTmpEnv({ env: { PRESENT: "v" } });
    await ensureBaseDirs(t);
    const { resolved, unresolved } = await resolveFields(
      t.env,
      t.path("home", ".cellarer"),
      { A: "${PRESENT}", B: "${ABSENT}", C: "plain" },
      { mode: "env" },
    );
    expect(resolved.A).toBe("v");
    expect(resolved.B).toBe("${ABSENT}"); // 未解析 → 保留占位符,绝不落明文
    expect(resolved.C).toBe("plain");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.field).toBe("B");
  });
});
