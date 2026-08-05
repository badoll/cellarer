import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  add,
  applyMutationPlan,
  createRealEnv,
  type Env,
  type HeadlessLifetimeLease,
  type HeadlessLifetimeOwner,
  initializeStore,
  type MutationAuthorityRequest,
  mutationLockPath,
  operationJournalPath,
  planApplyMutation,
  recoveryLockPath,
  type SecretStore,
} from "@cellarer/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachMutationAuthority,
  HEADLESS_MUTATION_AUTHORITY_ENV,
  loadMutationAuthority,
  provisionMutationAuthority,
  rotateMutationAuthority,
} from "../src/mutation-authority.js";

const HEADLESS_KEY = `v1:7:${Buffer.alloc(32, 0x2a).toString("base64url")}`;
const NEXT_HEADLESS_KEY = `v1:8:${Buffer.alloc(32, 0x2b).toString("base64url")}`;

function replayableLegacyOwner(storeRoot: string): string {
  const authorityId = `headless-${createHash("sha256")
    .update("cellarer-headless-authority-id\0")
    .update(storeRoot)
    .update("\0")
    .update(Buffer.alloc(32, 0x2a))
    .digest("hex")}`;
  return `${JSON.stringify({
    schemaVersion: 1,
    processId: 101,
    hostname: "shared-host",
    nonce: "00000000-0000-4000-8000-000000000001",
    authorityId,
    authorityEpoch: 7,
  })}\n`;
}

class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  getCalls = 0;
  setCalls = 0;
  discardWrites = false;
  getError = false;

  async get(service: string, account: string) {
    this.getCalls += 1;
    if (this.getError) return { error: "provider internals must not escape" } as const;
    const value = this.values.get(`${service}\0${account}`);
    return value === undefined ? ({ found: false } as const) : ({ found: true, value } as const);
  }

  async set(service: string, account: string, secret: string) {
    this.setCalls += 1;
    if (!this.discardWrites) this.values.set(`${service}\0${account}`, secret);
  }

  async delete(service: string, account: string) {
    return this.values.delete(`${service}\0${account}`);
  }
}

class FakeHeadlessLifetimeOwners {
  private readonly owners = new Map<
    string,
    { readonly process: string; readonly lease: HeadlessLifetimeLease }
  >();

  forProcess(process: string): HeadlessLifetimeOwner {
    return Object.freeze({
      acquire: async (normalizedStoreRoot: string) => {
        const current = this.owners.get(normalizedStoreRoot);
        if (current) {
          if (current.process === process) return current.lease;
          throw new Error("kernel owner is active");
        }
        let record: { readonly process: string; readonly lease: HeadlessLifetimeLease };
        const lease = Object.freeze({
          isCurrent: async () => this.owners.get(normalizedStoreRoot) === record,
        });
        record = Object.freeze({ process, lease });
        this.owners.set(normalizedStoreRoot, record);
        return lease;
      },
    });
  }

  exit(process: string): void {
    for (const [storeRoot, owner] of this.owners) {
      if (owner.process === process) this.owners.delete(storeRoot);
    }
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function makeEnv(
  secretStore?: SecretStore,
  envVars: Record<string, string | undefined> = {},
  sharedRoot?: string,
): { env: Env; storeRoot: string; otherStoreRoot: string } {
  const root = sharedRoot ?? realpathSync(mkdtempSync(join(tmpdir(), "cellarer-authority-")));
  if (!sharedRoot) {
    cleanups.push(async () => {
      await createRealEnv().fs.rm(root, { recursive: true, force: true });
    });
  }
  const real = createRealEnv();
  const env: Env = {
    ...real,
    homedir: () => join(root, "home"),
    cwd: () => join(root, "cwd"),
    env: envVars,
    secretStore,
    randomId: () => "00000000-0000-4000-8000-000000000001",
  };
  mkdirSync(join(root, "cwd"), { recursive: true });
  mkdirSync(join(root, "home", ".cellarer"), { recursive: true });
  mkdirSync(join(root, "clone", ".cellarer"), { recursive: true });
  return {
    env,
    storeRoot: join(root, "home", ".cellarer"),
    otherStoreRoot: join(root, "clone", ".cellarer"),
  };
}

function request(storeRoot: string): MutationAuthorityRequest<"executable-plan-v1"> {
  return {
    schemaVersion: 1,
    domain: "executable-plan-v1",
    normalizedStoreRoot: storeRoot,
    operation: "apply",
    baseRevision: 3,
    canonicalPayload: '{"exact":"payload"}',
  };
}

describe("CLI mutation authority composition", () => {
  it("provisions a first-init keychain authority and verifies it by reading it back", async () => {
    const store = new MemorySecretStore();
    const { env, storeRoot } = makeEnv();

    const provisioned = await provisionMutationAuthority(env, storeRoot, store);
    const envelope = provisioned.seal(request(storeRoot));
    const loaded = await loadMutationAuthority(env, storeRoot, store);

    expect(store.setCalls).toBe(1);
    expect(store.getCalls).toBeGreaterThanOrEqual(3);
    expect(loaded?.verify(request(storeRoot), envelope)).toBe(true);
    expect(JSON.stringify(provisioned)).toBe("{}");
    expect(JSON.stringify(envelope)).not.toContain(Buffer.alloc(32, 0x2a).toString("base64url"));
  });

  it("14.1 converges relative and symlink Store aliases on one physical authority scope", async () => {
    const store = new MemorySecretStore();
    const { env, storeRoot } = makeEnv();
    await env.fs.mkdir(env.cwd(), { recursive: true });
    const provisioned = await provisionMutationAuthority(env, storeRoot, store);
    const alias = join(env.cwd(), "store-alias");
    await env.fs.symlink(storeRoot, alias, "dir");

    const caseAlias = join(env.cwd(), "STORE-ALIAS");
    const aliasedEnv: Env = {
      ...env,
      fs: {
        ...env.fs,
        realpath: async (path) => (path === caseAlias ? storeRoot : env.fs.realpath(path)),
      },
    };
    const fromAlias = await loadMutationAuthority(env, "store-alias", store);
    const fromCaseAlias = await loadMutationAuthority(aliasedEnv, "STORE-ALIAS", store);
    const envelope = provisioned.seal(request(storeRoot));

    expect(fromAlias?.verify(request(storeRoot), envelope)).toBe(true);
    expect(fromCaseAlias?.verify(request(storeRoot), envelope)).toBe(true);
    expect(store.values.size).toBe(1);
  });

  it("14.2 creates a missing Store only for explicit provisioning", async () => {
    const store = new MemorySecretStore();
    const { env } = makeEnv();
    const missing = join(env.cwd(), "missing-store");

    await expect(loadMutationAuthority(env, missing, store)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(env.fs.lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });

    await expect(provisionMutationAuthority(env, missing, store)).resolves.toBeDefined();
    await expect(env.fs.realpath(missing)).resolves.toBe(missing);
  });

  it("14.1 derives one headless kernel owner for physical Store aliases", async () => {
    const { env, storeRoot } = makeEnv(undefined, {
      [HEADLESS_MUTATION_AUTHORITY_ENV]: HEADLESS_KEY,
    });
    await env.fs.mkdir(env.cwd(), { recursive: true });
    await env.fs.mkdir(storeRoot, { recursive: true });
    const alias = join(env.cwd(), "headless-store-alias");
    await env.fs.symlink(storeRoot, alias, "dir");
    const acquiredRoots: string[] = [];
    const owner: HeadlessLifetimeOwner = {
      acquire: async (normalizedStoreRoot) => {
        acquiredRoots.push(normalizedStoreRoot);
        return Object.freeze({ isCurrent: async () => true });
      },
    };
    const scopedEnv: Env = { ...env, headlessLifetimeOwner: owner };

    const direct = await loadMutationAuthority(scopedEnv, storeRoot, null);
    const aliased = await loadMutationAuthority(scopedEnv, "headless-store-alias", null);
    const envelope = direct?.seal(request(storeRoot));

    if (!envelope) throw new Error("expected headless authority envelope");
    expect(aliased?.verify(request(storeRoot), envelope)).toBe(true);
    expect(acquiredRoots).toEqual([storeRoot]);
  });

  it("11.2 persists and exactly matches the latest journal tip in protected credential state", async () => {
    const store = new MemorySecretStore();
    const { env, storeRoot } = makeEnv();
    const tip = {
      operationId: "operation-protected-tip",
      sequence: 7,
      seal: `hmac-sha256:${"b".repeat(64)}`,
    } as const;
    const provisioned = await provisionMutationAuthority(env, storeRoot, store);

    expect(await provisioned.matchesJournalTip(tip)).toBe(false);
    await provisioned.publishJournalTip(tip);
    expect(await provisioned.matchesJournalTip(tip)).toBe(true);
    expect(await provisioned.matchesJournalTip({ ...tip, sequence: tip.sequence - 1 })).toBe(false);

    const reloaded = await loadMutationAuthority(env, storeRoot, store);
    expect(await reloaded?.matchesJournalTip(tip)).toBe(true);
    expect([...store.values.values()].some((value) => value === JSON.stringify(tip))).toBe(true);
  });

  it("11.2 treats an unreadable protected journal tip as a non-match", async () => {
    const store = new MemorySecretStore();
    const { env, storeRoot } = makeEnv();
    const authority = await provisionMutationAuthority(env, storeRoot, store);
    const tip = {
      operationId: "operation-unreadable-tip",
      sequence: 2,
      seal: `hmac-sha256:${"c".repeat(64)}`,
    } as const;
    await authority.publishJournalTip(tip);
    store.getError = true;

    await expect(authority.matchesJournalTip(tip)).resolves.toBe(false);
  });

  it("fails provisioning when the credential cannot be read back exactly", async () => {
    const store = new MemorySecretStore();
    store.discardWrites = true;
    const { env, storeRoot } = makeEnv();

    await expect(provisionMutationAuthority(env, storeRoot, store)).rejects.toThrow(
      "read-back verification failed",
    );

    store.discardWrites = false;
    await expect(provisionMutationAuthority(env, storeRoot, store)).resolves.toBeDefined();
    expect(store.setCalls).toBe(2);
  });

  it("fails closed for unavailable providers and never discloses provider internals", async () => {
    const absent = makeEnv(undefined);
    await expect(provisionMutationAuthority(absent.env, absent.storeRoot, null)).rejects.toThrow(
      "mutation authority provider is unavailable",
    );

    const lockedStore = new MemorySecretStore();
    lockedStore.getError = true;
    const locked = makeEnv(lockedStore);
    const failure = await loadMutationAuthority(locked.env, locked.storeRoot, lockedStore).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("mutation authority provider is unavailable");
    expect((failure as Error).message).not.toContain("provider internals");
  });

  it("uses the one protected headless channel, scopes it to the Store, and never falls back", async () => {
    const store = new MemorySecretStore();
    store.getError = true;
    const { env, storeRoot, otherStoreRoot } = makeEnv(undefined, {
      [HEADLESS_MUTATION_AUTHORITY_ENV]: HEADLESS_KEY,
    });

    const authority = await loadMutationAuthority(env, storeRoot);
    const cloneAuthority = await loadMutationAuthority(env, otherStoreRoot);
    const envelope = authority?.seal(request(storeRoot));

    expect(store.getCalls).toBe(0);
    if (!envelope) throw new Error("expected a headless authority envelope");
    expect(cloneAuthority?.verify(request(storeRoot), envelope)).toBe(false);
    expect(JSON.stringify(authority)).not.toContain(HEADLESS_KEY);

    env.env[HEADLESS_MUTATION_AUTHORITY_ENV] = "malformed-explicit-value";
    await expect(loadMutationAuthority(env, storeRoot)).rejects.toThrow(
      "protected environment authority is malformed",
    );
    expect(store.getCalls).toBe(0);
  });

  it("11.3 keeps a headless journal tip only in the authority instance that published it", async () => {
    const { env, storeRoot } = makeEnv(undefined, {
      [HEADLESS_MUTATION_AUTHORITY_ENV]: HEADLESS_KEY,
    });
    const tip = {
      operationId: "operation-headless-tip",
      sequence: 3,
      seal: `hmac-sha256:${"d".repeat(64)}`,
    } as const;
    const currentProcess = await loadMutationAuthority(env, storeRoot, null);
    if (!currentProcess) throw new Error("expected headless authority");
    await currentProcess.publishJournalTip(tip);

    expect(await currentProcess.matchesJournalTip(tip)).toBe(true);
    const restartedProcess = await loadMutationAuthority(env, storeRoot, null);
    expect(await restartedProcess?.matchesJournalTip(tip)).toBe(false);
  });

  it("13.1 rejects Store-byte replay after a newer headless epoch takes ownership", async () => {
    const shared = makeEnv(undefined, {
      [HEADLESS_MUTATION_AUTHORITY_ENV]: HEADLESS_KEY,
    });
    const lifetimeOwners = new FakeHeadlessLifetimeOwners();
    const firstEnv: Env = {
      ...shared.env,
      processId: () => 101,
      hostname: () => "shared-host",
      headlessLifetimeOwner: lifetimeOwners.forProcess("process-a"),
    };
    const secondEnv: Env = {
      ...shared.env,
      env: { [HEADLESS_MUTATION_AUTHORITY_ENV]: NEXT_HEADLESS_KEY },
      processId: () => 202,
      hostname: () => "shared-host",
      headlessLifetimeOwner: lifetimeOwners.forProcess("process-b"),
    };

    const first = await loadMutationAuthority(firstEnv, shared.storeRoot, null);
    if (!first) throw new Error("expected first headless authority");
    const legacyOwnerPath = join(shared.storeRoot, "headless-authority-owner.lock");
    await expect(firstEnv.fs.lstat(legacyOwnerPath)).rejects.toMatchObject({ code: "ENOENT" });
    firstEnv.mutationAuthority = first;
    await initializeStore(firstEnv, shared.storeRoot);
    await firstEnv.fs.mkdir(firstEnv.cwd(), { recursive: true });
    const source = join(firstEnv.cwd(), "headless-owner-replay.md");
    await firstEnv.fs.writeFile(source, "# owner replay must remain stale\n");
    const added = await add(firstEnv, { storeRoot: shared.storeRoot, source });
    expect(added.operation).toMatchObject({ ok: true });
    const options = {
      storeRoot: shared.storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["rules" as const],
    };
    const prepared = await planApplyMutation(firstEnv, options);
    const mutationTarget = prepared.plan.actions.find((action) => action.op !== "skip")?.target;
    if (!mutationTarget) throw new Error("expected a mutation target");

    await expect(loadMutationAuthority(secondEnv, shared.storeRoot, null)).rejects.toThrow(
      /headless mutation authority owner is active/i,
    );
    expect(await first.isCurrent()).toBe(true);

    lifetimeOwners.exit("process-a");
    const second = await loadMutationAuthority(secondEnv, shared.storeRoot, null);
    expect(await first.isCurrent()).toBe(false);
    expect(await second?.isCurrent()).toBe(true);

    await firstEnv.fs.publishFileAtomically(
      legacyOwnerPath,
      replayableLegacyOwner(shared.storeRoot),
      { mode: 0o600 },
    );
    expect(await first.isCurrent()).toBe(false);
    expect(await second?.isCurrent()).toBe(true);

    const replayed = await applyMutationPlan(firstEnv, prepared.mutationPlan, {
      storeRoot: shared.storeRoot,
      options,
    });
    expect(replayed.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });
    await expect(firstEnv.fs.lstat(mutationTarget)).rejects.toMatchObject({ code: "ENOENT" });

    await firstEnv.fs.writeFile(legacyOwnerPath, '{"attacker":"replacement"}\n');
    expect(await first.isCurrent()).toBe(false);
    expect(await second?.isCurrent()).toBe(true);
    await firstEnv.fs.rm(legacyOwnerPath, { force: true });
    expect(await first.isCurrent()).toBe(false);
    expect(await second?.isCurrent()).toBe(true);
    await expect(loadMutationAuthority(firstEnv, shared.storeRoot, null)).rejects.toThrow(
      /headless mutation authority owner is active/i,
    );
  });

  it("13.2 reuses one same-process lease but refuses a different epoch", async () => {
    const lifetimeOwners = new FakeHeadlessLifetimeOwners();
    const shared = makeEnv(undefined, {
      [HEADLESS_MUTATION_AUTHORITY_ENV]: HEADLESS_KEY,
    });
    const firstEnv: Env = {
      ...shared.env,
      processId: () => 303,
      hostname: () => "same-process-host",
      headlessLifetimeOwner: lifetimeOwners.forProcess("same-process"),
    };
    const differentEpochEnv: Env = {
      ...firstEnv,
      env: { [HEADLESS_MUTATION_AUTHORITY_ENV]: NEXT_HEADLESS_KEY },
    };

    const first = await loadMutationAuthority(firstEnv, shared.storeRoot, null);
    const reloaded = await loadMutationAuthority(firstEnv, shared.storeRoot, null);
    expect(await first?.isCurrent()).toBe(true);
    expect(await reloaded?.isCurrent()).toBe(true);
    await expect(loadMutationAuthority(differentEpochEnv, shared.storeRoot, null)).rejects.toThrow(
      /headless mutation authority owner is active/i,
    );
    expect(await first?.isCurrent()).toBe(true);
  });

  it("13.2 lets exactly one of two concurrent headless processes own a Store", async () => {
    const lifetimeOwners = new FakeHeadlessLifetimeOwners();
    const shared = makeEnv();
    const firstEnv: Env = {
      ...shared.env,
      env: { [HEADLESS_MUTATION_AUTHORITY_ENV]: HEADLESS_KEY },
      processId: () => 404,
      hostname: () => "concurrent-host",
      headlessLifetimeOwner: lifetimeOwners.forProcess("concurrent-a"),
    };
    const secondEnv: Env = {
      ...shared.env,
      env: { [HEADLESS_MUTATION_AUTHORITY_ENV]: NEXT_HEADLESS_KEY },
      processId: () => 505,
      hostname: () => "concurrent-host",
      headlessLifetimeOwner: lifetimeOwners.forProcess("concurrent-b"),
    };

    const results = await Promise.allSettled([
      loadMutationAuthority(firstEnv, shared.storeRoot, null),
      loadMutationAuthority(secondEnv, shared.storeRoot, null),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled" || !winner.value) {
      throw new Error("expected one headless owner");
    }
    expect(await winner.value.isCurrent()).toBe(true);
  });

  it("removes protected headless key material before Core/Web receive Env", async () => {
    const { env, storeRoot } = makeEnv(undefined, {
      [HEADLESS_MUTATION_AUTHORITY_ENV]: HEADLESS_KEY,
      ORDINARY_VALUE: "kept",
    });

    await attachMutationAuthority(env, storeRoot, "required");

    expect(env.mutationAuthority).toBeDefined();
    expect(env.env[HEADLESS_MUTATION_AUTHORITY_ENV]).toBeUndefined();
    expect(env.env.ORDINARY_VALUE).toBe("kept");
    expect(JSON.stringify(env)).not.toContain(HEADLESS_KEY);
    await expect(rotateMutationAuthority(env, storeRoot)).rejects.toThrow(
      `replace ${HEADLESS_MUTATION_AUTHORITY_ENV}`,
    );
  });

  it("keeps read-only composition available when authority is absent or malformed", async () => {
    const absent = makeEnv(undefined);
    await expect(
      attachMutationAuthority(absent.env, absent.storeRoot, "optional", null),
    ).resolves.toBeUndefined();
    expect(absent.env.mutationAuthority).toBeUndefined();

    const malformed = makeEnv(undefined, {
      [HEADLESS_MUTATION_AUTHORITY_ENV]: "not-a-key",
    });
    await expect(
      attachMutationAuthority(malformed.env, malformed.storeRoot, "optional", null),
    ).resolves.toBeUndefined();
    expect(malformed.env.env[HEADLESS_MUTATION_AUTHORITY_ENV]).toBeUndefined();
    expect(malformed.env.mutationAuthority).toBeUndefined();

    await expect(
      attachMutationAuthority(absent.env, absent.storeRoot, "required", null),
    ).rejects.toThrow("mutation authority is unavailable");
  });

  it("11.4 skips every authority-provider call for composition mode none", async () => {
    const store = new MemorySecretStore();
    const { env, storeRoot } = makeEnv();

    await attachMutationAuthority(env, storeRoot, "none", store);

    expect(store.getCalls).toBe(0);
    expect(store.setCalls).toBe(0);
    expect(env.mutationAuthority).toBeUndefined();
  });

  it("refuses rotation while any active journal exists without touching the credential", async () => {
    const store = new MemorySecretStore();
    const { env, storeRoot } = makeEnv();
    await provisionMutationAuthority(env, storeRoot, store);
    await env.fs.mkdir(join(storeRoot, "operations"), { recursive: true });
    await env.fs.writeFile(operationJournalPath(storeRoot), "interrupted\n", { mode: 0o600 });
    const beforeSetCalls = store.setCalls;

    await expect(rotateMutationAuthority(env, storeRoot, store)).rejects.toThrow(
      "active operation journal",
    );
    expect(store.setCalls).toBe(beforeSetCalls);

    await env.fs.rm(operationJournalPath(storeRoot));
    await expect(rotateMutationAuthority(env, storeRoot, store)).resolves.toBeDefined();
    expect(store.setCalls).toBe(beforeSetCalls + 1);
  });

  it("invalidates prior seals after explicit rotation", async () => {
    const store = new MemorySecretStore();
    const { env, storeRoot } = makeEnv();
    const original = await provisionMutationAuthority(env, storeRoot, store);
    const oldEnvelope = original.seal(request(storeRoot));

    const rotated = await rotateMutationAuthority(env, storeRoot, store);
    const newEnvelope = rotated.seal(request(storeRoot));

    expect(rotated.verify(request(storeRoot), oldEnvelope)).toBe(false);
    expect(newEnvelope.authorityEpoch).toBe(oldEnvelope.authorityEpoch + 1);
    expect(newEnvelope.authorityId).toBe(oldEnvelope.authorityId);
  });

  it("does not reuse a persistent authority when a Store is moved or cloned", async () => {
    const store = new MemorySecretStore();
    const { env, storeRoot, otherStoreRoot } = makeEnv();
    const original = await provisionMutationAuthority(env, storeRoot, store);

    expect(await loadMutationAuthority(env, otherStoreRoot, store)).toBeUndefined();
    const envelope = original.seal(request(storeRoot));
    expect(original.verify(request(otherStoreRoot), envelope)).toBe(false);
  });

  it("serializes concurrent first provisioning so every initializer receives the winning key", async () => {
    const store = new MemorySecretStore();
    const first = makeEnv();
    const second = makeEnv(undefined, {}, first.env.cwd().replace(/\/cwd$/, ""));

    const [left, right] = await Promise.all([
      provisionMutationAuthority(first.env, first.storeRoot, store),
      provisionMutationAuthority(second.env, second.storeRoot, store),
    ]);
    const envelope = left.seal(request(first.storeRoot));

    expect(store.setCalls).toBe(1);
    expect(right.verify(request(first.storeRoot), envelope)).toBe(true);
  });

  it("serializes rotation behind mutation and recovery authority leases", async () => {
    const store = new MemorySecretStore();
    const { env, storeRoot } = makeEnv();
    const authority = await provisionMutationAuthority(env, storeRoot, store);
    const lease = await authority.acquireLease();
    let rotated = false;

    const rotation = rotateMutationAuthority(env, storeRoot, store).then((next) => {
      rotated = true;
      return next;
    });
    await Promise.resolve();
    expect(rotated).toBe(false);

    await lease.release();
    const next = await rotation;
    expect(await authority.isCurrent()).toBe(false);
    expect(await next.isCurrent()).toBe(true);
  });

  it.each([
    { label: "mutation", path: mutationLockPath },
    { label: "recovery", path: recoveryLockPath },
  ])("refuses rotation while $label exclusion is active", async ({ label, path }) => {
    const store = new MemorySecretStore();
    const { env, storeRoot } = makeEnv();
    await provisionMutationAuthority(env, storeRoot, store);
    const owner = {
      operationId: `${label}-operation`,
      processId: 333,
      hostname: "other-process",
      acquiredAt: "2026-07-30T00:00:00.000Z",
    };
    await env.fs.writeFile(path(storeRoot), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    const beforeSetCalls = store.setCalls;

    await expect(rotateMutationAuthority(env, storeRoot, store)).rejects.toThrow(label);
    expect(store.setCalls).toBe(beforeSetCalls);
  });
});
