import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendActivity,
  initStore,
  resourceCatalog,
  saveLedger,
  sha256,
  tagArtifactCollections,
  writeMcpArtifact,
  writeRuleArtifact,
} from "../src/index.js";
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
      }),
    );
  });

  it("marks synced and drifted targets from ledger status", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    const target = t.path("home", ".codex", "AGENTS.md");
    const content = "# style";
    await t.env.fs.mkdir(t.path("home", ".codex"), { recursive: true });
    await t.env.fs.writeFile(target, content);
    await saveLedger(t.env, storeRoot, {
      version: 1,
      entries: [
        {
          artifact: "rules/style",
          agent: "codex",
          scope: "global",
          capability: "rules",
          target,
          method: "write",
          checksum: sha256(content),
          backup: null,
          generated: false,
          appliedAt: "2026-06-30T08:00:00.000Z",
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
      version: 1,
      entries: [
        {
          artifact: "rules/style",
          agent: "codex",
          scope: "global",
          capability: "rules",
          target: t.path("home", ".codex", "AGENTS.md"),
          method: "write",
          checksum: "sha256:missing",
          backup: null,
          generated: false,
          appliedAt: "2026-06-30T08:00:00.000Z",
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

  it("does not attach wildcard rule sync targets to individual managed rules", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await writeRuleArtifact(t.env, storeRoot, "safety", "# safety");
    await saveLedger(t.env, storeRoot, {
      version: 1,
      entries: [
        {
          artifact: "rules/*",
          agent: "codex",
          scope: "global",
          capability: "rules",
          target: t.path("home", ".codex", "AGENTS.md"),
          method: "write",
          checksum: "sha256:wildcard",
          backup: null,
          generated: false,
          appliedAt: "2026-06-30T08:00:00.000Z",
        },
      ],
    });

    const catalog = await resourceCatalog(t.env, { storeRoot, kind: "rules" });

    expect(catalog.resources).toHaveLength(2);
    expect(catalog.resources.map((resource) => resource.syncTargets)).toEqual([[], []]);
    expect(catalog.counts).toMatchObject({
      managed: 2,
      synced: 0,
      drifted: 0,
      missing: 0,
    });
  });

  it("applies comma-separated mcp identities to exact metadata only", async () => {
    await writeMcpArtifact(t.env, storeRoot, "alpha", { kind: "stdio", command: "npx" });
    await writeMcpArtifact(t.env, storeRoot, "beta", { kind: "stdio", command: "node" });
    await saveLedger(t.env, storeRoot, {
      version: 1,
      entries: [
        {
          artifact: "mcp/alpha, mcp/beta",
          agent: "codex",
          scope: "global",
          capability: "mcp",
          target: t.path("home", ".codex", "config.toml"),
          method: "write",
          checksum: "sha256:combined",
          backup: null,
          generated: false,
          appliedAt: "2026-06-30T08:00:00.000Z",
          secretRefs: ["CTX_TOKEN"],
        },
        {
          artifact: "mcp/*",
          agent: "codex",
          scope: "global",
          capability: "mcp",
          target: t.path("home", ".codex", "config.toml"),
          method: "write",
          checksum: "sha256:wildcard",
          backup: null,
          generated: false,
          appliedAt: "2026-06-30T08:01:00.000Z",
          secretRefs: ["SHOULD_NOT_ATTACH"],
        },
      ],
    });
    await appendActivity(t.env, storeRoot, {
      action: "apply",
      scope: "global",
      affectedCount: 1,
      summary: "update MCP collection",
      references: {
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
