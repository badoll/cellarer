import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDeploymentBaselinePlan,
  planDeploymentBaseline,
} from "../src/deployments/baseline.js";
import { apply } from "../src/engine/apply.js";
import { sha256 } from "../src/store/checksum.js";
import { loadLedger } from "../src/store/ledger.js";
import { initStore, writeMcpArtifact, writeRuleArtifact } from "../src/store/store.js";
import { createSyncProfile, updateSyncProfile } from "../src/sync/profiles.js";
import {
  applySyncProfilePlan,
  applySyncProfileUninstallPlan,
  planSyncProfile,
  planSyncProfileUninstall,
  verifySyncProfile,
} from "../src/sync/service.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("deployment contribution evidence", () => {
  let t: TmpEnv;
  let storeRoot: string;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });
  afterEach(() => t.cleanup());
  it("retains additive managed selectors and reviews legacy attribution without target writes", async () => {
    await writeMcpArtifact(t.env, storeRoot, "a", { kind: "stdio", command: "alpha" });
    await writeMcpArtifact(t.env, storeRoot, "b", { kind: "stdio", command: "beta" });
    const opts = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["mcp" as const],
    };
    await apply(t.env, { ...opts, resourceIds: ["mcp/a", "mcp/b"] });
    await apply(t.env, { ...opts, resourceIds: ["mcp/a"] });
    const owner = (await loadLedger(t.env, storeRoot)).owners[0];
    expect(owner.itemAttribution).toBe("known");
    expect(owner.contributions?.map((item) => item.selector)).toEqual(["a", "b"]);
    const bytes = await t.env.fs.readFile(owner.target, "utf8");
    const raw = JSON.parse(await t.env.fs.readFile(`${storeRoot}/state.json`, "utf8"));
    raw.deployments[0].itemAttribution = "unknown";
    delete raw.deployments[0].contributions;
    await t.env.fs.writeFile(`${storeRoot}/state.json`, JSON.stringify(raw));
    const baselineOpts = { storeRoot, deploymentId: owner.deploymentId!, selectors: ["b"] };
    const baseline = await planDeploymentBaseline(t.env, baselineOpts);
    expect(await t.env.fs.readFile(owner.target, "utf8")).toBe(bytes);
    const applied = await applyDeploymentBaselinePlan(t.env, baseline.plan, baselineOpts);
    expect(applied.operation.ok).toBe(true);
    expect(await t.env.fs.readFile(owner.target, "utf8")).toBe(bytes);
    expect((await loadLedger(t.env, storeRoot)).owners[0].contributions).toEqual([
      expect.objectContaining({ selector: "b", provenance: "local-baseline", resourceIds: [] }),
    ]);
  });
  it("reconciles A+B to A beside unmanaged C without redundant target writes", async () => {
    await writeMcpArtifact(t.env, storeRoot, "a", { kind: "stdio", command: "alpha" });
    await writeMcpArtifact(t.env, storeRoot, "b", { kind: "stdio", command: "beta" });
    const desired = {
      agentIds: ["claude-code"],
      scope: "global" as const,
      resourceIds: ["mcp/a", "mcp/b"],
      collectionIds: [],
      capabilities: ["mcp" as const],
      method: "copy" as const,
      mergePolicy: "merge" as const,
    };
    await createSyncProfile(t.env, { storeRoot, profileId: "daily", desired });
    const opts = { storeRoot, profileId: "daily" };
    const initial = await planSyncProfile(t.env, opts);
    const first = await applySyncProfilePlan(t.env, initial.mutationPlan, opts);
    expect(first.operation).toMatchObject({ ok: true });
    const owner = (await loadLedger(t.env, storeRoot)).owners[0];
    // A recorded deployment fixture with an unmanaged neighbour; edits after preview are tested separately.
    const doc = JSON.parse(await t.env.fs.readFile(owner.target));
    doc.mcpServers.c = { command: "user-owned" };
    doc.userField = "untouched";
    const bytes = JSON.stringify(doc, null, 2) + "\n";
    await t.env.fs.writeFile(owner.target, bytes);
    const state = JSON.parse(await t.env.fs.readFile(`${storeRoot}/state.json`));
    state.deployments[0].receipt.fingerprint = sha256(bytes);
    await t.env.fs.writeFile(`${storeRoot}/state.json`, JSON.stringify(state));
    await updateSyncProfile(t.env, { ...opts, desired: { ...desired, resourceIds: ["mcp/a"] } });
    const planned = await planSyncProfile(t.env, opts);
    expect(planned.mutationPlan.operation).toBe("sync-reconcile");
    expect(planned.mutationPlan.normalizedInputs.reconciliation).toMatchObject({
      blocked: [],
      changes: expect.arrayContaining([
        expect.objectContaining({ selector: "b", outcome: "remove" }),
        expect.objectContaining({ selector: "c", outcome: "keep", attribution: "unmanaged" }),
      ]),
    });
    expect(await t.env.fs.readFile(owner.target)).toBe(bytes);
    const applied = await applySyncProfilePlan(t.env, planned.mutationPlan, opts);
    expect(applied.operation).toMatchObject({ ok: true });
    expect(JSON.parse(await t.env.fs.readFile(owner.target))).toEqual({
      ...doc,
      mcpServers: { a: doc.mcpServers.a, c: doc.mcpServers.c },
    });
    expect(
      (await loadLedger(t.env, storeRoot)).owners[0].contributions?.map((item) => item.selector),
    ).toEqual(["a"]);
    expect((await verifySyncProfile(t.env, opts)).desiredVsApplied.status).toBe("converged");
    const again = await planSyncProfile(t.env, opts);
    const againApplied = await applySyncProfilePlan(t.env, again.mutationPlan, opts);
    expect(againApplied.operation).toMatchObject({ ok: true });
    expect((await loadLedger(t.env, storeRoot)).owners).toHaveLength(1);
  }, 20_000);
  it("blocks shrinking unknown historical attribution", async () => {
    await writeMcpArtifact(t.env, storeRoot, "a", { kind: "stdio", command: "alpha" });
    await writeMcpArtifact(t.env, storeRoot, "b", { kind: "stdio", command: "beta" });
    const desired = {
      agentIds: ["claude-code"],
      scope: "global" as const,
      resourceIds: ["mcp/a", "mcp/b"],
      collectionIds: [],
      capabilities: ["mcp" as const],
      method: "copy" as const,
      mergePolicy: "merge" as const,
    };
    const opts = { storeRoot, profileId: "daily" };
    await createSyncProfile(t.env, { ...opts, desired });
    const first = await planSyncProfile(t.env, opts);
    expect((await applySyncProfilePlan(t.env, first.mutationPlan, opts)).operation.ok).toBe(true);
    const state = JSON.parse(await t.env.fs.readFile(`${storeRoot}/state.json`));
    const target = state.deployments[0].target;
    const bytes = await t.env.fs.readFile(target);
    state.deployments[0].itemAttribution = "unknown";
    delete state.deployments[0].contributions;
    await t.env.fs.writeFile(`${storeRoot}/state.json`, JSON.stringify(state));
    await updateSyncProfile(t.env, { ...opts, desired: { ...desired, resourceIds: ["mcp/a"] } });
    const unknown = await planSyncProfile(t.env, opts);
    expect(unknown.mutationPlan.normalizedInputs.reconciliation).toMatchObject({
      blocked: [expect.objectContaining({ code: "attribution-required" })],
    });
    expect((await applySyncProfilePlan(t.env, unknown.mutationPlan, opts)).operation.ok).toBe(
      false,
    );
    expect(await t.env.fs.readFile(target)).toBe(bytes);
  }, 20_000);
  it.each([
    "structured",
    "pattern",
  ])("blocks %s secrets before exposing MCP prune payloads", async (kind) => {
    await writeMcpArtifact(t.env, storeRoot, "a", { kind: "stdio", command: "alpha" });
    await writeRuleArtifact(t.env, storeRoot, "a", "# A");
    const desired = {
      agentIds: ["claude-code"],
      scope: "global" as const,
      resourceIds: ["mcp/a", "rules/a"],
      collectionIds: [],
      capabilities: ["mcp" as const, "rules" as const],
      method: "copy" as const,
      mergePolicy: "merge" as const,
    };
    const opts = { storeRoot, profileId: "daily" };
    await createSyncProfile(t.env, { ...opts, desired });
    const first = await planSyncProfile(t.env, opts);
    expect((await applySyncProfilePlan(t.env, first.mutationPlan, opts)).operation.ok).toBe(true);
    const state = JSON.parse(await t.env.fs.readFile(`${storeRoot}/state.json`));
    const deployment = state.deployments.find(
      (item: { capability: string }) => item.capability === "mcp",
    );
    const secret = kind === "pattern" ? "ghp_" + "a".repeat(36) : "fixture-sensitive-value";
    const doc = JSON.parse(await t.env.fs.readFile(deployment.target));
    if (kind === "structured") doc.mcpServers.local = { command: "user", env: { API_KEY: secret } };
    else doc.note = secret;
    const bytes = JSON.stringify(doc, null, 2) + "\n";
    await t.env.fs.writeFile(deployment.target, bytes);
    deployment.receipt.fingerprint = sha256(bytes);
    await t.env.fs.writeFile(`${storeRoot}/state.json`, JSON.stringify(state));
    await updateSyncProfile(t.env, {
      ...opts,
      desired: { ...desired, resourceIds: ["rules/a"], capabilities: ["rules"] },
    });
    const preview = await planSyncProfile(t.env, opts);
    expect(preview.mutationPlan.normalizedInputs.reconciliation).toMatchObject({
      blocked: [expect.objectContaining({ code: "secret-output-blocked" })],
      removals: [],
    });
    expect(JSON.stringify(preview)).not.toContain(secret);
    const uninstall = await planSyncProfileUninstall(t.env, opts);
    expect(JSON.stringify(uninstall)).not.toContain(secret);
    expect(uninstall.conflicts.length).toBeGreaterThan(0);
    expect(await t.env.fs.readFile(deployment.target)).toBe(bytes);
  }, 20_000);
  it("uninstalls only attributed MCP entries and preserves unmanaged native content", async () => {
    await writeMcpArtifact(t.env, storeRoot, "a", { kind: "stdio", command: "alpha" });
    const desired = {
      agentIds: ["claude-code"],
      scope: "global" as const,
      resourceIds: ["mcp/a"],
      collectionIds: [],
      capabilities: ["mcp" as const],
      method: "copy" as const,
      mergePolicy: "merge" as const,
    };
    const opts = { storeRoot, profileId: "daily" };
    await createSyncProfile(t.env, { ...opts, desired });
    const initial = await planSyncProfile(t.env, opts);
    expect((await applySyncProfilePlan(t.env, initial.mutationPlan, opts)).operation.ok).toBe(true);
    const statePath = `${storeRoot}/state.json`;
    const state = JSON.parse(await t.env.fs.readFile(statePath));
    const target = state.deployments[0].target;
    const bytes =
      JSON.stringify(
        { mcpServers: { a: { command: "alpha" }, c: { command: "user" } }, note: "preserve" },
        null,
        2,
      ) + "\n";
    await t.env.fs.writeFile(target, bytes);
    state.deployments[0].receipt.fingerprint = sha256(bytes);
    await t.env.fs.writeFile(statePath, JSON.stringify(state));
    const uninstall = await planSyncProfileUninstall(t.env, opts);
    expect(uninstall.targets[0].proposedAction).toBe("prune-mcp");
    expect(
      (
        await applySyncProfileUninstallPlan(t.env, uninstall.mutationPlan, {
          ...opts,
          targetKeys: uninstall.targetKeys,
        })
      ).operation.ok,
    ).toBe(true);
    expect(JSON.parse(await t.env.fs.readFile(target))).toEqual({
      mcpServers: { c: { command: "user" } },
      note: "preserve",
    });
    expect((await loadLedger(t.env, storeRoot)).owners).toEqual([]);
  }, 10_000);

  it("blocks conflicting shared expectations and detaches a departing profile", async () => {
    await writeRuleArtifact(t.env, storeRoot, "a", "# A");
    await writeRuleArtifact(t.env, storeRoot, "b", "# B");
    const desired = {
      agentIds: ["codex"],
      scope: "global" as const,
      resourceIds: ["rules/a"],
      collectionIds: [],
      capabilities: ["rules" as const],
      method: "copy" as const,
      mergePolicy: "merge" as const,
    };
    for (const profileId of ["one", "two"]) {
      await createSyncProfile(t.env, { storeRoot, profileId, desired });
      const planned = await planSyncProfile(t.env, { storeRoot, profileId });
      expect(
        (await applySyncProfilePlan(t.env, planned.mutationPlan, { storeRoot, profileId }))
          .operation.ok,
      ).toBe(true);
    }
    const target = (await loadLedger(t.env, storeRoot)).owners[0].target;
    const before = await t.env.fs.readFile(target);
    const opts = { storeRoot, profileId: "one" };
    await updateSyncProfile(t.env, { ...opts, desired: { ...desired, resourceIds: ["rules/b"] } });
    const conflicting = await planSyncProfile(t.env, opts);
    expect(conflicting.plan.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "SHARED_TARGET_CONFLICT" })]),
    );
    expect((await applySyncProfilePlan(t.env, conflicting.mutationPlan, opts)).operation.ok).toBe(
      false,
    );
    expect(await t.env.fs.readFile(target)).toBe(before);
    await updateSyncProfile(t.env, { ...opts, desired: { ...desired, agentIds: ["claude-code"] } });
    const exiting = await planSyncProfile(t.env, opts);
    expect((await applySyncProfilePlan(t.env, exiting.mutationPlan, opts)).operation.ok).toBe(true);
    expect(await t.env.fs.readFile(target)).toBe(before);
    expect(
      (await loadLedger(t.env, storeRoot)).owners
        .filter((owner) => owner.target === target)
        .map((owner) => owner.syncProfile?.profileId),
    ).toEqual(["two"]);
  }, 20_000);
});
