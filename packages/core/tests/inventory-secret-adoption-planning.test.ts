import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env, SecretStore } from "../src/env.js";
import {
  decodeInventorySecretAdoptionPlan,
  InventorySecretAdoptionPlanningError,
  planInventorySecretAdoption,
} from "../src/inventory/adoption.js";
import { refreshInventory } from "../src/inventory/projector.js";
import { createAuthorizedMutationPlan } from "../src/protocol/canonical.js";
import type {
  InventoryCandidate,
  InventorySecretAdoptionOffer,
  MutationPlan,
  MutationPlanInput,
} from "../src/protocol/client-types.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const SECRET_CANARY = "inventory-adoption-plan-canary-value";

describe("Inventory secret-adoption planning", () => {
  let t: TmpEnv;
  let storeRoot: string;
  let sourcePath: string;

  beforeEach(async () => {
    t = makeTmpEnv({ randomId: () => "inventory-adoption-plan" });
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    sourcePath = t.path("home", ".claude", "mcp.json");
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
  ] as const)("seals one exact reference-bearing plan for the %s provider", async (provider) => {
    const { candidate, offer } = await offeredCandidate();
    const before = await t.env.fs.snapshotTreeNoFollow(storeRoot);

    const planned = await planInventorySecretAdoption(t.env, {
      storeRoot,
      candidateId: candidate.id,
      selector: offer.selector,
      provider,
      refresh: { agentId: "claude-code" },
    });

    expect(planned).toMatchObject({
      candidateId: candidate.id,
      selector: offer.selector,
      targetName: offer.targetName,
      provider:
        provider === "vault" ? { kind: "vault" } : { kind: "keychain", service: "cellarer" },
      mutationPlan: {
        operation: "store-import",
        normalizedInputs: {
          mutationKind: "inventory-secret-adoption",
          candidateId: candidate.id,
          candidateName: "sample",
          providerPrecondition: { state: "absent" },
        },
      },
    });
    expect(planned.mutationPlan.actions.map(({ kind }) => kind)).toEqual([
      "inventory-resource-content",
      "inventory-resource-metadata",
    ]);
    expect(planned.mutationPlan.targetPreconditions).toHaveLength(2);
    expect(
      planned.mutationPlan.targetPreconditions.every(({ expected }) => expected.state === "absent"),
    ).toBe(true);
    expect(
      decodeInventorySecretAdoptionPlan(t.env, storeRoot, planned.mutationPlan),
    ).not.toBeNull();
    const serialized = JSON.stringify(planned);
    expect(serialized).not.toContain(SECRET_CANARY);
    expect(serialized).not.toContain(Buffer.from(SECRET_CANARY).toString("base64"));
    expect(serialized).toContain(`\${CELLARER_SECRET:${offer.targetName}}`);
    expect(await t.env.fs.snapshotTreeNoFollow(storeRoot)).toEqual(before);
  });

  it("performs no provider access while planning", async () => {
    const calls = { get: 0, set: 0, delete: 0 };
    const provider: SecretStore = {
      get: async () => {
        calls.get += 1;
        return { found: false };
      },
      set: async () => {
        calls.set += 1;
      },
      delete: async () => {
        calls.delete += 1;
        return false;
      },
    };
    const env: Env = { ...t.env, secretStore: provider };
    const { candidate, offer } = await offeredCandidate(env);

    await planInventorySecretAdoption(env, {
      storeRoot,
      candidateId: candidate.id,
      selector: offer.selector,
      provider: "keychain",
      refresh: { agentId: "claude-code" },
    });

    expect(calls).toEqual({ get: 0, set: 0, delete: 0 });
  });

  it("rejects selector, candidate, provider, absence, source, and action-set mutations", async () => {
    const { candidate, offer } = await offeredCandidate();
    const planned = await planInventorySecretAdoption(t.env, {
      storeRoot,
      candidateId: candidate.id,
      selector: offer.selector,
      provider: "vault",
      refresh: { agentId: "claude-code" },
    });
    const attacks: MutationPlan[] = [
      resign(planned.mutationPlan, (input) => {
        input.normalizedInputs.selector = { ...offer.selector, name: "CLIENT_SECRET" };
      }),
      resign(planned.mutationPlan, (input) => {
        input.normalizedInputs.selector = { ...offer.selector, name: "REGION" };
      }),
      resign(planned.mutationPlan, (input) => {
        input.normalizedInputs.candidateId = `inventory-candidate:v1:mcp:${"0".repeat(64)}`;
      }),
      resign(planned.mutationPlan, (input) => {
        input.normalizedInputs.provider = { kind: "environment" };
      }),
      resign(planned.mutationPlan, (input) => {
        input.normalizedInputs.providerPrecondition = { state: "present" };
      }),
      resign(planned.mutationPlan, (input) => {
        const payload = input.actions[0]?.payload;
        if (payload && typeof payload.source === "object" && payload.source !== null) {
          (payload.source as Record<string, unknown>).fingerprint = `sha256:${"0".repeat(64)}`;
        }
      }),
      resign(planned.mutationPlan, (input) => {
        input.actions.push({
          actionId: "target-injection",
          kind: "write",
          target: t.path("cwd", "agent-target"),
          payload: {},
          postcondition: { state: "present", fingerprint: `sha256:${"0".repeat(64)}` },
        });
        input.targetPreconditions.push({
          actionId: "target-injection",
          target: t.path("cwd", "agent-target"),
          expected: { state: "absent" },
        });
      }),
    ];

    for (const attack of attacks) {
      expect(decodeInventorySecretAdoptionPlan(t.env, storeRoot, attack)).toBeNull();
    }
  });

  it("rejects unsupported providers, existing references, and refreshed source drift", async () => {
    const { candidate, offer } = await offeredCandidate();
    await expect(
      planInventorySecretAdoption(t.env, {
        storeRoot,
        candidateId: candidate.id,
        selector: offer.selector,
        provider: "environment" as "vault",
        refresh: { agentId: "claude-code" },
      }),
    ).rejects.toMatchObject({ reason: "PROVIDER_UNSUPPORTED" });

    await writeSource(`\${CELLARER_SECRET:already-managed}`);
    await expect(
      planInventorySecretAdoption(t.env, {
        storeRoot,
        candidateId: candidate.id,
        selector: offer.selector,
        provider: "vault",
        refresh: { agentId: "claude-code" },
      }),
    ).rejects.toBeInstanceOf(InventorySecretAdoptionPlanningError);

    await writeSource(`${SECRET_CANARY}-drifted`);
    await expect(
      planInventorySecretAdoption(t.env, {
        storeRoot,
        candidateId: candidate.id,
        selector: offer.selector,
        provider: "vault",
        refresh: { agentId: "claude-code" },
      }),
    ).rejects.toMatchObject({ reason: "CANDIDATE_NOT_ADOPTABLE" });
  });

  async function offeredCandidate(env: Env = t.env): Promise<{
    candidate: InventoryCandidate;
    offer: InventorySecretAdoptionOffer;
  }> {
    const inventory = await refreshInventory(env, { storeRoot, agentId: "claude-code" });
    const candidate = inventory.candidates.find(({ name }) => name === "sample");
    const offer = candidate?.findings.find(({ adoption }) => adoption)?.adoption;
    if (!candidate || !offer) throw new Error("missing adoption offer");
    return { candidate, offer };
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

  function resign(
    plan: MutationPlan,
    mutate: (input: MutableMutationPlanInput) => void,
  ): MutationPlan {
    const {
      authorization: _authorization,
      digest: _digest,
      ...raw
    } = JSON.parse(JSON.stringify(plan)) as MutationPlan;
    const input = raw as MutableMutationPlanInput;
    mutate(input);
    return createAuthorizedMutationPlan(t.env, storeRoot, input);
  }
});

type MutableMutationPlanInput = MutationPlanInput & {
  normalizedInputs: Record<string, unknown>;
  actions: MutationPlanInput["actions"] extends readonly (infer Action)[] ? Action[] : never;
  targetPreconditions: MutationPlanInput["targetPreconditions"] extends readonly (infer Item)[]
    ? Item[]
    : never;
};
