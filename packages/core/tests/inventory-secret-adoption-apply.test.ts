import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  applyInventorySecretAdoptionPlan,
  planInventorySecretAdoption,
} from "../src/inventory/adoption.js";
import { refreshInventory } from "../src/inventory/projector.js";
import type {
  InventorySecretAdoptionOffer,
  InventorySecretAdoptionProvider,
  InventorySecretFieldSelector,
  MutationPlan,
} from "../src/protocol/client-types.js";
import { operationJournalPath } from "../src/protocol/journal.js";
import { publishStoreRevision, readStoreRevision } from "../src/protocol/store-revision.js";
import type {
  InventorySecretAdoptionProviderPort,
  InventorySecretReferenceBinding,
} from "../src/secrets/adoption-provider.js";
import { useSecretValue } from "../src/secrets/observable.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const SECRET_CANARY = "inventory-adoption-apply-canary-value";

describe("Inventory secret-adoption apply", () => {
  let t: TmpEnv;
  let storeRoot: string;
  let sourcePath: string;

  beforeEach(async () => {
    t = makeTmpEnv({ randomId: () => "inventory-adoption-apply" });
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    sourcePath = t.path("home", ".claude.json");
    await initStore(t.env, storeRoot);
    await t.env.fs.mkdir(join(sourcePath, ".."), { recursive: true });
    await writeSource(SECRET_CANARY);
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it.each([
    "vault",
    "keychain",
  ] as const)("creates exactly the bound absent %s reference and publishes reference-only Store bytes", async (providerKind) => {
    const calls: InventorySecretReferenceBinding[] = [];
    let receivedValue: string | undefined;
    const generalProviderCalls = { get: 0, set: 0, delete: 0 };
    const providerPort: InventorySecretAdoptionProviderPort = {
      createExactAbsentReference: async (binding, readBoundSourceValue) => {
        calls.push(binding);
        const value = await readBoundSourceValue();
        receivedValue = useSecretValue(value, (plaintext) => plaintext);
        return { created: true };
      },
    };
    const env: Env = {
      ...t.env,
      inventorySecretAdoptionProvider: providerPort,
      secretStore: {
        get: async () => {
          generalProviderCalls.get += 1;
          return { found: false };
        },
        set: async () => {
          generalProviderCalls.set += 1;
        },
        delete: async () => {
          generalProviderCalls.delete += 1;
          return false;
        },
      },
    };
    const planned = await plan(providerKind, env);
    const sourceBefore = await env.fs.readFile(sourcePath);
    const targetBefore = await env.fs.snapshotTreeNoFollow(env.cwd());

    const applied = await applyInventorySecretAdoptionPlan(env, planned.mutationPlan, {
      storeRoot,
    });

    expect(applied.status).toBe("applied");
    expect(applied.operation.ok).toBe(true);
    expect(calls).toEqual([
      {
        provider: planned.provider,
        providerPrecondition: { state: "absent" },
        targetName: planned.targetName,
      },
    ]);
    expect(receivedValue).toBe(SECRET_CANARY);
    expect(generalProviderCalls).toEqual({ get: 0, set: 0, delete: 0 });
    const published = await env.fs.readFile(join(storeRoot, "store", "mcp", "sample.json"));
    expect(published).toContain(`\${CELLARER_SECRET:${planned.targetName}}`);
    expect(published).not.toContain(SECRET_CANARY);
    expect(await env.fs.readFile(sourcePath)).toBe(sourceBefore);
    expect(await env.fs.snapshotTreeNoFollow(env.cwd())).toEqual(targetBefore);
    await expect(env.fs.lstat(operationJournalPath(storeRoot))).rejects.toThrow();
    expect(JSON.stringify(applied)).not.toContain(SECRET_CANARY);
  });

  it("rejects stale source and invalid authority before provider, lock, journal, or Store effects", async () => {
    let providerCalls = 0;
    const env: Env = {
      ...t.env,
      inventorySecretAdoptionProvider: {
        createExactAbsentReference: async () => {
          providerCalls += 1;
          return { created: true };
        },
      },
    };
    const planned = await plan("vault", env);
    const forged = JSON.parse(JSON.stringify(planned.mutationPlan)) as Mutable<MutationPlan>;
    forged.authorization.seal = `hmac-sha256:${"0".repeat(64)}`;

    const invalid = await applyInventorySecretAdoptionPlan(env, forged, { storeRoot });
    await writeSource(`${SECRET_CANARY}-drifted`);
    const stale = await applyInventorySecretAdoptionPlan(env, planned.mutationPlan, { storeRoot });

    expect(invalid.status).toBe("rejected");
    expect(invalid.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    expect(stale.status).toBe("rejected");
    expect(stale.operation).toMatchObject({
      ok: false,
      conflict: { code: "TARGET_PRECONDITION_CONFLICT" },
    });
    expect(providerCalls).toBe(0);
    await expect(env.fs.lstat(operationJournalPath(storeRoot))).rejects.toThrow();
    await expect(env.fs.lstat(join(storeRoot, "store", "mcp", "sample.json"))).rejects.toThrow();
  });

  it("rejects a stale Store revision before the single narrow provider call", async () => {
    let providerCalls = 0;
    const env: Env = {
      ...t.env,
      inventorySecretAdoptionProvider: {
        createExactAbsentReference: async () => {
          providerCalls += 1;
          return { created: true };
        },
      },
    };
    const planned = await plan("vault", env);
    await publishStoreRevision(env, storeRoot, (await readStoreRevision(env, storeRoot)) + 1);

    const stale = await applyInventorySecretAdoptionPlan(env, planned.mutationPlan, { storeRoot });

    expect(stale.status).toBe("rejected");
    expect(stale.operation).toMatchObject({ ok: false, conflict: { code: "STALE_REVISION" } });
    expect(providerCalls).toBe(0);
    await expect(env.fs.lstat(operationJournalPath(storeRoot))).rejects.toThrow();
  });

  it("maps an existing reference and provider errors without reading or disclosing the source", async () => {
    let readCalls = 0;
    let createCalls = 0;
    const port: InventorySecretAdoptionProviderPort = {
      createExactAbsentReference: async (_binding, read) => {
        createCalls += 1;
        if (createCalls === 1) return { created: false, reason: "already-exists" };
        readCalls += 1;
        await read();
        throw new Error(`provider failed: ${SECRET_CANARY}`);
      },
    };
    const env: Env = { ...t.env, inventorySecretAdoptionProvider: port };
    const first = await plan("keychain", env);

    const present = await applyInventorySecretAdoptionPlan(env, first.mutationPlan, { storeRoot });
    const unavailable = await applyInventorySecretAdoptionPlan(env, first.mutationPlan, {
      storeRoot,
    });

    expect(present.status).toBe("provider-precondition-conflict");
    expect(unavailable.status).toBe("rejected");
    expect(readCalls).toBe(1);
    expect(createCalls).toBe(2);
    expect(JSON.stringify([present, unavailable])).not.toContain(SECRET_CANARY);
    await expect(env.fs.lstat(join(storeRoot, "store", "mcp", "sample.json"))).rejects.toThrow();
  });

  async function plan(provider: "vault" | "keychain", env: Env = t.env) {
    const { candidateId, offer } = await offeredCandidate(env);
    return planInventorySecretAdoption(env, {
      storeRoot,
      candidateId,
      selector: offer.selector,
      provider,
      refresh: { agentId: "claude-code" },
    });
  }

  async function offeredCandidate(env: Env): Promise<{
    candidateId: string;
    offer: InventorySecretAdoptionOffer;
  }> {
    const inventory = await refreshInventory(env, { storeRoot, agentId: "claude-code" });
    const candidate = inventory.candidates.find(({ name }) => name === "sample");
    const offer = candidate?.findings.find(({ adoption }) => adoption)?.adoption;
    if (!candidate || !offer) throw new Error("missing adoption offer");
    return { candidateId: candidate.id, offer };
  }

  async function writeSource(value: string): Promise<void> {
    await t.env.fs.writeFile(
      sourcePath,
      `${JSON.stringify(
        { mcpServers: { sample: { command: "tool", env: { API_TOKEN: value } } } },
        null,
        2,
      )}\n`,
    );
  }
});

type Mutable<Value> = Value extends InventorySecretAdoptionProvider | InventorySecretFieldSelector
  ? Value
  : Value extends readonly (infer Item)[]
    ? Mutable<Item>[]
    : Value extends object
      ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
      : Value;
