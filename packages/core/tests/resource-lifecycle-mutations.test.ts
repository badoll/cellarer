import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply } from "../src/engine/apply.js";
import { applySyncTargetUninstallPlan, planSyncTargetUninstall } from "../src/engine/uninstall.js";
import { createAuthorizedMutationPlan } from "../src/protocol/canonical.js";
import { operationJournalPath } from "../src/protocol/journal.js";
import {
  applyResourceBundleImportPlan,
  applyResourceExportPlan,
  applyResourceRemovePlan,
  applyResourceRenamePlan,
  planResourceBundleImport,
  planResourceExport,
  planResourceRemove,
  planResourceRename,
  resourceDependencyReport,
  validateResourceBundle,
} from "../src/resources/lifecycle.js";
import { createResourceRecord, resourceMetadataPath } from "../src/resources/model.js";
import { sha256 } from "../src/store/checksum.js";
import { loadConfig, saveConfig } from "../src/store/config.js";
import { entryKey, loadLedger } from "../src/store/ledger.js";
import { initStore, listRuleArtifacts, writeSkillProvenance } from "../src/store/store.js";
import { createSyncProfile, showSyncProfile } from "../src/sync/profiles.js";
import { GIT_SOURCE, LOCAL_SNAPSHOT_SOURCE } from "./fixtures/resource-lifecycle.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

const SKILL = `---\nname: example-skill\ndescription: |\n  lifecycle fixture\nmetadata:\n  custom: [one, two]\n---\n\n# Example\n`;
const SKILL_WITH_REFERENCE = `${SKILL}\nToken: \${CELLARER_SECRET:github-token}\n`;

describe("resource lifecycle dependency, rename, remove, and bundles", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv({ randomId: sequenceIds("resource-lifecycle") });
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
    await installSkill(t, storeRoot, "example-skill", GIT_SOURCE);
  });

  afterEach(() => t.cleanup());

  it("reports exact collection, typed profile, desired selection, and owned-target dependencies without secret values", async () => {
    const config = await loadConfig(t.env, storeRoot);
    config.collections.work = { description: "work" };
    config.defaults.collections = ["work"];
    config.artifacts["skills/example-skill"] = { collections: ["work"] };
    await saveConfig(t.env, storeRoot, config);
    const deployed = await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["codex"],
      capabilities: ["skills"],
      method: "copy",
    });
    expect(deployed.failures).toEqual([]);
    await createSyncProfile(t.env, {
      storeRoot,
      profileId: "daily",
      desired: {
        agentIds: ["codex"],
        scope: "global",
        resourceIds: ["skills/example-skill"],
        collectionIds: ["work"],
        capabilities: ["skills"],
        method: "copy",
        mergePolicy: "merge",
      },
    });

    const report = await resourceDependencyReport(t.env, {
      storeRoot,
      resourceId: "skills/example-skill",
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      resourceId: "skills/example-skill",
      currentRevisionId: expect.stringMatching(/^sha256:/),
      collections: [{ collectionId: "work", resourceId: "skills/example-skill" }],
      profiles: [
        {
          profileId: "daily",
          profileRevision: expect.stringMatching(/^sha256:/),
          viaResource: true,
          collectionIds: ["work"],
        },
      ],
      desiredSelections: [
        {
          selector: "defaults.collections",
          collectionId: "work",
          resourceId: "skills/example-skill",
        },
      ],
      ownedTargets: [
        {
          key: expect.any(String),
          agent: "codex",
          capability: "skills",
          resourceId: "skills/example-skill",
          target: expect.stringContaining("/.agents/skills/example-skill"),
        },
      ],
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("github-token-value");
    expect(serialized).not.toContain("secretRefs");

    const cascade = await planResourceRemove(t.env, {
      storeRoot,
      resourceId: "skills/example-skill",
      cascade: true,
    });
    expect(cascade.blocked).toEqual(expect.arrayContaining(["OWNED_TARGET_DEPENDENCY"]));
    expect(cascade.plan.actions).toEqual([]);
  }, 30_000);

  // This real transaction must finish before fixture teardown; Vitest timeouts do not cancel it.
  it("cascades canonical direct profile references and binds the profile registry into apply", async () => {
    await installSkill(t, storeRoot, "second-skill", LOCAL_SNAPSHOT_SOURCE);
    await createSyncProfile(t.env, {
      storeRoot,
      profileId: "daily",
      desired: {
        agentIds: ["codex"],
        scope: "global",
        resourceIds: ["skills/example-skill", "skills/second-skill"],
        collectionIds: [],
        capabilities: ["skills"],
        method: "copy",
        mergePolicy: "merge",
      },
    });
    const before = (await showSyncProfile(t.env, { storeRoot, profileId: "daily" })).profile;
    if (!before) throw new Error("expected profile");
    const options = { storeRoot, resourceId: "skills/example-skill", cascade: true };
    const planned = await planResourceRemove(t.env, options);

    expect(planned.blocked).toEqual([]);
    expect(planned.dependencyReport?.profiles).toEqual([
      expect.objectContaining({ profileId: "daily", viaResource: true }),
    ]);
    expect(planned.plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "publish-file",
          target: join(storeRoot, "profiles.json"),
        }),
      ]),
    );

    const applied = await applyResourceRemovePlan(t.env, planned.plan, {
      storeRoot,
      options,
    });
    expect(applied.operation.ok).toBe(true);
    const after = (await showSyncProfile(t.env, { storeRoot, profileId: "daily" })).profile;
    expect(after?.desired.resourceIds).toEqual(["skills/second-skill"]);
    expect(after?.revision).not.toBe(before.revision);
  }, 30_000);

  // This real transaction must finish before fixture teardown; Vitest timeouts do not cancel it.
  it("rejects cascade apply when the canonical profile registry changes after planning", async () => {
    await installSkill(t, storeRoot, "second-skill", LOCAL_SNAPSHOT_SOURCE);
    const profileDesired = {
      agentIds: ["codex"],
      scope: "global" as const,
      resourceIds: ["skills/example-skill", "skills/second-skill"],
      collectionIds: [] as string[],
      capabilities: ["skills" as const],
      method: "copy" as const,
      mergePolicy: "merge" as const,
    };
    await createSyncProfile(t.env, {
      storeRoot,
      profileId: "daily",
      desired: profileDesired,
    });
    const options = { storeRoot, resourceId: "skills/example-skill", cascade: true };
    const planned = await planResourceRemove(t.env, options);
    expect(planned.plan.normalizedInputs.storeProvenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: join(storeRoot, "profiles.json"),
          expected: expect.objectContaining({ state: "present" }),
        }),
      ]),
    );

    await createSyncProfile(t.env, {
      storeRoot,
      profileId: "later",
      desired: { ...profileDesired, resourceIds: ["skills/second-skill"] },
    });
    const rejected = await applyResourceRemovePlan(t.env, planned.plan, {
      storeRoot,
      options,
    });
    expect(rejected.operation).toMatchObject({ ok: false });
    await expect(
      t.env.fs.lstat(join(storeRoot, "store", "skills", "example-skill")),
    ).resolves.toBeDefined();
  }, 30_000);

  // This real transaction must finish before fixture teardown; Vitest timeouts do not cancel it.
  it("renames editable metadata while preserving an immutable resource ID and exact references", async () => {
    await installRule(t, storeRoot, "old-rule", "rules/stable-rule-id");
    const config = await loadConfig(t.env, storeRoot);
    config.collections.work = {};
    config.artifacts["rules/stable-rule-id"] = { collections: ["work"] };
    await saveConfig(t.env, storeRoot, config);
    const options = {
      storeRoot,
      resourceId: "rules/stable-rule-id",
      newName: "renamed-rule",
      mode: "rename" as const,
    };
    const planned = await planResourceRename(t.env, options);
    expect(planned.blocked).toEqual([]);
    expect(planned.resource).toMatchObject({
      resourceId: "rules/stable-rule-id",
      name: "renamed-rule",
    });
    const applied = await applyResourceRenamePlan(t.env, planned.plan, {
      storeRoot,
      options,
    });
    expect(applied.operation.ok).toBe(true);
    expect(await t.env.fs.readFile(join(storeRoot, "store", "rules", "renamed-rule.md"))).toBe(
      "# stable rule\n",
    );
    await expect(
      t.env.fs.lstat(join(storeRoot, "store", "rules", "old-rule.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await listRuleArtifacts(t.env, storeRoot)).toContainEqual(
      expect.objectContaining({ id: "rules/stable-rule-id", name: "renamed-rule" }),
    );
    expect(
      (await loadConfig(t.env, storeRoot)).artifacts["rules/stable-rule-id"]?.collections,
    ).toEqual(["work"]);
  }, 30_000);

  // This real transaction must finish before fixture teardown; Vitest timeouts do not cancel it.
  it("requires a local fork for source-defined Skill rename and keeps ordinary/cascade remove store-only", async () => {
    const renameOptions = {
      storeRoot,
      resourceId: "skills/example-skill",
      newName: "forked-skill",
      mode: "rename" as const,
    };
    const blockedRename = await planResourceRename(t.env, renameOptions);
    expect(blockedRename.blocked).toContain("LOCAL_FORK_REQUIRED");
    expect(blockedRename.plan.actions).toEqual([]);

    const forkOptions = { ...renameOptions, mode: "local-fork" as const };
    const fork = await planResourceRename(t.env, forkOptions);
    expect(fork.blocked).toEqual([]);
    expect(fork.resource).toMatchObject({
      resourceId: "skills/forked-skill",
      name: "forked-skill",
      currentRevision: { source: { type: "local-snapshot" } },
    });
    const forked = await applyResourceRenamePlan(t.env, fork.plan, {
      storeRoot,
      options: forkOptions,
    });
    expect(forked.operation.ok).toBe(true);
    expect(
      await t.env.fs.readFile(join(storeRoot, "store", "skills", "example-skill", "SKILL.md")),
    ).toContain("name: example-skill");
    expect(
      await t.env.fs.readFile(join(storeRoot, "store", "skills", "forked-skill", "SKILL.md")),
    ).toContain("name: forked-skill");

    const config = await loadConfig(t.env, storeRoot);
    config.collections.work = {};
    config.defaults.collections = ["work"];
    config.artifacts["skills/forked-skill"] = { collections: ["work"] };
    await saveConfig(t.env, storeRoot, config);
    const ordinaryOptions = {
      storeRoot,
      resourceId: "skills/forked-skill",
      cascade: false,
    };
    const ordinary = await planResourceRemove(t.env, ordinaryOptions);
    expect(ordinary.blocked).toEqual(
      expect.arrayContaining(["COLLECTION_DEPENDENCY", "DESIRED_SELECTION_DEPENDENCY"]),
    );
    expect(ordinary.plan.actions).toEqual([]);

    const cascadeOptions = { ...ordinaryOptions, cascade: true };
    const cascade = await planResourceRemove(t.env, cascadeOptions);
    expect(cascade.blocked).toEqual([]);
    expect(cascade.plan.actions.every((action) => action.target.startsWith(storeRoot))).toBe(true);
    const removed = await applyResourceRemovePlan(t.env, cascade.plan, {
      storeRoot,
      options: cascadeOptions,
    });
    expect(removed.operation.ok).toBe(true);
    await expect(
      t.env.fs.lstat(join(storeRoot, "store", "skills", "forked-skill")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await loadConfig(t.env, storeRoot)).artifacts["skills/forked-skill"]).toBeUndefined();
    expect(
      await t.env.fs.readFile(join(storeRoot, "store", "skills", "example-skill", "SKILL.md")),
    ).toContain("name: example-skill");
  }, 30_000);

  // This real transaction must finish before fixture teardown; Vitest timeouts do not cancel it.
  it("exports deterministic portable reference-only bundles and validates the complete bundle before collision-safe import", async () => {
    await installSkill(t, storeRoot, "example-skill", LOCAL_SNAPSHOT_SOURCE, SKILL_WITH_REFERENCE);
    const firstPath = t.path("exports", "one.cellarer-resource.json");
    const secondPath = t.path("exports", "two.cellarer-resource.json");
    await t.env.fs.mkdir(t.path("exports"), { recursive: true });
    const firstOptions = { storeRoot, resourceId: "skills/example-skill", bundlePath: firstPath };
    const first = await planResourceExport(t.env, firstOptions);
    const firstApplied = await applyResourceExportPlan(t.env, first.plan, {
      storeRoot,
      options: firstOptions,
    });
    expect(firstApplied.operation.ok).toBe(true);
    const secondOptions = { ...firstOptions, bundlePath: secondPath };
    const second = await planResourceExport(t.env, secondOptions);
    const secondApplied = await applyResourceExportPlan(t.env, second.plan, {
      storeRoot,
      options: secondOptions,
    });
    expect(secondApplied.operation.ok).toBe(true);

    const firstBytes = await t.env.fs.readFile(firstPath);
    expect(await t.env.fs.readFile(secondPath)).toBe(firstBytes);
    expect(firstBytes).toContain(`\${CELLARER_SECRET:github-token}`);
    expect(firstBytes).not.toContain(LOCAL_SNAPSHOT_SOURCE.capturedFrom);
    expect(firstBytes).not.toContain("state.json");
    expect(firstBytes).not.toContain("operations");
    expect(firstBytes).not.toContain(t.root);
    await expect(validateResourceBundle(t.env, { bundlePath: firstPath })).resolves.toMatchObject({
      resource: { resourceId: "skills/example-skill" },
      bundleDigest: expect.stringMatching(/^sha256:/),
    });

    const imported = makeTmpEnv({ randomId: sequenceIds("resource-import") });
    try {
      await ensureBaseDirs(imported);
      const importedStore = imported.path("home", ".cellarer");
      await initStore(imported.env, importedStore);
      const importedBundle = imported.path("input", "bundle.json");
      await imported.env.fs.mkdir(join(imported.root, "input"), { recursive: true });
      await imported.env.fs.writeFile(importedBundle, firstBytes);
      const importOptions = { storeRoot: importedStore, bundlePath: importedBundle };

      const orphanMetadata = resourceMetadataPath(importedStore, "skills", "example-skill");
      await imported.env.fs.mkdir(join(importedStore, "store", "metadata", "skills"), {
        recursive: true,
      });
      await imported.env.fs.writeFile(orphanMetadata, "orphan\n");
      await expect(planResourceBundleImport(imported.env, importOptions)).rejects.toMatchObject({
        code: "RESOURCE_COLLISION",
      });
      await imported.env.fs.rm(orphanMetadata, { force: true });

      const orphanRevisionRoot = join(
        importedStore,
        "store",
        "skills",
        ".cellarer-revisions",
        "example-skill",
      );
      await imported.env.fs.mkdir(orphanRevisionRoot, { recursive: true });
      await expect(planResourceBundleImport(imported.env, importOptions)).rejects.toMatchObject({
        code: "RESOURCE_COLLISION",
      });
      await imported.env.fs.rm(orphanRevisionRoot, { recursive: true, force: true });

      const planned = await planResourceBundleImport(imported.env, importOptions);
      const applied = await applyResourceBundleImportPlan(imported.env, planned.plan, {
        storeRoot: importedStore,
        options: importOptions,
      });
      expect(applied.operation.ok).toBe(true);
      expect(
        await imported.env.fs.readFile(
          join(importedStore, "store", "skills", "example-skill", "SKILL.md"),
        ),
      ).toBe(SKILL_WITH_REFERENCE);
      await expect(planResourceBundleImport(imported.env, importOptions)).rejects.toMatchObject({
        code: "RESOURCE_COLLISION",
      });

      const hostile = firstBytes.replace('"path": "SKILL.md"', '"path": "../SKILL.md"');
      await imported.env.fs.writeFile(importedBundle, hostile);
      await expect(
        validateResourceBundle(imported.env, { bundlePath: importedBundle }),
      ).rejects.toMatchObject({ code: "INVALID_BUNDLE" });
    } finally {
      await imported.cleanup();
    }
  }, 30_000);

  it("rejects a re-sealed lifecycle plan whose business input or exact action set was substituted", async () => {
    await installSkill(t, storeRoot, "second-skill", LOCAL_SNAPSHOT_SOURCE);
    const options = {
      storeRoot,
      resourceId: "skills/example-skill",
      newName: "renamed-example",
      mode: "local-fork" as const,
    };
    const original = await planResourceRename(t.env, options);
    const forged = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: original.plan.schemaVersion,
      planId: "plan-resealed-resource-substitution",
      operation: original.plan.operation,
      baseRevision: original.plan.baseRevision,
      normalizedInputs: {
        ...original.plan.normalizedInputs,
        businessInput: {
          operation: "rename",
          resourceId: "skills/second-skill",
          newName: "renamed-example",
          mode: "local-fork",
        },
      },
      targetPreconditions: original.plan.targetPreconditions,
      actions: original.plan.actions,
      expires: original.plan.expires,
    });
    const rejected = await applyResourceRenamePlan(t.env, forged, { storeRoot, options });
    expect(rejected.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    await expect(
      t.env.fs.lstat(join(storeRoot, "store", "skills", "renamed-example")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("drift-aware sync target uninstall", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv({ randomId: sequenceIds("sync-uninstall") });
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
    await installSkill(t, storeRoot, "example-skill", LOCAL_SNAPSHOT_SOURCE);
    const deployed = await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["codex"],
      capabilities: ["skills"],
      method: "copy",
    });
    expect(deployed.failures).toEqual([]);
  });

  afterEach(() => t.cleanup());

  it("blocks drift, binds an exact override, and removes only the owned target plus owner record", async () => {
    const owner = (await loadLedger(t.env, storeRoot)).owners[0];
    if (!owner) throw new Error("expected owner");
    await t.env.fs.writeFile(join(owner.target, "SKILL.md"), `${SKILL}\n# drift\n`);
    const blockedOptions = { storeRoot, targetKeys: [entryKey(owner)] };
    const blocked = await planSyncTargetUninstall(t.env, blockedOptions);
    expect(blocked.targets[0]).toMatchObject({ blocked: true, classification: "owned-drifted" });
    expect(blocked.conflicts[0]).toMatchObject({
      code: "UNINSTALL_TARGET_DRIFTED",
      acknowledgement: { kind: "uninstall-drift" },
    });
    const token = blocked.conflicts[0]?.acknowledgement?.token;
    if (!token) throw new Error("expected acknowledgement");

    const options = { ...blockedOptions, acknowledgements: [token] };
    const planned = await planSyncTargetUninstall(t.env, options);
    expect(planned.targets[0]).toMatchObject({ blocked: false, driftOverridden: true });
    const applied = await applySyncTargetUninstallPlan(t.env, planned.mutationPlan, {
      storeRoot,
      options,
    });
    expect(applied.operation.ok).toBe(true);
    await expect(t.env.fs.lstat(owner.target)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await loadLedger(t.env, storeRoot)).owners).toEqual([]);
    expect(
      await t.env.fs.readFile(join(storeRoot, "store", "skills", "example-skill", "SKILL.md")),
    ).toContain("name: example-skill");
  });

  it("leaves a durable recovery journal when state publication is interrupted", async () => {
    const owner = (await loadLedger(t.env, storeRoot)).owners[0];
    if (!owner) throw new Error("expected owner");
    const options = { storeRoot, targetKeys: [entryKey(owner)] };
    const planned = await planSyncTargetUninstall(t.env, options);
    const originalPublish = t.env.fs.publishFileAtomically;
    let statePublications = 0;
    t.env.fs.publishFileAtomically = async (path, data, opts) => {
      if (path === join(storeRoot, "state.json")) {
        statePublications += 1;
        if (statePublications > 0)
          throw Object.assign(new Error("state publication interrupted"), { code: "EIO" });
      }
      return originalPublish(path, data, opts);
    };
    await expect(
      applySyncTargetUninstallPlan(t.env, planned.mutationPlan, { storeRoot, options }),
    ).rejects.toThrow("state publication interrupted");
    expect(await t.env.fs.readFile(operationJournalPath(storeRoot))).toMatch(
      /publishing-state|recovery-required/,
    );
  });

  it("does not accept a structural or expired caller lease for uninstall apply", async () => {
    const owner = (await loadLedger(t.env, storeRoot)).owners[0];
    if (!owner) throw new Error("expected owner");
    const options = { storeRoot, targetKeys: [entryKey(owner)] };
    const planned = await planSyncTargetUninstall(t.env, options);
    const authority = t.env.mutationAuthority;
    if (!authority) throw new Error("expected mutation authority");
    const expiredLease = await authority.acquireLease();
    await expiredLease.release();
    const fakeLease = Object.freeze({
      isCurrent: async () => true,
      release: async () => undefined,
    });
    const productEffects: string[] = [];
    let clockReads = 0;
    const originalFs = t.env.fs;
    t.env.fs = new Proxy(originalFs, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (..._args: unknown[]) => {
          productEffects.push(String(property));
          throw new Error(`unexpected product effect: ${String(property)}`);
        };
      },
    });
    t.env.now = () => {
      clockReads += 1;
      throw new Error("unexpected clock read");
    };
    t.env.mutationAuthority = deterministicMutationAuthority({ isCurrent: async () => false });

    for (const injectedLease of [fakeLease, expiredLease]) {
      const applied = await Reflect.apply(applySyncTargetUninstallPlan, undefined, [
        t.env,
        planned.mutationPlan,
        { storeRoot, options },
        { authorityLease: injectedLease },
      ]);
      expect(applied.operation).toMatchObject({
        ok: false,
        conflict: { code: "INVALID_PLAN" },
      });
      expect(productEffects).toEqual([]);
      expect(clockReads).toBe(0);
    }
  });

  it("updates the project gitignore helper from the resulting owner set", async () => {
    const projectRoot = t.path("project");
    await t.env.fs.mkdir(projectRoot, { recursive: true });
    const deployed = await apply(t.env, {
      storeRoot,
      scope: "project",
      dir: projectRoot,
      agents: ["codex"],
      capabilities: ["skills"],
      method: "copy",
    });
    expect(deployed.failures).toEqual([]);
    const projectOwner = (await loadLedger(t.env, storeRoot)).owners.find(
      (owner) => owner.scope === "project",
    );
    if (!projectOwner) throw new Error("expected project owner");
    expect(await t.env.fs.readFile(join(projectRoot, ".gitignore"))).toContain("cellarer");

    const options = { storeRoot, targetKeys: [entryKey(projectOwner)] };
    const planned = await planSyncTargetUninstall(t.env, options);
    expect(planned.mutationPlan.actions.map((action) => action.kind)).toEqual([
      "remove-target",
      "sync-gitignore",
    ]);
    const applied = await applySyncTargetUninstallPlan(t.env, planned.mutationPlan, {
      storeRoot,
      options,
    });
    expect(applied.operation.ok).toBe(true);
    await expect(t.env.fs.lstat(join(projectRoot, ".gitignore"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await loadLedger(t.env, storeRoot)).owners).toHaveLength(1);
  });
});

async function installSkill(
  t: TmpEnv,
  storeRoot: string,
  name: string,
  source: Parameters<typeof createResourceRecord>[0]["source"],
  contentTemplate = SKILL,
): Promise<void> {
  const path = join(storeRoot, "store", "skills", name);
  const content = contentTemplate.replaceAll("example-skill", name);
  await t.env.fs.mkdir(path, { recursive: true });
  await t.env.fs.writeFile(join(path, "SKILL.md"), content);
  const fingerprint = treeFingerprint((await t.env.fs.snapshotTreeNoFollow(path)).nodes);
  await writeSkillProvenance(
    t.env,
    storeRoot,
    name,
    createResourceRecord({
      resourceId: `skills/${name}`,
      kind: "skills",
      name,
      contentFingerprint: fingerprint,
      validation: {
        status: "validated",
        checkedAt: t.env.now().toISOString(),
        checks: ["content-fingerprint", "manifest", "secret-scan"],
      },
      source,
    }),
  );
}

async function installRule(
  t: TmpEnv,
  storeRoot: string,
  name: string,
  resourceId: string,
): Promise<void> {
  const content = "# stable rule\n";
  await t.env.fs.writeFile(join(storeRoot, "store", "rules", `${name}.md`), content);
  const record = createResourceRecord({
    resourceId,
    kind: "rules",
    name,
    contentFingerprint: sha256(content),
    validation: {
      status: "validated",
      checkedAt: t.env.now().toISOString(),
      checks: ["content-fingerprint", "secret-scan"],
    },
    source: { type: "local-snapshot" },
  });
  await t.env.fs.mkdir(join(storeRoot, "store", "metadata", "rules"), { recursive: true });
  await t.env.fs.writeFile(
    resourceMetadataPath(storeRoot, "rules", name),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

function treeFingerprint(
  nodes: Awaited<ReturnType<TmpEnv["env"]["fs"]["snapshotTreeNoFollow"]>>["nodes"],
): string {
  return sha256(
    JSON.stringify(
      [...nodes]
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
        .map((node) =>
          node.kind === "directory"
            ? { path: node.relativePath, kind: node.kind, mode: node.mode }
            : {
                path: node.relativePath,
                kind: node.kind,
                mode: node.mode,
                digest: sha256(node.data ?? new Uint8Array()),
              },
        ),
    ),
  );
}

function sequenceIds(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}
