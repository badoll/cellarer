import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env, SecretStore } from "../src/env.js";
import {
  createAuthorizedMutationPlan,
  createDurableMutationPlan,
  createMutationPlan,
} from "../src/protocol/canonical.js";
import {
  operationJournalPath,
  publishOperationJournal,
  readOperationJournal,
} from "../src/protocol/journal.js";
import { diagnoseMutationRecovery, recoverInterruptedOperation } from "../src/protocol/recovery.js";
import { readStoreRevision } from "../src/protocol/store-revision.js";
import {
  keychainMetadataPath,
  serializeKeychainMetadata,
} from "../src/secrets/keychain-metadata.js";
import { createSecretValue } from "../src/secrets/observable.js";
import {
  deleteStoredSecret,
  diagnoseKeychainMutationRecovery,
  reconcileKeychainMutationRecovery,
  setStoredSecret,
  verifySecretReferences,
} from "../src/secrets/provider.js";
import { cellarerSecretReference, environmentSecretReference } from "../src/secrets/reference.js";
import { resolveFields, resolveSecretValue } from "../src/secrets/resolver.js";
import {
  decryptVault,
  encryptVault,
  loadVault,
  saveVault,
  vaultPath,
} from "../src/secrets/vault.js";
import { sha256 } from "../src/store/checksum.js";
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
        conflict: { code: "TARGET_PRECONDITION_CONFLICT", target: "untrusted" },
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

  it("leaves a complete encrypted vault and an interruption journal when receipt recording stops", async () => {
    const storeRoot = t.path("home", ".cellarer");
    const path = vaultPath(storeRoot);
    const journalPath = operationJournalPath(storeRoot);
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    let vaultPublished = false;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (target, data, opts) => {
          if (vaultPublished && target === journalPath && data.includes('"status": "succeeded"')) {
            throw new Error("simulated interruption after vault replacement");
          }
          await publishFileAtomically(target, data, opts);
          if (target === path) vaultPublished = true;
        },
      },
    };

    await expect(saveVault(env, storeRoot, { COMPANY_TOKEN: REAL }, "vault-pass")).rejects.toThrow(
      "simulated interruption",
    );
    await expect(loadVault(t.env, storeRoot, "vault-pass")).resolves.toEqual({
      COMPANY_TOKEN: REAL,
    });
    const onDisk = await t.env.fs.readFile(path);
    expect(onDisk).not.toContain(REAL);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "executing",
      actions: [{ status: "pending" }],
    });
  });

  it("blocks reading or replacing a POSIX vault that is accessible beyond the current user", async () => {
    const storeRoot = t.path("home", ".cellarer");
    const path = vaultPath(storeRoot);
    await t.env.fs.mkdir(t.path("home", ".cellarer", "secrets"), { recursive: true });
    await t.env.fs.writeFile(path, await encryptVault({ COMPANY_TOKEN: REAL }, "vault-pass"), {
      mode: 0o644,
    });

    await expect(loadVault(t.env, storeRoot, "vault-pass")).rejects.toMatchObject({
      code: "INSECURE_VAULT_PERMISSIONS",
    });
    await expect(
      saveVault(t.env, storeRoot, { COMPANY_TOKEN: "replacement" }, "vault-pass"),
    ).rejects.toMatchObject({ code: "INSECURE_VAULT_PERMISSIONS" });
    expect((await t.env.fs.lstat(path)).mode & 0o777).toBe(0o644);
  });

  it("fails closed on Windows when current-user-only ACLs cannot be proven", async () => {
    const storeRoot = t.path("home", ".cellarer");
    const env: Env = { ...t.env, platform: "win32" };

    await expect(
      saveVault(env, storeRoot, { COMPANY_TOKEN: REAL }, "vault-pass"),
    ).rejects.toMatchObject({
      code: "INSECURE_VAULT_PERMISSIONS",
    });
    await expect(t.env.fs.lstat(vaultPath(storeRoot))).rejects.toThrow();
  });

  it("uses injected Windows current-user-only ACL set and verify capabilities", async () => {
    const storeRoot = t.path("home", ".cellarer");
    const secured = new Set<string>();
    const env: Env = {
      ...t.env,
      platform: "win32",
      currentUserOnlyPermissions: {
        supported: () => true,
        async set(path) {
          secured.add(path);
        },
        async verify(path) {
          return secured.has(path);
        },
      },
    };

    await saveVault(env, storeRoot, { COMPANY_TOKEN: REAL }, "vault-pass");
    expect(secured.has(vaultPath(storeRoot))).toBe(true);
    await expect(loadVault(env, storeRoot, "vault-pass")).resolves.toEqual({ COMPANY_TOKEN: REAL });
  });

  it("proves Windows ACLs for vault provider create, replace, and delete before success", async () => {
    const storeRoot = t.path("home", ".cellarer");
    const path = vaultPath(storeRoot);
    const setCalls: string[] = [];
    const verifyCalls: string[] = [];
    const secured = new Set<string>();
    const env: Env = {
      ...t.env,
      platform: "win32",
      currentUserOnlyPermissions: {
        supported: () => true,
        async set(target) {
          setCalls.push(target);
          secured.add(target);
        },
        async verify(target) {
          verifyCalls.push(target);
          return secured.has(target);
        },
      },
    };

    const created = await setStoredSecret(env, storeRoot, {
      provider: "vault",
      name: "COMPANY_TOKEN",
      value: "tiny",
      vaultPassphrase: "vault-pass",
    });
    const replaced = await setStoredSecret(env, storeRoot, {
      provider: "vault",
      name: "COMPANY_TOKEN",
      value: "next",
      vaultPassphrase: "vault-pass",
    });
    const deleted = await deleteStoredSecret(env, storeRoot, {
      provider: "vault",
      name: "COMPANY_TOKEN",
      vaultPassphrase: "vault-pass",
    });

    expect(created.operation).toMatchObject({ ok: true });
    expect(replaced.operation).toMatchObject({ ok: true });
    expect(deleted.operation).toMatchObject({ ok: true });
    expect(setCalls).toEqual([path, path, path]);
    expect(verifyCalls.filter((target) => target === path).length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    "set",
    "delete",
  ] as const)("fails a self-consistent forged secret-metadata keychain-%s journal closed before every interaction", async (mutation) => {
    const storeRoot = t.path("home", ".cellarer");
    const service = "forged-service";
    const name = "FORGED_TARGET";
    const target = keychainMetadataPath(storeRoot, service, name);
    const kind =
      mutation === "set" ? ("keychain-secret-set" as const) : ("keychain-secret-delete" as const);
    const actionId = sha256(JSON.stringify({ kind, service, name }));
    const metadata = serializeKeychainMetadata(service, name, mutation === "set");
    const forgedPlan = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: `forged-secret-metadata-${mutation}`,
      operation: "secret-metadata",
      baseRevision: 0,
      normalizedInputs: { mutationKind: kind },
      targetPreconditions: [{ actionId, target, expected: { state: "absent" } }],
      actions: [
        {
          actionId,
          kind,
          target,
          payload: { provider: "keychain", service, name },
          postcondition: { state: "present", fingerprint: sha256(metadata) },
        },
      ],
      expires: { policy: "none" },
    });
    const timestamp = t.env.now().toISOString();
    const journal = {
      schemaVersion: 1 as const,
      operationId: `forged-secret-metadata-${mutation}`,
      plan: createDurableMutationPlan(t.env, storeRoot, forgedPlan),
      nextRevision: 1,
      status: "executing" as const,
      startedAt: timestamp,
      updatedAt: timestamp,
      actions: [{ actionId, target, status: "pending" as const }],
    };
    await publishOperationJournal(t.env, storeRoot, journal);
    const calls = {
      provider: 0,
      claim: 0,
      targetRead: 0,
      targetList: 0,
      targetLstat: 0,
      effect: 0,
    };
    const env: Env = {
      ...t.env,
      secretStore: {
        async get() {
          calls.provider += 1;
          return { found: true, value: REAL };
        },
        async set() {
          calls.provider += 1;
        },
        async delete() {
          calls.provider += 1;
          return true;
        },
      },
      fs: {
        ...t.env.fs,
        async readFile(path) {
          if (path === target) calls.targetRead += 1;
          return t.env.fs.readFile(path);
        },
        async readdir(path) {
          if (path === target || path.startsWith(`${target}/`)) calls.targetList += 1;
          return t.env.fs.readdir(path);
        },
        async lstat(path) {
          if (path === target || path.startsWith(`${target}/`)) calls.targetLstat += 1;
          return t.env.fs.lstat(path);
        },
        async writeFileExclusive(path, data, options) {
          calls.claim += 1;
          return t.env.fs.writeFileExclusive(path, data, options);
        },
        async publishFileAtomically(path, data, options) {
          calls.effect += 1;
          return t.env.fs.publishFileAtomically(path, data, options);
        },
        async rm(path, options) {
          calls.effect += 1;
          return t.env.fs.rm(path, options);
        },
      },
    };

    await expect(diagnoseMutationRecovery(env, storeRoot)).resolves.toMatchObject({
      status: "manual-recovery-required",
    });
    await expect(
      recoverInterruptedOperation(env, storeRoot, { operationId: journal.operationId }),
    ).resolves.toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED" },
    });
    await expect(
      diagnoseKeychainMutationRecovery(env, storeRoot, journal.operationId),
    ).rejects.toThrow("keychain recovery journal is not authorized");
    await expect(
      reconcileKeychainMutationRecovery(env, storeRoot, {
        operationId: journal.operationId,
        resolution: "rollback-new-entry",
      }),
    ).rejects.toThrow("keychain recovery journal is not authorized");
    expect(calls).toEqual({
      provider: 0,
      claim: 0,
      targetRead: 0,
      targetList: 0,
      targetLstat: 0,
      effect: 0,
    });
  });

  it.each([
    "set",
    "verify",
  ] as const)("does not return a vault provider success receipt when Windows ACL %s fails", async (failure) => {
    const storeRoot = t.path("home", ".cellarer");
    const env: Env = {
      ...t.env,
      platform: "win32",
      currentUserOnlyPermissions: {
        supported: () => true,
        async set() {
          if (failure === "set") {
            throw Object.assign(new Error("acl set failed"), { code: "EACCES" });
          }
        },
        async verify() {
          return failure !== "verify";
        },
      },
    };

    const result = await setStoredSecret(env, storeRoot, {
      provider: "vault",
      name: "COMPANY_TOKEN",
      value: "tiny",
      vaultPassphrase: "vault-pass",
    });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "PARTIAL_FAILURE" },
    });
    expect(result.operation).not.toHaveProperty("receipt");
  });

  it("mutates keychain references under the store protocol without persisting the value", async () => {
    const storeRoot = t.path("home", ".cellarer");
    const values = new Map<string, string>();
    t.env.secretStore = mapSecretStore(values);

    const added = await setStoredSecret(t.env, storeRoot, {
      provider: "keychain",
      name: "COMPANY_TOKEN",
      value: REAL,
    });
    expect(added.operation).toMatchObject({ ok: true, receipt: { operation: "secret-metadata" } });
    expect(values.get("cellarer/COMPANY_TOKEN")).toBe(REAL);
    expect(JSON.stringify(added)).not.toContain(REAL);

    const removed = await deleteStoredSecret(t.env, storeRoot, {
      provider: "keychain",
      name: "COMPANY_TOKEN",
    });
    expect(removed.operation).toMatchObject({ ok: true });
    expect(values.has("cellarer/COMPANY_TOKEN")).toBe(false);
    expect(JSON.stringify(await readOperationJournal(t.env, storeRoot))).not.toContain(REAL);
  });

  it("keeps interrupted keychain mutation evidence value-free and requires recovery", async () => {
    const storeRoot = t.path("home", ".cellarer");
    const values = new Map<string, string>();
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    const journalPath = operationJournalPath(storeRoot);
    let keychainMutated = false;
    const env: Env = {
      ...t.env,
      secretStore: {
        ...mapSecretStore(values),
        async set(service, account, secret) {
          keychainMutated = true;
          values.set(`${service}/${account}`, secret);
        },
      },
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (target, data, opts) => {
          if (keychainMutated && target === journalPath && data.includes('"status": "succeeded"')) {
            throw new Error("simulated interruption after keychain mutation");
          }
          await publishFileAtomically(target, data, opts);
        },
      },
    };

    await expect(
      setStoredSecret(env, storeRoot, {
        provider: "keychain",
        name: "COMPANY_TOKEN",
        value: REAL,
      }),
    ).rejects.toThrow("simulated interruption");
    const journal = await readOperationJournal(t.env, storeRoot);
    expect(journal).toMatchObject({
      status: "executing",
      actions: [{ status: "pending" }],
    });
    expect(JSON.stringify(journal)).not.toContain(REAL);
    if (!journal) throw new Error("expected interrupted keychain journal");
    const recovered = await recoverInterruptedOperation(t.env, storeRoot, {
      operationId: journal.operationId,
    });
    expect(recovered).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED" },
    });
    expect(JSON.stringify(recovered)).not.toContain(REAL);

    const recoveryEnv: Env = {
      ...t.env,
      secretStore: env.secretStore,
    };
    await expect(
      diagnoseKeychainMutationRecovery(recoveryEnv, storeRoot, journal.operationId),
    ).rejects.toThrow("keychain recovery journal is not authorized");

    await expect(
      reconcileKeychainMutationRecovery(recoveryEnv, storeRoot, {
        operationId: journal.operationId,
        resolution: "rollback-new-entry",
      }),
    ).rejects.toThrow("keychain recovery journal is not authorized");
    expect(values.get("cellarer/COMPANY_TOKEN")).toBe(REAL);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "executing",
    });
  });

  it.each([
    "set",
    "delete",
  ] as const)("rejects a digest-valid store-import keychain-%s journal before provider access", async (mutation) => {
    const storeRoot = t.path("home", ".cellarer");
    const calls = { get: 0, set: 0, delete: 0 };
    const journalPath = operationJournalPath(storeRoot);
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    let providerMutated = false;
    const creatingEnv: Env = {
      ...t.env,
      secretStore: {
        async get() {
          return { found: false };
        },
        async set() {
          providerMutated = true;
        },
        async delete() {
          providerMutated = true;
          return false;
        },
      },
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (target, data, opts) => {
          if (providerMutated && target === journalPath && data.includes('"status": "succeeded"')) {
            throw new Error("interrupted while creating signed keychain action");
          }
          await publishFileAtomically(target, data, opts);
        },
      },
    };
    await expect(
      mutation === "set"
        ? setStoredSecret(creatingEnv, storeRoot, {
            provider: "keychain",
            name: "FORGED_TARGET",
            value: REAL,
          })
        : deleteStoredSecret(creatingEnv, storeRoot, {
            provider: "keychain",
            name: "FORGED_TARGET",
          }),
    ).rejects.toThrow("interrupted while creating signed keychain action");
    const legitimate = await readOperationJournal(t.env, storeRoot);
    const action = legitimate?.plan.actions[0];
    const precondition = legitimate?.plan.targetPreconditions[0];
    if (!legitimate || !action?.payload || !action.postcondition || !precondition) {
      throw new Error("expected complete durable keychain authorization");
    }
    const forgedPlan = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: "forged-store-import-plan",
      operation: "store-import",
      baseRevision: legitimate.plan.baseRevision,
      normalizedInputs: { mutationKind: action.kind },
      actions: [
        {
          actionId: action.actionId,
          kind: action.kind,
          target: action.target,
          payload: action.payload,
          postcondition: action.postcondition,
        },
      ],
      targetPreconditions: [precondition],
      expires: { policy: "none" },
    });
    const timestamp = t.env.now().toISOString();
    await publishOperationJournal(t.env, storeRoot, {
      schemaVersion: 1,
      operationId: "forged-store-import",
      plan: createDurableMutationPlan(t.env, storeRoot, forgedPlan),
      nextRevision: forgedPlan.baseRevision + 1,
      status: "executing",
      startedAt: timestamp,
      updatedAt: timestamp,
      actions: [
        {
          actionId: action.actionId,
          target: action.target,
          status: "pending",
        },
      ],
    });
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      plan: { operation: "store-import" },
    });
    const recoveryEnv: Env = {
      ...t.env,
      secretStore: {
        async get() {
          calls.get += 1;
          return { found: true, value: REAL };
        },
        async set() {
          calls.set += 1;
        },
        async delete() {
          calls.delete += 1;
          return true;
        },
      },
    };

    let diagnosisOutcome: unknown;
    try {
      diagnosisOutcome = await diagnoseKeychainMutationRecovery(
        recoveryEnv,
        storeRoot,
        "forged-store-import",
      );
    } catch (error) {
      diagnosisOutcome = error;
    }
    expect(calls).toEqual({ get: 0, set: 0, delete: 0 });
    expect(diagnosisOutcome).toMatchObject({
      message: "keychain recovery journal is not authorized",
    });

    let reconcileOutcome: unknown;
    try {
      reconcileOutcome = await reconcileKeychainMutationRecovery(recoveryEnv, storeRoot, {
        operationId: "forged-store-import",
        resolution: "rollback-new-entry",
      });
    } catch (error) {
      reconcileOutcome = error;
    }
    expect(calls).toEqual({ get: 0, set: 0, delete: 0 });
    expect(reconcileOutcome).toMatchObject({
      message: "keychain recovery journal is not authorized",
    });
    for (const outcome of [diagnosisOutcome, reconcileOutcome]) {
      const observable = outcome instanceof Error ? outcome.message : JSON.stringify(outcome);
      expect(observable).not.toContain(action.target);
      expect(observable).not.toContain(REAL);
    }
  });

  it("never deletes a pre-existing OS entry when keychain metadata was absent", async () => {
    const storeRoot = t.path("home", ".cellarer");
    const values = new Map<string, string>([["cellarer/COMPANY_TOKEN", "pre-existing"]]);
    let deletes = 0;
    const baseStore = mapSecretStore(values);
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    const journalPath = operationJournalPath(storeRoot);
    let providerMutated = false;
    const env: Env = {
      ...t.env,
      secretStore: {
        ...baseStore,
        async set(service, account, secret) {
          providerMutated = true;
          await baseStore.set(service, account, secret);
        },
        async delete(service, account) {
          deletes += 1;
          return baseStore.delete(service, account);
        },
      },
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (target, data, opts) => {
          if (providerMutated && target === journalPath && data.includes('"status": "succeeded"')) {
            throw new Error("interrupted metadata-absent keychain set");
          }
          await publishFileAtomically(target, data, opts);
        },
      },
    };

    await expect(
      setStoredSecret(env, storeRoot, {
        provider: "keychain",
        name: "COMPANY_TOKEN",
        value: "next",
      }),
    ).rejects.toThrow("interrupted metadata-absent keychain set");
    const journal = await readOperationJournal(t.env, storeRoot);
    if (!journal) throw new Error("expected interrupted keychain journal");
    await expect(
      recoverInterruptedOperation(env, storeRoot, { operationId: journal.operationId }),
    ).resolves.toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED" },
    });
    await expect(
      diagnoseKeychainMutationRecovery(env, storeRoot, journal.operationId),
    ).rejects.toThrow("keychain recovery journal is not authorized");
    await expect(
      reconcileKeychainMutationRecovery(env, storeRoot, {
        operationId: journal.operationId,
        resolution: "rollback-new-entry",
      }),
    ).rejects.toThrow("keychain recovery journal is not authorized");
    expect(deletes).toBe(0);
    expect(values.get("cellarer/COMPANY_TOKEN")).toBe("next");
  });

  it("does not delete a keychain entry while the original mutation owner is alive", async () => {
    const storeRoot = t.path("home", ".cellarer");
    const values = new Map<string, string>();
    let deletes = 0;
    const baseStore = mapSecretStore(values);
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    const journalPath = operationJournalPath(storeRoot);
    let providerMutated = false;
    const env: Env = {
      ...t.env,
      secretStore: {
        ...baseStore,
        async set(service, account, secret) {
          providerMutated = true;
          await baseStore.set(service, account, secret);
        },
        async delete(service, account) {
          deletes += 1;
          return baseStore.delete(service, account);
        },
      },
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (target, data, opts) => {
          if (providerMutated && target === journalPath && data.includes('"status": "succeeded"')) {
            throw new Error("interrupted active owner");
          }
          await publishFileAtomically(target, data, opts);
        },
      },
    };
    await expect(
      setStoredSecret(env, storeRoot, {
        provider: "keychain",
        name: "COMPANY_TOKEN",
        value: "tiny",
      }),
    ).rejects.toThrow("interrupted active owner");
    const journal = await readOperationJournal(t.env, storeRoot);
    if (!journal) throw new Error("expected interrupted keychain journal");
    await expect(
      reconcileKeychainMutationRecovery(env, storeRoot, {
        operationId: journal.operationId,
        resolution: "rollback-new-entry",
      }),
    ).rejects.toThrow("keychain recovery journal is not authorized");
    expect(deletes).toBe(0);
    expect(values.get("cellarer/COMPANY_TOKEN")).toBe("tiny");
  });

  it("does not select a keychain identity from tampered recovery metadata", async () => {
    const storeRoot = t.path("home", ".cellarer");
    const values = new Map<string, string>();
    const deleted: string[] = [];
    const baseStore = mapSecretStore(values);
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    const journalPath = operationJournalPath(storeRoot);
    let providerMutated = false;
    const env: Env = {
      ...t.env,
      secretStore: {
        ...baseStore,
        async set(service, account, secret) {
          providerMutated = true;
          await baseStore.set(service, account, secret);
        },
        async delete(service, account) {
          deleted.push(`${service}/${account}`);
          return baseStore.delete(service, account);
        },
      },
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (target, data, opts) => {
          if (providerMutated && target === journalPath && data.includes('"status": "succeeded"')) {
            throw new Error("interrupted for metadata tamper");
          }
          await publishFileAtomically(target, data, opts);
        },
      },
    };
    await expect(
      setStoredSecret(env, storeRoot, {
        provider: "keychain",
        name: "COMPANY_TOKEN",
        value: "tiny",
      }),
    ).rejects.toThrow("interrupted for metadata tamper");
    const journal = await readOperationJournal(t.env, storeRoot);
    if (!journal) throw new Error("expected interrupted keychain journal");
    const target = journal.plan.actions[0]?.target;
    if (!target) throw new Error("expected keychain action target");
    await t.env.fs.writeFile(
      target,
      `${JSON.stringify({ provider: "keychain", service: "attacker", name: "OTHER" })}\n`,
    );
    await expect(
      reconcileKeychainMutationRecovery(env, storeRoot, {
        operationId: journal.operationId,
        resolution: "rollback-new-entry",
      }),
    ).rejects.toThrow("keychain recovery journal is not authorized");
    expect(deleted).toEqual([]);
    expect(values.get("cellarer/COMPANY_TOKEN")).toBe("tiny");
  });

  it.each([
    "set",
    "delete",
  ] as const)("keeps interrupted existing keychain %s manual-only without guessing the prior value", async (mutation) => {
    const storeRoot = t.path("home", ".cellarer");
    const oldValue = "old-low-canary";
    const nextValue = "next-low-canary";
    const values = new Map<string, string>();
    t.env.secretStore = mapSecretStore(values);
    const seeded = await setStoredSecret(t.env, storeRoot, {
      provider: "keychain",
      name: "COMPANY_TOKEN",
      value: oldValue,
    });
    expect(seeded.operation).toMatchObject({ ok: true });

    const publishFileAtomically = t.env.fs.publishFileAtomically;
    const journalPath = operationJournalPath(storeRoot);
    let providerMutated = false;
    const baseStore = mapSecretStore(values);
    const env: Env = {
      ...t.env,
      secretStore: {
        ...baseStore,
        async set(service, account, secret) {
          providerMutated = true;
          await baseStore.set(service, account, secret);
        },
        async delete(service, account) {
          providerMutated = true;
          return baseStore.delete(service, account);
        },
      },
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (target, data, opts) => {
          if (providerMutated && target === journalPath && data.includes('"status": "succeeded"')) {
            throw new Error(`interrupted existing ${mutation}`);
          }
          await publishFileAtomically(target, data, opts);
        },
      },
    };

    await expect(
      mutation === "set"
        ? setStoredSecret(env, storeRoot, {
            provider: "keychain",
            name: "COMPANY_TOKEN",
            value: nextValue,
          })
        : deleteStoredSecret(env, storeRoot, {
            provider: "keychain",
            name: "COMPANY_TOKEN",
          }),
    ).rejects.toThrow(`interrupted existing ${mutation}`);
    const journal = await readOperationJournal(t.env, storeRoot);
    if (!journal) throw new Error("expected interrupted keychain journal");
    const recovered = await recoverInterruptedOperation(t.env, storeRoot, {
      operationId: journal.operationId,
    });
    const recoveryEnv: Env = { ...t.env, secretStore: env.secretStore };
    expect(recovered).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED" },
    });
    await expect(
      diagnoseKeychainMutationRecovery(recoveryEnv, storeRoot, journal.operationId),
    ).rejects.toThrow("keychain recovery journal is not authorized");
    await expect(
      reconcileKeychainMutationRecovery(recoveryEnv, storeRoot, {
        operationId: journal.operationId,
        resolution: "rollback-new-entry",
      }),
    ).rejects.toThrow("keychain recovery journal is not authorized");
    expect(values.get("cellarer/COMPANY_TOKEN")).toBe(mutation === "set" ? nextValue : undefined);
    for (const evidence of [journal, recovered]) {
      expect(JSON.stringify(evidence)).not.toContain(oldValue);
      expect(JSON.stringify(evidence)).not.toContain(nextValue);
    }
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
    expect(out.value?.use((value) => value)).toBe(REAL);
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
    expect(out.resolved).toBe(true);
    expect(out.value?.use((value) => value)).toBe("npx");
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
    expect(out.value?.use((value) => value)).toBe(REAL);
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
    expect(out.value?.use((value) => value)).toBe(REAL);
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
    expect(errored.reason).toMatch(/keychain provider unavailable/);
    expect(errored.reason).not.toContain("keyring is locked");
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
    expect(typeof resolved.A === "string" ? resolved.A : resolved.A?.use((value) => value)).toBe(
      "v",
    );
    expect(resolved.B).toBe("${ABSENT}"); // 未解析 → 保留占位符,绝不落明文
    expect(typeof resolved.C === "string" ? resolved.C : resolved.C?.use((value) => value)).toBe(
      "plain",
    );
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.field).toBe("B");
  });

  it("verifies reference presence without returning or persisting resolved values", async () => {
    t = makeTmpEnv({ env: { PRESENT: REAL } });
    await ensureBaseDirs(t);
    const storeRoot = t.path("home", ".cellarer");
    const values = new Map([["cellarer/KC_KEY", REAL]]);
    t.env.secretStore = mapSecretStore(values);

    const results = await verifySecretReferences(
      t.env,
      storeRoot,
      [
        environmentSecretReference("PRESENT"),
        environmentSecretReference("MISSING"),
        cellarerSecretReference("KC_KEY"),
      ],
      { mode: "keychain" },
    );

    expect(results).toEqual([
      { reference: "${PRESENT}", provider: "environment", status: "available" },
      { reference: "${MISSING}", provider: "environment", status: "missing" },
      {
        reference: "${CELLARER_SECRET:KC_KEY}",
        provider: "keychain",
        status: "available",
      },
    ]);
    expect(JSON.stringify(results)).not.toContain(REAL);
    expect(await readOperationJournal(t.env, storeRoot)).toBeNull();
  });

  it("normalizes thrown keychain get errors without exposing a low-entropy canary", async () => {
    const canary = "low entropy provider failure";
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    t.env.secretStore = {
      async get() {
        throw new Error(canary);
      },
      async set() {},
      async delete() {
        return false;
      },
    };

    const outcome = await resolveSecretValue(
      t.env,
      t.path("home", ".cellarer"),
      "${CELLARER_SECRET:X}",
      { mode: "keychain" },
    );

    expect(outcome).toEqual({ resolved: false, reason: 'keychain provider unavailable for "X"' });
    expect(JSON.stringify(outcome)).not.toContain(canary);
  });
});

describe("keychain provider error normalization", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  it.each(["set", "delete"] as const)("does not expose a thrown %s error", async (operation) => {
    const canary = `low entropy ${operation} provider failure`;
    const storeRoot = t.path("home", ".cellarer");
    t.env.secretStore = {
      async get() {
        return { found: false };
      },
      async set() {
        throw new Error(canary);
      },
      async delete() {
        throw new Error(canary);
      },
    };
    let thrown: unknown;
    try {
      if (operation === "set") {
        await setStoredSecret(t.env, storeRoot, {
          provider: "keychain",
          name: "X",
          value: "value",
        });
      } else {
        await deleteStoredSecret(t.env, storeRoot, { provider: "keychain", name: "X" });
      }
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(`keychain provider ${operation} failed`);
    expect(JSON.stringify(thrown)).not.toContain(canary);
  });
});

function mapSecretStore(values: Map<string, string>): SecretStore {
  return {
    async get(service, account) {
      const value = values.get(`${service}/${account}`);
      return value === undefined ? { found: false } : { found: true, value };
    },
    async set(service, account, secret) {
      values.set(`${service}/${account}`, secret);
    },
    async delete(service, account) {
      return values.delete(`${service}/${account}`);
    },
  };
}
