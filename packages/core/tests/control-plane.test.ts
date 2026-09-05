import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  diffControlPlane,
  listControlPlaneAgents,
  listControlPlaneCollections,
  listControlPlaneOperations,
  listControlPlaneResources,
  sha256,
  showControlPlaneAgent,
  showControlPlaneCollection,
  showControlPlaneConfig,
  showControlPlaneOperation,
  showControlPlaneResource,
  statusControlPlane,
  summaryControlPlane,
  validateControlPlaneConfig,
  verifyControlPlane,
} from "../src/index.js";
import { readStoreRevision } from "../src/protocol/store-revision.js";
import {
  loadConfig,
  projectPublicControlPlaneConfig,
  tagArtifactCollections,
} from "../src/store/config.js";
import { saveLedger } from "../src/store/ledger.js";
import { initStore, writeRuleArtifact } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("shared control-plane DTO contracts", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });

  afterEach(() => t.cleanup());

  it("publishes one Core-owned service API for every shared DTO family", () => {
    for (const service of [
      listControlPlaneResources,
      showControlPlaneResource,
      listControlPlaneAgents,
      showControlPlaneAgent,
      listControlPlaneCollections,
      showControlPlaneCollection,
      showControlPlaneConfig,
      validateControlPlaneConfig,
      diffControlPlane,
      statusControlPlane,
      verifyControlPlane,
      summaryControlPlane,
      listControlPlaneOperations,
      showControlPlaneOperation,
    ]) {
      expect(service).toBeTypeOf("function");
    }
  });

  it("returns exact resource identity, membership, selection, validation, and usage", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await tagArtifactCollections(t.env, storeRoot, ["rules/style"], "default");

    const result = await listControlPlaneResources(t.env, {
      storeRoot,
      kind: "rules",
      includeDiscovered: false,
    });

    expect(result.counts).toMatchObject({ managed: 1 });
    expect(result.resources).toEqual([
      expect.objectContaining({
        id: "rules/style",
        kind: "rules",
        name: "style",
        source: expect.stringContaining("store/rules/style.md"),
        state: "managed",
        membership: { collections: ["default"] },
        selection: { desired: true, collections: ["default"] },
        validation: { status: "valid", issues: [] },
        secretReferenceNames: [],
        usage: { desired: [{ collection: "default" }], applied: [] },
      }),
    ]);

    await expect(
      showControlPlaneResource(t.env, {
        storeRoot,
        resourceId: "rules/style",
        includeDiscovered: false,
      }),
    ).resolves.toMatchObject({ resource: { id: "rules/style" } });
  });

  it("filters target sync states without changing resource-level state or count semantics", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    const target = t.path("project", "AGENTS.md");
    await t.env.fs.mkdir(t.path("project"), { recursive: true });
    await t.env.fs.writeFile(target, "# style");
    await saveLedger(t.env, storeRoot, {
      version: 2,
      owners: [
        {
          agent: "codex",
          scope: "project",
          projectRoot: t.path("project"),
          capability: "rules",
          target,
          artifactIds: ["rules/style"],
          receipt: {
            method: "write",
            fingerprint: sha256("# style"),
            backup: null,
            generated: true,
            appliedAt: "2026-06-30T08:00:00.000Z",
          },
        },
      ],
    });

    const result = await listControlPlaneResources(t.env, {
      storeRoot,
      agents: ["codex"],
      destination: "project",
      dir: t.path("project"),
      states: ["synced"],
      includeDiscovered: false,
    });

    expect(result.resources).toEqual([
      expect.objectContaining({
        id: "rules/style",
        state: "managed",
        usage: {
          desired: expect.any(Array),
          applied: [expect.objectContaining({ state: "synced" })],
        },
      }),
    ]);
    expect(result.counts).toEqual({
      managed: 1,
      discovered: 0,
      synced: 1,
      drifted: 0,
      missing: 0,
      blocked: 0,
    });
  });

  it("returns agent, collection, config, diff, status, verify, summary, and operation DTOs", async () => {
    const sharedScope = { storeRoot, scope: "global" as const, agents: [] };

    const [agents, collections, config, diff, status, verification, summary, operations] =
      await Promise.all([
        listControlPlaneAgents(t.env, sharedScope),
        listControlPlaneCollections(t.env, { storeRoot }),
        showControlPlaneConfig(t.env, { storeRoot }),
        diffControlPlane(t.env, sharedScope),
        statusControlPlane(t.env, { storeRoot }),
        verifyControlPlane(t.env, sharedScope),
        summaryControlPlane(t.env, {
          storeRoot,
          scope: "global",
          agents: [],
          includePlanCoverage: false,
        }),
        listControlPlaneOperations(t.env, { storeRoot }),
      ]);

    expect(agents).toMatchObject({ scope: "global", agents: expect.any(Array) });
    expect(collections).toMatchObject({ revision: 0, collections: expect.any(Array) });
    expect(config).toMatchObject({ revision: 0, config: { defaults: expect.any(Object) } });
    expect(diff).toMatchObject({ storeRevision: 0, status: expect.any(String), items: [] });
    expect(status).toMatchObject({ generatedAt: expect.any(String), items: [] });
    expect(verification).toMatchObject({
      storeRevision: 0,
      healthy: false,
      configuration: "no-op",
      runtime: { observation: "unknown" },
    });
    expect(summary).toMatchObject({
      generatedAt: expect.any(String),
      artifactCounts: { total: 0 },
    });
    expect(operations).toEqual({ operations: [] });
  });

  it("reports structured config locations and never mutates while validating", async () => {
    expect(validateControlPlaneConfig({ version: 1, unknown: true })).toEqual({
      valid: false,
      issues: [expect.objectContaining({ path: "unknown", message: expect.any(String) })],
    });
    expect(validateControlPlaneConfig({ version: 1 })).toMatchObject({
      valid: true,
      config: { version: 1 },
      issues: [],
    });
  });

  it.each([
    [
      "accessor",
      () => {
        let executions = 0;
        const input = { version: 1 } as Record<string, unknown>;
        Object.defineProperty(input, "unknown", {
          enumerable: true,
          get() {
            executions += 1;
            return true;
          },
        });
        return { input, executions: () => executions };
      },
    ],
    [
      "Proxy",
      () => {
        let executions = 0;
        const input = new Proxy(
          { version: 1 },
          {
            get(target, key, receiver) {
              executions += 1;
              return Reflect.get(target, key, receiver);
            },
            ownKeys(target) {
              executions += 1;
              return Reflect.ownKeys(target);
            },
          },
        );
        return { input, executions: () => executions };
      },
    ],
    [
      "toJSON hiding an unknown field",
      () => {
        let executions = 0;
        const input = { version: 1, unknown: true } as Record<string, unknown>;
        Object.defineProperty(input, "toJSON", {
          value() {
            executions += 1;
            return { version: 1 };
          },
        });
        return { input, executions: () => executions };
      },
    ],
    [
      "custom prototype",
      () => ({
        input: Object.assign(Object.create({ inherited: true }), { version: 1 }),
        executions: () => 0,
      }),
    ],
    [
      "symbol key",
      () => ({ input: { version: 1, [Symbol("unknown")]: true }, executions: () => 0 }),
    ],
    [
      "prototype-like key",
      () => {
        const input = { version: 1 } as Record<string, unknown>;
        Object.defineProperty(input, "constructor", { enumerable: true, value: "unsafe" });
        return { input, executions: () => 0 };
      },
    ],
  ])("fails closed for runtime config %s without executing user code", (_label, create) => {
    const hostile = create();

    expect(validateControlPlaneConfig(hostile.input)).toMatchObject({ valid: false });
    expect(hostile.executions()).toBe(0);
  });
});

describe("control-plane config snapshot", () => {
  let t: TmpEnv;
  let storeRoot: string;
  let configurationPath: string;
  let revisionPath: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    configurationPath = join(storeRoot, "config.json");
    revisionPath = join(storeRoot, "revision.json");
    await initStore(t.env, storeRoot);
  });

  afterEach(() => t.cleanup());

  it("config preserves the legacy projected DTO exactly", async () => {
    await writeControlPlaneConfiguration(t, configurationPath, "parity");
    await writeControlPlaneRevision(t, revisionPath, 5);
    const expected = {
      revision: await readStoreRevision(t.env, storeRoot),
      config: projectPublicControlPlaneConfig(await loadConfig(t.env, storeRoot)),
    };

    const result = await showControlPlaneConfig(t.env, { storeRoot });

    expect(result).toEqual(expected);
    expect(Object.keys(result).sort()).toEqual(["config", "revision"]);
  });

  it("config retries concurrent drift instead of returning a mixed DTO", async () => {
    await writeControlPlaneConfiguration(t, configurationPath, "discarded");
    await writeControlPlaneRevision(t, revisionPath, 0);
    const baseReadFile = t.env.fs.readFile;
    const baseSnapshotPathNoFollow = t.env.fs.snapshotPathNoFollow;
    let releaseConfigRead: (() => void) | undefined;
    const configRead = new Promise<void>((resolve) => {
      releaseConfigRead = resolve;
    });
    let configurationSnapshots = 0;
    const advanceStore = async () => {
      await writeControlPlaneConfiguration(t, configurationPath, "accepted");
      await writeControlPlaneRevision(t, revisionPath, 1);
    };
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        readFile: async (path) => {
          if (path === configurationPath) {
            const text = await baseReadFile(path);
            releaseConfigRead?.();
            return text;
          }
          if (path === revisionPath) {
            await configRead;
            await advanceStore();
          }
          return baseReadFile(path);
        },
        snapshotPathNoFollow: async (anchorRoot, path) => {
          const snapshot = await baseSnapshotPathNoFollow(anchorRoot, path);
          if (path === configurationPath) {
            configurationSnapshots += 1;
            if (configurationSnapshots === 1) await advanceStore();
          }
          return snapshot;
        },
      },
    };

    const result = await showControlPlaneConfig(env, { storeRoot });

    expect(result.revision).toBe(1);
    expect(result.config.collections.accepted?.description).toBe("accepted");
    expect(result.config.collections.discarded).toBeUndefined();
    expect(configurationSnapshots).toBe(2);
  });
});

async function writeControlPlaneConfiguration(
  t: TmpEnv,
  path: string,
  name: string,
): Promise<void> {
  await t.env.fs.writeFile(
    path,
    `${JSON.stringify({ collections: { [name]: { description: name } } })}\n`,
  );
}

async function writeControlPlaneRevision(t: TmpEnv, path: string, revision: number): Promise<void> {
  await t.env.fs.writeFile(path, `${JSON.stringify({ schemaVersion: 1, revision })}\n`);
}
