import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listActivity } from "../src/activity.js";
import type { Env } from "../src/env.js";
import {
  applyInventoryStoreImportPlan,
  planInventoryStoreImport,
} from "../src/inventory/import.js";
import { refreshInventory } from "../src/inventory/projector.js";
import { createAuthorizedMutationPlan } from "../src/protocol/canonical.js";
import { publishStoreRevision, readStoreRevision } from "../src/protocol/store-revision.js";
import { loadConfig } from "../src/store/config.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("Inventory Store import apply", () => {
  let t: TmpEnv;
  let storeRoot: string;
  let rulesPath: string;

  beforeEach(async () => {
    let randomId = 0;
    t = makeTmpEnv({ randomId: () => `inventory-import-${++randomId}` });
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    rulesPath = t.path("home", ".agents", "AGENTS.md");
    await initStore(t.env, storeRoot);
    await t.env.fs.mkdir(join(rulesPath, ".."), { recursive: true });
    await t.env.fs.writeFile(rulesPath, "# Reviewed rules\n");
  });

  afterEach(() => t.cleanup());

  async function plan(intoCollection?: string) {
    const inventory = await refreshInventory(t.env, { storeRoot, agentId: "agents-md" });
    const candidate = inventory.candidates.find(({ kind }) => kind === "rules");
    if (!candidate) throw new Error("missing rules candidate");
    return planInventoryStoreImport(t.env, {
      storeRoot,
      candidateIds: [candidate.id],
      refresh: { agentId: "agents-md" },
      ...(intoCollection ? { intoCollection } : {}),
    });
  }

  it("applies the unchanged plan in a replacement process and records one revisioned receipt", async () => {
    const planned = await plan("default");
    const replacement: Env = { ...t.env, processId: () => t.env.processId() + 10 };

    const result = await applyInventoryStoreImportPlan(replacement, planned.mutationPlan, {
      storeRoot,
    });

    expect(result.operation).toMatchObject({
      ok: true,
      receipt: { outcome: "committed", baseRevision: 0, resultingRevision: 1 },
    });
    expect(await readStoreRevision(t.env, storeRoot)).toBe(1);
    expect(await t.env.fs.readFile(join(storeRoot, "store", "rules", "AGENTS.md"))).toBe(
      "# Reviewed rules\n",
    );
    expect((await loadConfig(t.env, storeRoot)).artifacts["rules/AGENTS"]?.collections).toEqual([
      "default",
    ]);
    expect((await listActivity(t.env, storeRoot)).events[0]).toMatchObject({
      action: "inventory-import",
      affectedCount: 1,
      resources: { artifactIds: ["rules/AGENTS"] },
    });
  });

  it("imports mixed Skill assets byte-for-byte and rejects BOM removal from a sealed plan", async () => {
    const skillRoot = t.path("home", ".agents", "skills", "bom-demo");
    await t.env.fs.mkdir(skillRoot, { recursive: true });
    await t.env.fs.writeFile(
      join(skillRoot, "SKILL.md"),
      "---\nname: bom-demo\ndescription: BOM fixture\n---\n",
    );
    const assets = new Map([
      ["single.md", Buffer.from("\uFEFF# Text\n")],
      ["double.md", Buffer.from("\uFEFF\uFEFF# Text\n")],
      ["binary.bin", Buffer.from([0xef, 0xbb, 0xbf, 0xff, 0x00])],
    ]);
    for (const [name, bytes] of assets) await t.env.fs.writeFileBytes(join(skillRoot, name), bytes);
    const inventory = await refreshInventory(t.env, { storeRoot, agentId: "agents-md" });
    const planned = await planInventoryStoreImport(t.env, {
      storeRoot,
      candidateIds: inventory.candidates
        .filter(({ state }) => state === "ready")
        .map(({ id }) => id),
      refresh: { agentId: "agents-md" },
    });
    const transported = JSON.parse(JSON.stringify(planned.mutationPlan));
    const altered = structuredClone(transported);
    const publication = altered.actions.find(
      (action: { payload: { resourceId: string } }) =>
        action.payload.resourceId === "skills/bom-demo",
    ).payload.publication;
    publication.nodes.find((node: { path: string }) => node.path === "single.md").data = "# Text\n";
    const before = await t.env.fs.snapshotTreeNoFollow(storeRoot);
    expect(
      (await applyInventoryStoreImportPlan(t.env, altered, { storeRoot })).operation,
    ).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    expect(await t.env.fs.snapshotTreeNoFollow(storeRoot)).toEqual(before);
    const result = await applyInventoryStoreImportPlan(t.env, transported, { storeRoot });
    expect(result.operation).toMatchObject({ ok: true, receipt: { outcome: "committed" } });
    expect(result.resourceIds).toEqual(expect.arrayContaining(["rules/AGENTS", "skills/bom-demo"]));
    for (const [name, bytes] of assets) {
      expect(
        await t.env.fs.readFileBytes(join(storeRoot, "store", "skills", "bom-demo", name)),
      ).toEqual(bytes);
      expect(await t.env.fs.readFileBytes(join(skillRoot, name))).toEqual(bytes);
    }
  });

  it("rejects altered or resealed injected actions without applying Store content", async () => {
    const planned = await plan();
    const altered = structuredClone(planned.mutationPlan);
    const content = altered.actions[0]?.payload.publication as { data?: string } | undefined;
    if (!content) throw new Error("missing content payload");
    content.data = "# Altered\n";

    const alteredResult = await applyInventoryStoreImportPlan(t.env, altered, { storeRoot });
    expect(alteredResult.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });

    const target = t.path("home", ".agents", "injected-target.md");
    const injected = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: planned.mutationPlan.schemaVersion,
      planId: planned.mutationPlan.planId,
      operation: planned.mutationPlan.operation,
      baseRevision: planned.mutationPlan.baseRevision,
      normalizedInputs: planned.mutationPlan.normalizedInputs,
      targetPreconditions: [
        ...planned.mutationPlan.targetPreconditions,
        { actionId: "injected-target", target, expected: { state: "absent" } },
      ],
      actions: [
        ...planned.mutationPlan.actions,
        {
          actionId: "injected-target",
          kind: "agent-target-write",
          target,
          payload: { data: "forbidden" },
          postcondition: { state: "present", fingerprint: "sha256:forged" },
        },
      ],
      expires: planned.mutationPlan.expires,
    });
    const injectedResult = await applyInventoryStoreImportPlan(t.env, injected, { storeRoot });
    expect(injectedResult.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });
    await expect(
      t.env.fs.lstat(join(storeRoot, "store", "rules", "AGENTS.md")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(t.env.fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects source and Store drift before publishing the batch", async () => {
    const sourcePlan = await plan();
    await t.env.fs.writeFile(rulesPath, "# Drifted\n");
    const sourceResult = await applyInventoryStoreImportPlan(t.env, sourcePlan.mutationPlan, {
      storeRoot,
    });
    expect(sourceResult.operation).toMatchObject({
      ok: false,
      conflict: { code: "TARGET_PRECONDITION_CONFLICT" },
    });
    await expect(
      t.env.fs.lstat(join(storeRoot, "store", "rules", "AGENTS.md")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    await t.env.fs.writeFile(rulesPath, "# Reviewed rules\n");
    const storePlan = await plan();
    await publishStoreRevision(t.env, storeRoot, 1);
    const storeResult = await applyInventoryStoreImportPlan(t.env, storePlan.mutationPlan, {
      storeRoot,
    });
    expect(storeResult.operation).toMatchObject({
      ok: false,
      conflict: { code: "STALE_REVISION", replanRequired: true },
    });
    await expect(
      t.env.fs.lstat(join(storeRoot, "store", "rules", "AGENTS.md")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("compensates a controlled batch failure and never calls provider or agent-target effects", async () => {
    const planned = await plan("default");
    const metadataTarget = join(storeRoot, "store", "metadata", "rules", "AGENTS.json");
    const forbiddenCalls: string[] = [];
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, options) => {
          if (path.startsWith(t.path("home", ".agents"))) {
            forbiddenCalls.push(`target:${path}`);
            throw new Error("agent target write");
          }
          if (path === metadataTarget) {
            throw Object.assign(new Error("injected metadata failure"), { code: "EIO" });
          }
          return t.env.fs.publishFileAtomically(path, data, options);
        },
      },
      secretStore: {
        get: async () => {
          forbiddenCalls.push("secretStore.get");
          throw new Error("provider observation");
        },
        set: async () => {
          forbiddenCalls.push("secretStore.set");
          throw new Error("provider mutation");
        },
        delete: async () => {
          forbiddenCalls.push("secretStore.delete");
          throw new Error("provider mutation");
        },
      },
    };

    const result = await applyInventoryStoreImportPlan(env, planned.mutationPlan, { storeRoot });

    expect(result.operation).toMatchObject({ ok: false, conflict: { code: "PARTIAL_FAILURE" } });
    expect(forbiddenCalls).toEqual([]);
    await expect(
      t.env.fs.lstat(join(storeRoot, "store", "rules", "AGENTS.md")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(t.env.fs.lstat(metadataTarget)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await loadConfig(t.env, storeRoot)).artifacts["rules/AGENTS"]).toBeUndefined();
    expect(await readStoreRevision(t.env, storeRoot)).toBe(0);
  });
});
