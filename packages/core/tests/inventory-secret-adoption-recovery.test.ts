import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env, FsLike } from "../src/env.js";
import {
  applyInventorySecretAdoptionPlan,
  planInventorySecretAdoption,
} from "../src/inventory/adoption.js";
import { refreshInventory } from "../src/inventory/projector.js";
import { readOperationJournal } from "../src/protocol/journal.js";
import { diagnoseMutationRecovery } from "../src/protocol/recovery.js";
import type { InventorySecretAdoptionProviderPort } from "../src/secrets/adoption-provider.js";
import { useSecretValue } from "../src/secrets/observable.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const SECRET_CANARY = "inventory-adoption-orphan-canary-value";

describe("Inventory secret-adoption orphan recovery", () => {
  let t: TmpEnv;
  let storeRoot: string;
  let sourcePath: string;

  beforeEach(async () => {
    t = makeTmpEnv({ randomId: () => "inventory-adoption-orphan" });
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    sourcePath = t.path("home", ".claude", "mcp.json");
    await initStore(t.env, storeRoot);
    await t.env.fs.mkdir(join(sourcePath, ".."), { recursive: true });
    await t.env.fs.writeFile(
      sourcePath,
      `${JSON.stringify(
        { mcpServers: { sample: { command: "tool", env: { API_TOKEN: SECRET_CANARY } } } },
        null,
        2,
      )}\n`,
    );
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it.each([
    "vault",
    "keychain",
  ] as const)("retains stable typed %s orphan evidence after provider success and Store failure", async (providerKind) => {
    let createCalls = 0;
    let deleteCalls = 0;
    const providerPort: InventorySecretAdoptionProviderPort = {
      createExactAbsentReference: async (_binding, read) => {
        createCalls += 1;
        expect(useSecretValue(await read(), (value) => value)).toBe(SECRET_CANARY);
        return { created: true };
      },
    };
    const planningEnv: Env = { ...t.env, inventorySecretAdoptionProvider: providerPort };
    const inventory = await refreshInventory(planningEnv, {
      storeRoot,
      agentId: "claude-code",
    });
    const candidate = inventory.candidates.find(({ name }) => name === "sample");
    const offer = candidate?.findings.find(({ adoption }) => adoption)?.adoption;
    if (!candidate || !offer) throw new Error("missing adoption offer");
    const planned = await planInventorySecretAdoption(planningEnv, {
      storeRoot,
      candidateId: candidate.id,
      selector: offer.selector,
      provider: providerKind,
      refresh: { agentId: "claude-code" },
    });
    const contentTarget = join(storeRoot, "store", "mcp", "sample.json");
    const failingFs: FsLike = {
      ...planningEnv.fs,
      publishFileAtomically: async (path, data, options) => {
        if (path === contentTarget) {
          throw Object.assign(new Error(`disk failed: ${SECRET_CANARY}`), { code: "EIO" });
        }
        return planningEnv.fs.publishFileAtomically(path, data, options);
      },
    };
    const env: Env = {
      ...planningEnv,
      fs: failingFs,
      secretStore: {
        get: async () => ({ found: false }),
        set: async () => undefined,
        delete: async () => {
          deleteCalls += 1;
          return true;
        },
      },
    };

    const applied = await applyInventorySecretAdoptionPlan(env, planned.mutationPlan, {
      storeRoot,
    });
    const journal = await readOperationJournal(env, storeRoot);
    const firstDiagnosis = await diagnoseMutationRecovery(env, storeRoot);
    const secondDiagnosis = await diagnoseMutationRecovery(env, storeRoot);

    const expectedCleanup = `cellarer secret rm ${planned.targetName} --provider ${providerKind}`;
    const evidence = {
      status: "provider-created-store-unpublished",
      provider: planned.provider,
      targetName: planned.targetName,
      cleanupCommand: expectedCleanup,
    };
    expect(applied).toMatchObject({
      status: "orphaned-reference",
      orphan: evidence,
      operation: { ok: false },
    });
    expect(journal).toMatchObject({
      status: "recovery-required",
      externalEffects: [
        {
          status: "succeeded",
          evidence,
        },
      ],
    });
    expect(firstDiagnosis).toMatchObject({
      status: "manual-recovery-required",
      orphanEvidence: evidence,
    });
    expect(secondDiagnosis.orphanEvidence).toEqual(firstDiagnosis.orphanEvidence);
    expect(createCalls).toBe(1);
    expect(deleteCalls).toBe(0);
    expect(JSON.stringify([applied, journal, firstDiagnosis])).not.toContain(SECRET_CANARY);
    expect(JSON.stringify([applied, journal, firstDiagnosis])).not.toContain(
      Buffer.from(SECRET_CANARY).toString("base64"),
    );
    await expect(env.fs.lstat(contentTarget)).rejects.toThrow();
    expect(await env.fs.readFile(sourcePath)).toContain(SECRET_CANARY);
  });
});
