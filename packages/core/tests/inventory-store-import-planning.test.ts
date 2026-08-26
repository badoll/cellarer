import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyInventoryStoreImportPlan,
  InventoryStoreImportPlanningError,
  planInventoryStoreImport,
} from "../src/inventory/import.js";
import { refreshInventory } from "../src/inventory/projector.js";
import { publishStoreRevision } from "../src/protocol/store-revision.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const SECRET_CANARY = "ghp_1234567890abcdefghij1234567890";

describe("Inventory Store import planning", () => {
  let t: TmpEnv;
  let storeRoot: string;
  let rulesPath: string;

  beforeEach(async () => {
    t = makeTmpEnv({ randomId: () => "inventory-import-plan" });
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    rulesPath = t.path("home", ".agents", "AGENTS.md");
    await initStore(t.env, storeRoot);
    await t.env.fs.mkdir(join(rulesPath, ".."), { recursive: true });
    await t.env.fs.writeFile(rulesPath, "# Reviewed rules\n");
  });

  afterEach(() => t.cleanup());

  it("seals one exact current candidate against the coherent Store revision", async () => {
    await publishStoreRevision(t.env, storeRoot, 7);
    const reviewed = await refreshInventory(t.env, { storeRoot, agentId: "agents-md" });
    const candidate = reviewed.candidates.find(({ kind }) => kind === "rules");
    expect(candidate).toMatchObject({ state: "ready", defaultSelected: true });
    if (!candidate) throw new Error("missing reviewed candidate");
    const before = await t.env.fs.snapshotTreeNoFollow(storeRoot);

    const planned = await planInventoryStoreImport(t.env, {
      storeRoot,
      candidateIds: [candidate.id],
      refresh: { agentId: "agents-md" },
    });

    expect(planned.candidateIds).toEqual([candidate.id]);
    expect(planned.inventory.candidates.find(({ id }) => id === candidate.id)).toMatchObject({
      state: "ready",
    });
    expect(planned.mutationPlan).toMatchObject({
      operation: "store-import",
      baseRevision: 7,
      normalizedInputs: {
        mutationKind: "inventory-store-import",
        candidateIds: [candidate.id],
        refreshScope: { agentId: "agents-md", projectRoot: null },
      },
    });
    expect(planned.mutationPlan.actions).toHaveLength(2);
    expect(planned.mutationPlan.actions.map(({ kind }) => kind)).toEqual([
      "inventory-resource-content",
      "inventory-resource-metadata",
    ]);
    expect(planned.mutationPlan.actions.some(({ kind }) => kind.includes("target"))).toBe(false);
    expect(JSON.parse(JSON.stringify(planned.mutationPlan))).toEqual(planned.mutationPlan);
    expect(new TextEncoder().encode(JSON.stringify(planned)).byteLength).toBeLessThanOrEqual(
      1024 * 1024,
    );
    expect(await t.env.fs.snapshotTreeNoFollow(storeRoot)).toEqual(before);
  });

  it("plans collection membership when valid custom MCP metadata is already configured", async () => {
    const configPath = join(storeRoot, "config.json");
    const config = JSON.parse(await t.env.fs.readFile(configPath)) as Record<string, unknown>;
    config.customAdapters = {
      "custom-mcp": {
        mcp: {
          project: "{dir}/.custom/mcp.json",
          format: "json",
          serversKey: "mcpServers",
          supportedSecretReferences: ["environment"],
        },
      },
    };
    await t.env.fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const reviewed = await refreshInventory(t.env, { storeRoot, agentId: "agents-md" });
    const candidate = reviewed.candidates.find(({ kind }) => kind === "rules");
    if (!candidate) throw new Error("missing reviewed candidate");

    const planned = await planInventoryStoreImport(t.env, {
      storeRoot,
      candidateIds: [candidate.id],
      intoCollection: "default",
      refresh: { agentId: "agents-md" },
    });

    expect(planned.mutationPlan.actions.map(({ kind }) => kind)).toContain(
      "inventory-collection-membership",
    );

    await expect(
      applyInventoryStoreImportPlan(t.env, planned.mutationPlan, { storeRoot }),
    ).resolves.toMatchObject({
      operation: { ok: true, receipt: { outcome: "committed" } },
    });
  });

  it("does not infer selection and rejects duplicate or unknown candidate IDs", async () => {
    const reviewed = await refreshInventory(t.env, { storeRoot, agentId: "agents-md" });
    const candidate = reviewed.candidates[0];
    if (!candidate) throw new Error("missing reviewed candidate");

    await expect(
      planInventoryStoreImport(t.env, {
        storeRoot,
        candidateIds: [],
        refresh: { agentId: "agents-md" },
      }),
    ).rejects.toMatchObject({ code: "INPUT_REQUIRED", reason: "CANDIDATE_IDS_REQUIRED" });
    await expect(
      planInventoryStoreImport(t.env, {
        storeRoot,
        candidateIds: [candidate.id, candidate.id],
        refresh: { agentId: "agents-md" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", reason: "DUPLICATE_CANDIDATE" });
    await expect(
      planInventoryStoreImport(t.env, {
        storeRoot,
        candidateIds: ["inventory-candidate:v1:rules:unknown"],
        refresh: { agentId: "agents-md" },
      }),
    ).rejects.toMatchObject({ code: "DOMAIN_VALIDATION_FAILED", reason: "UNKNOWN_CANDIDATE" });
  });

  it("rejects a reviewed identity when refresh finds drift or a blocked candidate", async () => {
    const reviewed = await refreshInventory(t.env, { storeRoot, agentId: "agents-md" });
    const reviewedId = reviewed.candidates[0]?.id;
    if (!reviewedId) throw new Error("missing reviewed candidate");
    await t.env.fs.writeFile(rulesPath, "# Changed after review\n");

    await expect(
      planInventoryStoreImport(t.env, {
        storeRoot,
        candidateIds: [reviewedId],
        refresh: { agentId: "agents-md" },
      }),
    ).rejects.toMatchObject({ code: "DOMAIN_VALIDATION_FAILED", reason: "UNKNOWN_CANDIDATE" });

    await t.env.fs.writeFile(rulesPath, `Never store ${SECRET_CANARY}\n`);
    const blocked = await refreshInventory(t.env, { storeRoot, agentId: "agents-md" });
    const blockedId = blocked.candidates[0]?.id;
    if (!blockedId) throw new Error("missing blocked candidate");
    await expect(
      planInventoryStoreImport(t.env, {
        storeRoot,
        candidateIds: [blockedId],
        refresh: { agentId: "agents-md" },
      }),
    ).rejects.toBeInstanceOf(InventoryStoreImportPlanningError);
    await expect(
      planInventoryStoreImport(t.env, {
        storeRoot,
        candidateIds: [blockedId],
        refresh: { agentId: "agents-md" },
      }),
    ).rejects.toMatchObject({
      code: "DOMAIN_VALIDATION_FAILED",
      reason: "CANDIDATE_NOT_READY",
    });
  });
});
