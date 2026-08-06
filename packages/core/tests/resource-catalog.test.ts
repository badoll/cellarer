import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendActivity } from "../src/activity.js";
import { createResourceRecord, loadResourceRecord, resourceCatalog, sha256 } from "../src/index.js";
import { tagArtifactCollections } from "../src/store/config.js";
import { saveLedger } from "../src/store/ledger.js";
import {
  initStore,
  writeMcpArtifact,
  writeRuleArtifact,
  writeSkillProvenance,
} from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("resource catalog", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });

  afterEach(() => t.cleanup());

  it("lists managed resources with collections", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await tagArtifactCollections(t.env, storeRoot, ["rules/style"], "default");

    const catalog = await resourceCatalog(t.env, { storeRoot, kind: "rules" });

    expect(catalog.resources).toContainEqual(
      expect.objectContaining({
        id: "rules/style",
        kind: "rules",
        name: "style",
        state: "managed",
        collections: ["default"],
        provenance: { type: "local-snapshot" },
        currentRevision: expect.objectContaining({
          id: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          contentFingerprint: sha256("# style"),
          validation: expect.objectContaining({
            status: "backfilled",
            checks: ["content-fingerprint"],
          }),
        }),
      }),
    );
  });

  it("joins inventory state by immutable resource ID after the editable name changes", async () => {
    const sourcePath = t.path("home", ".cellarer", "store", "skills", "renamed");
    await t.env.fs.mkdir(sourcePath, { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "store", "skills", "renamed", "SKILL.md"),
      "# renamed\n",
    );
    const observed = await loadResourceRecord(t.env, storeRoot, {
      id: "skills/renamed",
      kind: "skills",
      name: "renamed",
      sourcePath,
      collections: [],
    });
    await writeSkillProvenance(
      t.env,
      storeRoot,
      "renamed",
      createResourceRecord({
        resourceId: "skills/original",
        kind: "skills",
        name: "renamed",
        contentFingerprint: observed.currentRevision.contentFingerprint,
        validation: observed.currentRevision.validation,
        source: observed.currentRevision.source,
      }),
    );
    await tagArtifactCollections(t.env, storeRoot, ["skills/original"], "default");

    const catalog = await resourceCatalog(t.env, { storeRoot, kind: "skills" });

    expect(catalog.resources).toEqual([
      expect.objectContaining({
        id: "skills/original",
        name: "renamed",
        collections: ["default"],
      }),
    ]);
  });

  it("marks synced and drifted targets from ledger status", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    const target = t.path("home", ".codex", "AGENTS.md");
    const content = "# style";
    await t.env.fs.mkdir(t.path("home", ".codex"), { recursive: true });
    await t.env.fs.writeFile(target, content);
    await saveLedger(t.env, storeRoot, {
      version: 2,
      owners: [
        {
          agent: "codex",
          scope: "global",
          capability: "rules",
          target,
          artifactIds: ["rules/style"],
          receipt: {
            method: "write",
            fingerprint: sha256(content),
            backup: null,
            generated: false,
            appliedAt: "2026-06-30T08:00:00.000Z",
          },
        },
      ],
    });

    let catalog = await resourceCatalog(t.env, { storeRoot, kind: "rules" });
    expect(catalog.resources[0]?.syncTargets[0]).toMatchObject({
      agent: "codex",
      destination: "user",
      state: "synced",
    });

    await t.env.fs.writeFile(target, "# changed");

    catalog = await resourceCatalog(t.env, { storeRoot, kind: "rules" });
    expect(catalog.resources[0]?.syncTargets[0]).toMatchObject({
      state: "drifted",
    });
  });

  it("counts resources by state", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await saveLedger(t.env, storeRoot, {
      version: 2,
      owners: [
        {
          agent: "codex",
          scope: "global",
          capability: "rules",
          target: t.path("home", ".codex", "AGENTS.md"),
          artifactIds: ["rules/style"],
          receipt: {
            method: "write",
            fingerprint: "sha256:missing",
            backup: null,
            generated: false,
            appliedAt: "2026-06-30T08:00:00.000Z",
          },
        },
      ],
    });

    const catalog = await resourceCatalog(t.env, { storeRoot, kind: "rules" });
    expect(catalog.counts).toMatchObject({ managed: 1, missing: 1 });
  });

  it("lists discovered agent-native resources before they are imported", async () => {
    await t.env.fs.mkdir(t.path("home", ".codex", "skills", "study"), { recursive: true });
    await t.env.fs.writeFile(t.path("home", ".codex", "AGENTS.md"), "# user rules");
    await t.env.fs.writeFile(
      t.path("home", ".codex", "config.toml"),
      `[mcp_servers.ctx]\ncommand = "npx"\n`,
    );

    const catalog = await resourceCatalog(t.env, {
      storeRoot,
      agents: ["codex"],
      destination: "user",
    });

    expect(catalog.counts).toMatchObject({
      managed: 0,
      discovered: 3,
    });
    expect(catalog.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "rules",
          name: "codex",
          state: "discovered",
          discovered: expect.objectContaining({
            agent: "codex",
            destination: "user",
            source: t.path("home", ".codex", "AGENTS.md"),
          }),
        }),
        expect.objectContaining({
          kind: "mcp",
          name: "ctx",
          state: "discovered",
          discovered: expect.objectContaining({
            agent: "codex",
            source: `${t.path("home", ".codex", "config.toml")} → ctx`,
          }),
        }),
        expect.objectContaining({
          kind: "skills",
          name: "study",
          state: "discovered",
          discovered: expect.objectContaining({
            agent: "codex",
            source: t.path("home", ".codex", "skills", "study"),
          }),
        }),
      ]),
    );
  });

  it("attaches a target only to its concrete contributing rule", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await writeRuleArtifact(t.env, storeRoot, "safety", "# safety");
    await saveLedger(t.env, storeRoot, {
      version: 2,
      owners: [
        {
          agent: "codex",
          scope: "global",
          capability: "rules",
          target: t.path("home", ".codex", "AGENTS.md"),
          artifactIds: ["rules/style"],
          receipt: {
            method: "write",
            fingerprint: "sha256:style",
            backup: null,
            generated: false,
            appliedAt: "2026-06-30T08:00:00.000Z",
          },
        },
      ],
    });

    const catalog = await resourceCatalog(t.env, { storeRoot, kind: "rules" });

    expect(catalog.resources).toHaveLength(2);
    expect(
      catalog.resources.find((resource) => resource.id === "rules/style")?.syncTargets,
    ).toHaveLength(1);
    expect(
      catalog.resources.find((resource) => resource.id === "rules/safety")?.syncTargets,
    ).toEqual([]);
    expect(catalog.counts).toMatchObject({
      managed: 2,
      synced: 0,
      drifted: 0,
      missing: 1,
    });
  });

  it("applies contributing MCP artifact IDs to exact metadata only", async () => {
    await writeMcpArtifact(t.env, storeRoot, "alpha", { kind: "stdio", command: "npx" });
    await writeMcpArtifact(t.env, storeRoot, "beta", { kind: "stdio", command: "node" });
    await saveLedger(t.env, storeRoot, {
      version: 2,
      owners: [
        {
          agent: "codex",
          scope: "global",
          capability: "mcp",
          target: t.path("home", ".codex", "config.toml"),
          artifactIds: ["mcp/alpha", "mcp/beta"],
          receipt: {
            method: "write",
            fingerprint: "sha256:combined",
            backup: null,
            generated: false,
            appliedAt: "2026-06-30T08:00:00.000Z",
          },
          secretRefs: ["CTX_TOKEN"],
        },
      ],
    });
    await appendActivity(t.env, storeRoot, {
      action: "apply",
      scope: "global",
      affectedCount: 1,
      summary: "update MCP collection",
      resources: {
        artifactIds: ["mcp/alpha, mcp/beta", "mcp/*"],
      },
    });

    const catalog = await resourceCatalog(t.env, { storeRoot, kind: "mcp" });

    expect(catalog.resources).toEqual([
      expect.objectContaining({
        id: "mcp/alpha",
        secretRefs: ["CTX_TOKEN"],
        lastActivityAt: "2026-06-30T08:00:00.000Z",
      }),
      expect.objectContaining({
        id: "mcp/beta",
        secretRefs: ["CTX_TOKEN"],
        lastActivityAt: "2026-06-30T08:00:00.000Z",
      }),
    ]);
  });
});
