import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createResourceRecord,
  loadResourceRecord,
  parseResourceRecord,
  resourceSourceCanCheckForUpdates,
  resourceSourceDescriptorSchema,
} from "../src/resources/model.js";
import { initStore, skillProvenancePath, writeSkillProvenance } from "../src/store/store.js";
import {
  FIRST_CONTENT_FINGERPRINT,
  GIT_SOURCE,
  LOCAL_SNAPSHOT_SOURCE,
  SECOND_CONTENT_FINGERPRINT,
  UNPROVABLE_LEGACY_PROVENANCE,
  URL_SOURCE,
} from "./fixtures/resource-lifecycle.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("resource identity, revision, and provenance", () => {
  it("keeps immutable resource identity while content-addressed revisions change", () => {
    const first = createResourceRecord({
      resourceId: "skills/example-skill",
      kind: "skills",
      name: "example-skill",
      contentFingerprint: FIRST_CONTENT_FINGERPRINT,
      validation: {
        status: "validated",
        checkedAt: "2026-06-30T08:00:00.000Z",
        checks: ["content-fingerprint", "manifest", "secret-scan"],
      },
      source: GIT_SOURCE,
    });
    const second = createResourceRecord({
      resourceId: first.resourceId,
      kind: first.kind,
      name: first.name,
      contentFingerprint: SECOND_CONTENT_FINGERPRINT,
      validation: first.currentRevision.validation,
      source: { ...GIT_SOURCE, commit: "fedcba9876543210fedcba9876543210fedcba98" },
    });

    expect(first.resourceId).toBe(second.resourceId);
    expect(first.currentRevision.id).not.toBe(second.currentRevision.id);
    expect(first.currentRevision.contentFingerprint).toBe(FIRST_CONTENT_FINGERPRINT);
    expect(parseResourceRecord(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });

  it("only claims update checking for descriptors with immutable remote evidence", () => {
    expect(resourceSourceCanCheckForUpdates(LOCAL_SNAPSHOT_SOURCE)).toBe(false);
    expect(resourceSourceCanCheckForUpdates(GIT_SOURCE)).toBe(true);
    expect(resourceSourceCanCheckForUpdates(URL_SOURCE)).toBe(true);
    expect(resourceSourceCanCheckForUpdates({ ...GIT_SOURCE, commit: null })).toBe(false);
    expect(() =>
      resourceSourceDescriptorSchema.parse({
        ...URL_SOURCE,
        url: "https://user:plaintext-password@example.test/resource.tar.gz",
      }),
    ).toThrow(/credential|secret/i);
  });
});

describe("legacy resource evidence backfill", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });

  afterEach(() => t.cleanup());

  it("backfills the current managed fingerprint and downgrades unprovable Git metadata", async () => {
    const skillPath = t.path("home", ".cellarer", "store", "skills", "legacy-skill");
    await t.env.fs.mkdir(skillPath, { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "store", "skills", "legacy-skill", "SKILL.md"),
      "# legacy\n",
    );
    await t.env.fs.writeFile(
      skillProvenancePath(storeRoot, "legacy-skill"),
      `${JSON.stringify(UNPROVABLE_LEGACY_PROVENANCE, null, 2)}\n`,
    );

    const record = await loadResourceRecord(t.env, storeRoot, {
      id: "skills/legacy-skill",
      kind: "skills",
      name: "legacy-skill",
      sourcePath: skillPath,
      collections: [],
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      resourceId: "skills/legacy-skill",
      currentRevision: {
        contentFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        validation: {
          status: "backfilled",
          checks: ["content-fingerprint"],
        },
        source: { type: "local-snapshot" },
      },
    });
    expect(resourceSourceCanCheckForUpdates(record.currentRevision.source)).toBe(false);
  });

  it("retains only complete legacy Git evidence as an update-checkable descriptor", async () => {
    const skillPath = t.path("home", ".cellarer", "store", "skills", "legacy-skill");
    await t.env.fs.mkdir(skillPath, { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "store", "skills", "legacy-skill", "SKILL.md"),
      "# legacy\n",
    );
    await t.env.fs.writeFile(
      skillProvenancePath(storeRoot, "legacy-skill"),
      `${JSON.stringify(
        {
          ...UNPROVABLE_LEGACY_PROVENANCE,
          commit: "0123456789abcdef0123456789abcdef01234567",
        },
        null,
        2,
      )}\n`,
    );

    const record = await loadResourceRecord(t.env, storeRoot, {
      id: "skills/legacy-skill",
      kind: "skills",
      name: "legacy-skill",
      sourcePath: skillPath,
      collections: [],
    });

    expect(record.currentRevision.source).toEqual({
      type: "git",
      repositoryUrl: "https://github.com/example/skills.git",
      ref: "main",
      commit: "0123456789abcdef0123456789abcdef01234567",
      subpath: "skills/legacy-skill",
    });
    expect(resourceSourceCanCheckForUpdates(record.currentRevision.source)).toBe(true);
  });

  it("does not derive canonical identity from the current editable resource name", async () => {
    const skillPath = t.path("home", ".cellarer", "store", "skills", "renamed-skill");
    await t.env.fs.mkdir(skillPath, { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "store", "skills", "renamed-skill", "SKILL.md"),
      "# renamed\n",
    );
    const backfilled = await loadResourceRecord(t.env, storeRoot, {
      id: "skills/renamed-skill",
      kind: "skills",
      name: "renamed-skill",
      sourcePath: skillPath,
      collections: [],
    });
    const canonical = createResourceRecord({
      resourceId: "skills/original-skill",
      kind: "skills",
      name: "renamed-skill",
      contentFingerprint: backfilled.currentRevision.contentFingerprint,
      validation: backfilled.currentRevision.validation,
      source: backfilled.currentRevision.source,
    });
    await writeSkillProvenance(t.env, storeRoot, "renamed-skill", canonical);

    const loaded = await loadResourceRecord(t.env, storeRoot, {
      id: "skills/renamed-skill",
      kind: "skills",
      name: "renamed-skill",
      sourcePath: skillPath,
      collections: [],
    });

    expect(loaded.resourceId).toBe("skills/original-skill");
    expect(loaded.name).toBe("renamed-skill");
  });

  it("fails closed on hostile or structurally invalid metadata", async () => {
    const skillPath = t.path("home", ".cellarer", "store", "skills", "hostile");
    await t.env.fs.mkdir(skillPath, { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "store", "skills", "hostile", "SKILL.md"),
      "# hostile\n",
    );
    await t.env.fs.writeFile(
      skillProvenancePath(storeRoot, "hostile"),
      `${JSON.stringify({ ...UNPROVABLE_LEGACY_PROVENANCE, name: "hostile", extra: true })}\n`,
    );

    await expect(
      loadResourceRecord(t.env, storeRoot, {
        id: "skills/hostile",
        kind: "skills",
        name: "hostile",
        sourcePath: skillPath,
        collections: [],
      }),
    ).rejects.toThrow(/resource metadata|provenance/i);
  });
});
