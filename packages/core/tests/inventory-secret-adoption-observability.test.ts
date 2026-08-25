import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env, SecretStore } from "../src/env.js";
import { inventorySecretAdoptionOffers } from "../src/inventory/adoption-fields.js";
import { planInventoryStoreImport } from "../src/inventory/import.js";
import { refreshInventory } from "../src/inventory/projector.js";
import { redactObservable } from "../src/secrets/observable.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const SECRET_CANARY = "inventory-adoption-observable-canary";

describe("Inventory secret-adoption observability", () => {
  let t: TmpEnv;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("returns only redacted selector and derived target metadata", () => {
    const offers = inventorySecretAdoptionOffers("demo", {
      kind: "stdio",
      command: "tool",
      env: { API_TOKEN: SECRET_CANARY },
    });
    const serialized = JSON.stringify(redactObservable("web", offers));

    expect(offers).toEqual([
      expect.objectContaining({
        selector: { kind: "environment", server: "demo", name: "API_TOKEN" },
        targetName: expect.stringMatching(/^mcp-demo-environment-api-token-[a-f0-9]{8}$/),
      }),
    ]);
    expect(serialized).not.toContain(SECRET_CANARY);
    expect(serialized).not.toContain(Buffer.from(SECRET_CANARY).toString("base64"));
  });

  it("keeps ordinary refresh and Store-import planning provider-free", async () => {
    const calls = { get: 0, set: 0, delete: 0 };
    const secretStore: SecretStore = {
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
    const env: Env = { ...t.env, secretStore };
    const storeRoot = t.path("home", ".cellarer");
    await initStore(env, storeRoot);
    await env.fs.mkdir(t.path("home", ".agents"), { recursive: true });
    await env.fs.writeFile(t.path("home", ".agents", "AGENTS.md"), "# Safe rules\n");

    const inventory = await refreshInventory(env, { storeRoot, agentId: "agents-md" });
    const candidate = inventory.candidates.find((item) => item.state === "ready");
    expect(candidate).toBeDefined();
    await planInventoryStoreImport(env, {
      storeRoot,
      candidateIds: [candidate?.id as string],
      refresh: { agentId: "agents-md" },
    });

    expect(calls).toEqual({ get: 0, set: 0, delete: 0 });
  });

  it("classifies adoption offers without retaining the source value", () => {
    const offers = inventorySecretAdoptionOffers("demo", {
      kind: "remote",
      url: "https://example.invalid/mcp",
      headers: { Authorization: SECRET_CANARY },
    });

    expect(JSON.stringify(offers)).not.toContain(SECRET_CANARY);
    expect(Object.getOwnPropertyNames(offers[0] ?? {})).toEqual(["selector", "targetName"]);
  });
});
