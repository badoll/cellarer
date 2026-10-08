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

  it("keeps an 83-item selection above the generic request budget in one exact plan", async () => {
    const servers = Object.fromEntries(
      Array.from({ length: 83 }, (_, index) => [
        `budget-demo-${index}`,
        { command: "node", args: ["Example tool argument.\n".repeat(800)] },
      ]),
    );
    await t.env.fs.writeFile(
      t.path("home", ".claude.json"),
      JSON.stringify({ mcpServers: servers }),
    );
    const inventory = await refreshInventory(t.env, { storeRoot, agentId: "claude-code" });
    const candidates = inventory.candidates.filter(({ kind }) => kind === "mcp");
    expect(candidates).toHaveLength(83);
    expect(candidates.every(({ state }) => state === "ready")).toBe(true);
    const before = await t.env.fs.snapshotTreeNoFollow(storeRoot);
    const candidateIds = candidates.map(({ id }) => id);
    const planned = await planInventoryStoreImport(t.env, {
      storeRoot,
      candidateIds,
      refresh: { agentId: "claude-code" },
    });
    expect(planned.candidateIds).toEqual([...candidateIds].sort());
    expect(planned.mutationPlan.actions).toHaveLength(166);
    expect(
      new TextEncoder().encode(JSON.stringify({ mutationPlan: planned.mutationPlan })).byteLength,
    ).toBeGreaterThan(1024 * 1024);
    expect(await t.env.fs.snapshotTreeNoFollow(storeRoot)).toEqual(before);
  }, 30_000);

  it("keeps invalid manifests visible and blocks the Inventory import path", async () => {
    const root = t.path("home", ".agents", "skills", "invalid");
    await t.env.fs.mkdir(root, { recursive: true });
    await t.env.fs.writeFile(
      join(root, "SKILL.md"),
      "---\nname: invalid\nname: duplicate\ndescription: Invalid\n---\nBody",
    );
    const inventory = await refreshInventory(t.env, { storeRoot, agentId: "agents-md" });
    const candidate = inventory.candidates.find((item) => item.kind === "skills");
    expect(candidate?.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "INVALID_MANIFEST" })]),
    );
    expect(candidate?.state).toBe("needs-attention");
    await expect(
      planInventoryStoreImport(t.env, {
        storeRoot,
        candidateIds: [candidate?.id ?? "missing"],
        refresh: { agentId: "agents-md" },
      }),
    ).rejects.toBeInstanceOf(InventoryStoreImportPlanningError);
  });

  it("blocks a Skill whose structured asset fails the final publication guard", async () => {
    const root = t.path("home", ".agents", "skills", "broken-yaml");
    await t.env.fs.mkdir(root, { recursive: true });
    await t.env.fs.writeFile(
      join(root, "SKILL.md"),
      "---\nname: broken-yaml\ndescription: Broken asset\n---\n# Skill\n",
    );
    await t.env.fs.writeFile(join(root, "example.yml"), "foo: [unterminated\n");

    const inventory = await refreshInventory(t.env, { storeRoot, agentId: "agents-md" });
    const candidate = inventory.candidates.find(({ kind }) => kind === "skills");
    expect(candidate).toMatchObject({ state: "needs-attention", defaultSelected: false });
    expect(candidate?.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "PARSE_FAILED" })]),
    );
    await expect(
      planInventoryStoreImport(t.env, {
        storeRoot,
        candidateIds: [candidate?.id ?? "missing"],
        refresh: { agentId: "agents-md" },
      }),
    ).rejects.toMatchObject({ reason: "CANDIDATE_NOT_READY" });
  });

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

  it("imports captured bytes from a bounded linked Skill", async () => {
    const target = t.path("home", "shared", "linked");
    const alias = t.path("home", ".agents", "skills", "linked");
    await t.env.fs.mkdir(target, { recursive: true });
    await t.env.fs.mkdir(join(alias, ".."), { recursive: true });
    await t.env.fs.writeFile(
      join(target, "SKILL.md"),
      "---\nname: linked\ndescription: Linked skill\n---\n# Linked\n",
    );
    await t.env.fs.symlink(target, alias, "dir");
    const reviewed = await refreshInventory(t.env, { storeRoot, agentId: "agents-md" });
    expect(reviewed.completeness).toBe("complete");
    const candidate = reviewed.candidates.find(({ kind }) => kind === "skills");
    if (!candidate) throw new Error("missing linked Skill");
    const planned = await planInventoryStoreImport(t.env, {
      storeRoot,
      candidateIds: [candidate.id],
      refresh: { agentId: "agents-md" },
    });

    const replacementEnv = { ...t.env, processId: () => t.env.processId() + 10 };
    const transportedPlan = JSON.parse(
      JSON.stringify(planned.mutationPlan),
    ) as typeof planned.mutationPlan;
    const applied = await applyInventoryStoreImportPlan(replacementEnv, transportedPlan, {
      storeRoot,
    });
    expect(applied.operation.ok).toBe(true);
    const stored = join(storeRoot, "store", "skills", "linked");
    expect((await t.env.fs.lstat(stored)).isDirectory()).toBe(true);
    expect(await t.env.fs.readFile(join(stored, "SKILL.md"))).toContain("# Linked");
  });

  it("preserves a linked Skill's binary asset during Inventory import", async () => {
    const target = t.path("home", "shared", "with-image");
    const alias = t.path("home", ".agents", "skills", "with-image");
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);
    await t.env.fs.mkdir(target, { recursive: true });
    await t.env.fs.mkdir(join(alias, ".."), { recursive: true });
    await t.env.fs.writeFile(
      join(target, "SKILL.md"),
      "---\nname: with-image\ndescription: Skill with image\n---\n# Image\n",
    );
    await t.env.fs.writeFileBytes(join(target, "image.png"), bytes);
    await t.env.fs.symlink(target, alias, "dir");

    const reviewed = await refreshInventory(t.env, { storeRoot, agentId: "agents-md" });
    expect(reviewed.completeness).toBe("complete");
    const candidate = reviewed.candidates.find(({ kind }) => kind === "skills");
    expect(candidate).toMatchObject({ state: "ready" });
    if (!candidate) throw new Error("missing linked Skill");
    const planned = await planInventoryStoreImport(t.env, {
      storeRoot,
      candidateIds: [candidate.id],
      refresh: { agentId: "agents-md" },
    });
    const applied = await applyInventoryStoreImportPlan(t.env, planned.mutationPlan, { storeRoot });
    expect(applied.operation.ok).toBe(true);
    const stored = await t.env.fs.readFileBytes(
      join(storeRoot, "store", "skills", "with-image", "image.png"),
    );
    expect([...stored]).toEqual([...bytes]);
  });

  it("rejects a linked Skill whose alias changes after planning", async () => {
    const first = t.path("home", "shared", "first");
    const second = t.path("home", "shared", "second");
    const alias = t.path("home", ".agents", "skills", "linked");
    for (const target of [first, second]) {
      await t.env.fs.mkdir(target, { recursive: true });
      await t.env.fs.writeFile(
        join(target, "SKILL.md"),
        "---\nname: linked\ndescription: Linked skill\n---\n# Linked\n",
      );
    }
    await t.env.fs.mkdir(join(alias, ".."), { recursive: true });
    await t.env.fs.symlink(first, alias, "dir");
    const reviewed = await refreshInventory(t.env, { storeRoot, agentId: "agents-md" });
    const candidate = reviewed.candidates.find(({ kind }) => kind === "skills");
    if (!candidate) throw new Error("missing linked Skill");
    const planned = await planInventoryStoreImport(t.env, {
      storeRoot,
      candidateIds: [candidate.id],
      refresh: { agentId: "agents-md" },
    });
    await t.env.fs.rm(alias);
    await t.env.fs.symlink(second, alias, "dir");

    const applied = await applyInventoryStoreImportPlan(t.env, planned.mutationPlan, { storeRoot });
    expect(applied.operation.ok).toBe(false);
    await expect(
      t.env.fs.lstat(join(storeRoot, "store", "skills", "linked")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
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
