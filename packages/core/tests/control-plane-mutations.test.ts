import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyControlPlaneMutationPlan,
  type ControlPlaneDependencyError,
  type ControlPlaneValidationError,
  loadConfig,
  mutateAgentAdapter,
  mutateBuiltinAgent,
  mutateCollection,
  mutateControlPlaneSettings,
  mutateCustomAdapter,
  parseAgentEnabledMutationBody,
} from "../src/index.js";
import { createAuthorizedMutationPlan } from "../src/protocol/canonical.js";
import { listOperationReceipts } from "../src/protocol/journal.js";
import type { MutationPlan } from "../src/protocol/models.js";
import { readStoreRevision } from "../src/protocol/store-revision.js";
import { sha256 } from "../src/store/checksum.js";
import { saveLedger } from "../src/store/ledger.js";
import { initStore, writeRuleArtifact } from "../src/store/store.js";
import { ensureBaseDirs, FIXED_NOW, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("planned control-plane mutations", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });

  afterEach(() => t.cleanup());

  it("dry-runs and applies built-in adapterOverrides with revisioned receipts", async () => {
    const before = await loadConfig(t.env, storeRoot);
    const dryRun = await mutateBuiltinAgent(t.env, {
      storeRoot,
      agentId: "codex",
      action: "disable",
      dryRun: true,
    });

    expect(dryRun).toMatchObject({
      changedFields: ["adapterOverrides.codex.enabled"],
      plan: { operation: "settings", baseRevision: 0 },
    });
    expect(dryRun.receipt).toBeUndefined();
    await expect(loadConfig(t.env, storeRoot)).resolves.toEqual(before);
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(listOperationReceipts(t.env, storeRoot)).resolves.toEqual([]);

    const applied = await mutateBuiltinAgent(t.env, {
      storeRoot,
      agentId: "codex",
      action: "disable",
    });

    expect(applied.receipt).toMatchObject({
      operation: "settings",
      baseRevision: 0,
      resultingRevision: 1,
      outcome: "committed",
      changedFields: ["adapterOverrides.codex.enabled"],
    });
    expect((await loadConfig(t.env, storeRoot)).adapterOverrides.codex).toEqual({
      enabled: false,
    });

    await mutateBuiltinAgent(t.env, {
      storeRoot,
      agentId: "codex",
      action: "configure",
      adapter: { displayName: "Codex Local", mcp: { mergeStrategy: "overwrite" } },
    });
    expect((await loadConfig(t.env, storeRoot)).adapterOverrides.codex).toMatchObject({
      enabled: false,
      displayName: "Codex Local",
      mcp: { mergeStrategy: "overwrite" },
    });

    await mutateBuiltinAgent(t.env, {
      storeRoot,
      agentId: "codex",
      action: "reset",
    });
    expect((await loadConfig(t.env, storeRoot)).adapterOverrides.codex).toBeUndefined();
  });

  it("round-trips the exact serialized settings plan through the public apply service", async () => {
    const planned = await mutateBuiltinAgent(t.env, {
      storeRoot,
      agentId: "codex",
      action: "disable",
      dryRun: true,
    });

    const applied = await applyControlPlaneMutationPlan(
      t.env,
      JSON.parse(JSON.stringify(planned.plan)),
      { storeRoot },
    );

    expect(applied).toMatchObject({
      changedFields: ["adapterOverrides.codex.enabled"],
      operation: { ok: true, receipt: { outcome: "committed", resultingRevision: 1 } },
    });
    expect((await loadConfig(t.env, storeRoot)).adapterOverrides.codex).toEqual({
      enabled: false,
    });
  });

  it("round-trips serialized custom-adapter, settings, and collection plans", async () => {
    const custom = await mutateCustomAdapter(t.env, {
      storeRoot,
      action: "add",
      agentId: "roundtrip-agent",
      adapter: { rules: { global: "~/.roundtrip/RULES.md" } },
      dryRun: true,
    });
    expect(
      (
        await applyControlPlaneMutationPlan(t.env, JSON.parse(JSON.stringify(custom.plan)), {
          storeRoot,
        })
      ).operation,
    ).toMatchObject({ ok: true, receipt: { resultingRevision: 1 } });

    const settings = await mutateControlPlaneSettings(t.env, {
      storeRoot,
      action: "update",
      settings: { method: "copy" },
      dryRun: true,
    });
    expect(
      (
        await applyControlPlaneMutationPlan(t.env, JSON.parse(JSON.stringify(settings.plan)), {
          storeRoot,
        })
      ).operation,
    ).toMatchObject({ ok: true, receipt: { resultingRevision: 2 } });

    await writeRuleArtifact(t.env, storeRoot, "roundtrip", "# roundtrip");
    const collection = await mutateCollection(t.env, {
      storeRoot,
      action: "create",
      collectionName: "roundtrip",
      resourceIds: ["rules/roundtrip"],
      dryRun: true,
    });
    expect(
      (
        await applyControlPlaneMutationPlan(t.env, JSON.parse(JSON.stringify(collection.plan)), {
          storeRoot,
        })
      ).operation,
    ).toMatchObject({ ok: true, receipt: { resultingRevision: 3 } });

    await expect(loadConfig(t.env, storeRoot)).resolves.toMatchObject({
      defaults: { method: "copy" },
      customAdapters: { "roundtrip-agent": expect.any(Object) },
      collections: { roundtrip: {} },
      artifacts: { "rules/roundtrip": { collections: ["roundtrip"] } },
    });
  });

  it.each([
    "plan",
    "options",
  ] as const)("preflights hostile serialized apply %s before every Env touch", async (kind) => {
    const planned = await mutateBuiltinAgent(t.env, {
      storeRoot,
      agentId: "codex",
      action: "disable",
      dryRun: true,
    });
    let executions = 0;
    let envTouches = 0;
    const env = new Proxy(t.env, {
      get(target, key, receiver) {
        envTouches += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const hostilePlan = new Proxy(planned.plan, {
      get(target, key, receiver) {
        executions += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const hostileOptions = new Proxy(
      { storeRoot, unknown: true },
      {
        get(target, key, receiver) {
          executions += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const invalidPlan = { ...planned.plan, digest: "sha256:invalid" };

    await expect(
      applyControlPlaneMutationPlan(
        env,
        kind === "plan" ? hostilePlan : invalidPlan,
        kind === "options" ? (hostileOptions as never) : { storeRoot },
      ),
    ).rejects.toMatchObject({
      name: "ControlPlaneValidationError",
      code: "DOMAIN_VALIDATION_FAILED",
    });
    expect(executions).toBe(0);
    expect(envTouches).toBe(0);
  });

  it.each([
    "",
    " ",
    "agent id",
    "agent\nname",
    "-agent",
    "agent-",
    "agent/name",
    "__proto__",
    "prototype",
    "constructor",
  ])("rejects unsafe agent id %j at every public Core mutation entry without effects", async (agentId) => {
    const configPath = t.path("home", ".cellarer", "config.json");
    const beforeConfig = await t.env.fs.readFile(configPath);
    const beforeRevision = await readStoreRevision(t.env, storeRoot);
    const beforeReceipts = await listOperationReceipts(t.env, storeRoot);
    const beforeStore = await t.env.fs.snapshotTreeNoFollow(storeRoot);
    const calls = [
      () =>
        mutateBuiltinAgent(t.env, {
          storeRoot,
          agentId,
          action: "disable",
          dryRun: true,
        }),
      () =>
        mutateBuiltinAgent(t.env, {
          storeRoot,
          agentId,
          action: "disable",
        }),
      () =>
        mutateCustomAdapter(t.env, {
          storeRoot,
          agentId,
          action: "add",
          adapter: { rules: { global: "~/.unsafe/RULES.md" } },
          dryRun: true,
        }),
      () =>
        mutateCustomAdapter(t.env, {
          storeRoot,
          agentId,
          action: "add",
          adapter: { rules: { global: "~/.unsafe/RULES.md" } },
        }),
      () =>
        mutateAgentAdapter(t.env, {
          storeRoot,
          agentId,
          kind: "custom",
          adapter: { rules: { global: "~/.unsafe/RULES.md" } },
          dryRun: true,
        }),
      () =>
        mutateAgentAdapter(t.env, {
          storeRoot,
          agentId,
          kind: "custom",
          adapter: { rules: { global: "~/.unsafe/RULES.md" } },
        }),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        name: "ControlPlaneValidationError",
        code: "DOMAIN_VALIDATION_FAILED",
        details: { agentId },
      });
      await expect(t.env.fs.readFile(configPath)).resolves.toBe(beforeConfig);
      await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(beforeRevision);
      await expect(listOperationReceipts(t.env, storeRoot)).resolves.toEqual(beforeReceipts);
      await expect(t.env.fs.snapshotTreeNoFollow(storeRoot)).resolves.toEqual(beforeStore);
      await expect(
        t.env.fs.lstat(t.path("home", ".cellarer", "operations", "active.json")),
      ).rejects.toThrow();
      await expect(loadConfig(t.env, storeRoot)).resolves.toBeDefined();
    }
  });

  it("rejects a built-in configure Proxy before changed-field inspection or effects", async () => {
    let traps = 0;
    const adapter = new Proxy(
      { displayName: "Unsafe" },
      {
        ownKeys() {
          traps += 1;
          return ["displayName"];
        },
      },
    );
    const beforeStore = await t.env.fs.snapshotTreeNoFollow(storeRoot);

    await expect(
      mutateBuiltinAgent(t.env, {
        storeRoot,
        agentId: "codex",
        action: "configure",
        adapter,
        dryRun: true,
      }),
    ).rejects.toMatchObject({
      code: "DOMAIN_VALIDATION_FAILED",
      details: { reason: "INVALID_ADAPTER_PATCH" },
    });

    expect(traps).toBe(0);
    await expect(t.env.fs.snapshotTreeNoFollow(storeRoot)).resolves.toEqual(beforeStore);
    await expect(loadConfig(t.env, storeRoot)).resolves.toBeDefined();
  });

  it.each([
    [
      "built-in adapter options Proxy",
      (dryRun: boolean) => {
        let executions = 0;
        const adapter = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(adapter, "displayName", {
          enumerable: true,
          get() {
            executions += 1;
            return "Unsafe";
          },
        });
        const options = new Proxy(
          { storeRoot, agentId: "codex", action: "configure", adapter, dryRun },
          {
            get(target, key, receiver) {
              executions += 1;
              return Reflect.get(target, key, receiver);
            },
          },
        );
        return {
          call: (env: typeof t.env) => mutateBuiltinAgent(env, options),
          executions: () => executions,
        };
      },
    ],
    [
      "custom adapter accessor",
      (dryRun: boolean) => {
        let executions = 0;
        const adapter = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(adapter, "rules", {
          enumerable: true,
          get() {
            executions += 1;
            return { global: "~/.unsafe/RULES.md" };
          },
        });
        return {
          call: (env: typeof t.env) =>
            mutateCustomAdapter(env, {
              storeRoot,
              agentId: "unsafe-custom",
              action: "add",
              adapter: adapter as never,
              dryRun,
            }),
          executions: () => executions,
        };
      },
    ],
    [
      "agent adapter Proxy",
      (dryRun: boolean) => {
        let executions = 0;
        const adapter = new Proxy(
          { displayName: "Unsafe" },
          {
            ownKeys(target) {
              executions += 1;
              return Reflect.ownKeys(target);
            },
          },
        );
        return {
          call: (env: typeof t.env) =>
            mutateAgentAdapter(env, {
              storeRoot,
              agentId: "codex",
              kind: "builtin",
              adapter,
              dryRun,
            }),
          executions: () => executions,
        };
      },
    ],
    [
      "settings reset fields Proxy",
      (dryRun: boolean) => {
        let executions = 0;
        const fields = new Proxy(["method"], {
          ownKeys(target) {
            executions += 1;
            return Reflect.ownKeys(target);
          },
        });
        return {
          call: (env: typeof t.env) =>
            mutateControlPlaneSettings(env, {
              storeRoot,
              action: "reset",
              fields: fields as never,
              dryRun,
            }),
          executions: () => executions,
        };
      },
    ],
    [
      "collection resourceIds accessor",
      (dryRun: boolean) => {
        let executions = 0;
        const resourceIds: unknown[] = ["rules/style"];
        Object.defineProperty(resourceIds, "0", {
          enumerable: true,
          get() {
            executions += 1;
            return "rules/style";
          },
        });
        return {
          call: (env: typeof t.env) =>
            mutateCollection(env, {
              storeRoot,
              action: "create",
              collectionName: "unsafe-members",
              resourceIds: resourceIds as never,
              dryRun,
            }),
          executions: () => executions,
        };
      },
    ],
    [
      "collectionNames Proxy",
      (dryRun: boolean) => {
        let executions = 0;
        const collectionNames = new Proxy(["default"], {
          ownKeys(target) {
            executions += 1;
            return Reflect.ownKeys(target);
          },
        });
        return {
          call: (env: typeof t.env) =>
            mutateCollection(env, {
              storeRoot,
              action: "set-defaults",
              collectionNames,
              dryRun,
            }),
          executions: () => executions,
        };
      },
    ],
  ])("preflights hostile %s before every Env touch on dry-run and apply", async (_label, create) => {
    for (const dryRun of [true, false]) {
      let envTouches = 0;
      const env = new Proxy(t.env, {
        get(target, key, receiver) {
          envTouches += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      const hostile = create(dryRun);

      await expect(hostile.call(env)).rejects.toMatchObject({
        name: "ControlPlaneValidationError",
        code: "DOMAIN_VALIDATION_FAILED",
      });
      expect(hostile.executions()).toBe(0);
      expect(envTouches).toBe(0);
    }
  });

  it.each([
    [
      "built-in agent",
      (env: typeof t.env, dryRun: boolean) =>
        mutateBuiltinAgent(env, {
          storeRoot,
          agentId: "codex",
          action: "disable",
          dryRun,
          unknown: true,
        } as never),
    ],
    [
      "custom adapter",
      (env: typeof t.env, dryRun: boolean) =>
        mutateCustomAdapter(env, {
          storeRoot,
          agentId: "strict-custom",
          action: "add",
          adapter: { rules: { global: "~/.strict/RULES.md" } },
          dryRun,
          unknown: true,
        } as never),
    ],
    [
      "agent adapter",
      (env: typeof t.env, dryRun: boolean) =>
        mutateAgentAdapter(env, {
          storeRoot,
          agentId: "codex",
          kind: "builtin",
          adapter: { displayName: "Strict" },
          dryRun,
          unknown: true,
        } as never),
    ],
    [
      "settings",
      (env: typeof t.env, dryRun: boolean) =>
        mutateControlPlaneSettings(env, {
          storeRoot,
          action: "update",
          settings: { method: "copy" },
          dryRun,
          unknown: true,
        } as never),
    ],
    [
      "collection",
      (env: typeof t.env, dryRun: boolean) =>
        mutateCollection(env, {
          storeRoot,
          action: "create",
          collectionName: "strict-collection",
          resourceIds: [],
          dryRun,
          unknown: true,
        } as never),
    ],
  ])("rejects unknown %s mutation options before every Env touch", async (_label, call) => {
    for (const dryRun of [true, false]) {
      let envTouches = 0;
      const env = new Proxy(t.env, {
        get(target, key, receiver) {
          envTouches += 1;
          return Reflect.get(target, key, receiver);
        },
      });

      await expect(call(env, dryRun)).rejects.toMatchObject({
        name: "ControlPlaneValidationError",
        code: "DOMAIN_VALIDATION_FAILED",
      });
      expect(envTouches).toBe(0);
    }
  });

  it("rejects an authorized serialized plan with invalid derived config before mutation state", async () => {
    const planned = await mutateBuiltinAgent(t.env, {
      storeRoot,
      agentId: "codex",
      action: "disable",
      dryRun: true,
    });
    const configPath = t.path("home", ".cellarer", "config.json");
    const beforeConfig = await t.env.fs.readFile(configPath);
    const beforeRevision = await readStoreRevision(t.env, storeRoot);
    const beforeReceipts = await listOperationReceipts(t.env, storeRoot);
    const beforeStore = await t.env.fs.snapshotTreeNoFollow(storeRoot);
    const action = planned.plan.actions[0];
    const precondition = planned.plan.targetPreconditions[0];
    if (!action || !precondition) throw new Error("expected one config publication action");
    const invalidData = `${JSON.stringify({ ...(await loadConfig(t.env, storeRoot)), customAdapters: { "": { rules: { global: "RULES.md" } } } }, null, 2)}\n`;
    const digest = sha256(invalidData);
    const mode = 0o600;
    const mutationKind = "builtin-agent-disable";
    const actionId = sha256(
      JSON.stringify({
        mutationKind,
        index: 0,
        kind: "publish-file",
        path: action.target,
        digest,
        mode,
        currentUserOnly: false,
      }),
    );
    const { authorization: _authorization, digest: _planDigest, ...unsigned } = planned.plan;
    const forged = createAuthorizedMutationPlan(t.env, storeRoot, {
      ...unsigned,
      targetPreconditions: [{ ...precondition, actionId }],
      actions: [
        {
          ...action,
          actionId,
          payload: { path: action.target, data: invalidData, digest, mode },
          postcondition: { state: "present", fingerprint: digest },
        },
      ],
    });
    let mutationLockWrites = 0;
    const baseWriteFileExclusive = t.env.fs.writeFileExclusive;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        async writeFileExclusive(...args: Parameters<typeof baseWriteFileExclusive>) {
          if (args[0].endsWith("mutation.lock")) mutationLockWrites += 1;
          return baseWriteFileExclusive(...args);
        },
      },
    };

    await expect(applyControlPlaneMutationPlan(env, forged, { storeRoot })).rejects.toEqual(
      expect.objectContaining<Partial<ControlPlaneValidationError>>({
        name: "ControlPlaneValidationError",
        code: "DOMAIN_VALIDATION_FAILED",
        details: { reason: "INVALID_CONFIG_PUBLICATION" },
      }),
    );
    expect(mutationLockWrites).toBe(0);
    await expect(t.env.fs.readFile(configPath)).resolves.toBe(beforeConfig);
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(beforeRevision);
    await expect(listOperationReceipts(t.env, storeRoot)).resolves.toEqual(beforeReceipts);
    await expect(t.env.fs.snapshotTreeNoFollow(storeRoot)).resolves.toEqual(beforeStore);
    await expect(
      t.env.fs.lstat(t.path("home", ".cellarer", "operations", "active.json")),
    ).rejects.toThrow();
    await expect(loadConfig(t.env, storeRoot)).resolves.toBeDefined();
  });

  it("rejects serialized control-plane provenance drift before recovery, revision, journal, or mutation lock access", async () => {
    const planned = await mutateBuiltinAgent(t.env, {
      storeRoot,
      agentId: "codex",
      action: "disable",
      dryRun: true,
    });
    const configPath = t.path("home", ".cellarer", "config.json");
    const config = await loadConfig(t.env, storeRoot);
    await t.env.fs.publishFileAtomically(
      configPath,
      `${JSON.stringify({ ...config, adapterOverrides: { codex: { enabled: true } } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const counts = { recovery: 0, revision: 0, journal: 0, lock: 0 };
    const baseFs = t.env.fs;
    const env = {
      ...t.env,
      fs: {
        ...baseFs,
        async readFile(path: string) {
          if (path.endsWith("recovery.lock")) counts.recovery += 1;
          if (path.endsWith("revision.json")) counts.revision += 1;
          if (path.endsWith("operations/active.json")) counts.journal += 1;
          return baseFs.readFile(path);
        },
        async writeFileExclusive(path: string, data: string, opts?: { mode?: number }) {
          if (path.endsWith("mutation.lock")) counts.lock += 1;
          return baseFs.writeFileExclusive(path, data, opts);
        },
      },
    };

    const applied = await applyControlPlaneMutationPlan(env, planned.plan, { storeRoot });

    expect(applied.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    expect(counts).toEqual({ recovery: 0, revision: 0, journal: 0, lock: 0 });
  });

  it("rejects ledger provenance drift under the lock without a revision change", async () => {
    await mutateCustomAdapter(t.env, {
      storeRoot,
      agentId: "unused-agent",
      action: "add",
      adapter: { rules: { global: "~/.unused/RULES.md" } },
    });
    await mutateBuiltinAgent(t.env, {
      storeRoot,
      agentId: "unused-agent",
      action: "disable",
    });
    const planned = await mutateCustomAdapter(t.env, {
      storeRoot,
      agentId: "unused-agent",
      action: "remove",
      dryRun: true,
    });
    const beforeConfig = await loadConfig(t.env, storeRoot);
    const beforeRevision = await readStoreRevision(t.env, storeRoot);
    const originalWriteFileExclusive = t.env.fs.writeFileExclusive;
    let injected = false;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        writeFileExclusive: async (...args: Parameters<typeof originalWriteFileExclusive>) => {
          const acquired = await originalWriteFileExclusive(...args);
          if (acquired && !injected && args[0].endsWith("mutation.lock")) {
            injected = true;
            await saveLedger(t.env, storeRoot, {
              version: 2,
              owners: [
                {
                  agent: "unused-agent",
                  scope: "global",
                  capability: "rules",
                  target: t.path("targets", "RULES.md"),
                  artifactIds: ["rules/style"],
                  receipt: {
                    method: "write",
                    fingerprint: "sha256:owned",
                    backup: null,
                    generated: true,
                    appliedAt: FIXED_NOW.toISOString(),
                  },
                },
              ],
            });
          }
          return acquired;
        },
      },
    };

    const applied = await applyControlPlaneMutationPlan(env, planned.plan, { storeRoot });

    expect(applied.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    await expect(loadConfig(t.env, storeRoot)).resolves.toEqual(beforeConfig);
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(beforeRevision);
  });

  it("rejects artifact membership provenance drift under the lock", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    const planned = await mutateCollection(t.env, {
      storeRoot,
      action: "create",
      collectionName: "work",
      resourceIds: ["rules/style"],
      dryRun: true,
    });
    const beforeConfig = await loadConfig(t.env, storeRoot);
    const originalWriteFileExclusive = t.env.fs.writeFileExclusive;
    let injected = false;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        writeFileExclusive: async (...args: Parameters<typeof originalWriteFileExclusive>) => {
          const acquired = await originalWriteFileExclusive(...args);
          if (acquired && !injected && args[0].endsWith("mutation.lock")) {
            injected = true;
            await writeRuleArtifact(t.env, storeRoot, "late", "# late");
          }
          return acquired;
        },
      },
    };

    const applied = await applyControlPlaneMutationPlan(env, planned.plan, { storeRoot });

    expect(applied.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    await expect(loadConfig(t.env, storeRoot)).resolves.toEqual(beforeConfig);
  });

  it.each([
    ["config.json", "config"],
    ["state.json", "ledger"],
    ["store", "resource-ancestor"],
    ["store/rules", "rules"],
    ["store/mcp", "mcp"],
    ["store/skills", "skills"],
  ] as const)("rejects no-follow %s provenance without reading or writing outside", async (relative, kind) => {
    const provenancePath = t.path("home", ".cellarer", ...relative.split("/"));
    const outside = t.path("outside", kind);
    await t.env.fs.mkdir(t.path("outside"), { recursive: true });
    const stat = await t.env.fs.lstat(provenancePath).catch(() => null);
    const isDirectory = stat?.isDirectory() === true;
    if (isDirectory) {
      await t.env.fs.rm(provenancePath, { recursive: true });
      await t.env.fs.mkdir(outside, { recursive: true });
      await t.env.fs.writeFile(t.path("outside", kind, "sentinel.txt"), "outside-unchanged");
      await t.env.fs.symlink(outside, provenancePath, "dir");
    } else {
      if (stat) await t.env.fs.rm(provenancePath);
      await t.env.fs.writeFile(outside, "outside-unchanged");
      await t.env.fs.symlink(outside, provenancePath, "file");
    }
    let outsideReads = 0;
    const readFile = t.env.fs.readFile;
    const readFileBytes = t.env.fs.readFileBytes;
    const snapshotFileNoFollow = t.env.fs.snapshotFileNoFollow;
    const snapshotTreeNoFollow = t.env.fs.snapshotTreeNoFollow;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        async readFile(path: string) {
          if (path.startsWith(outside) || path === provenancePath) outsideReads += 1;
          return readFile(path);
        },
        async readFileBytes(path: string) {
          if (path.startsWith(outside) || path === provenancePath) outsideReads += 1;
          return readFileBytes(path);
        },
        async snapshotFileNoFollow(path: string) {
          if (path.startsWith(outside)) outsideReads += 1;
          return snapshotFileNoFollow(path);
        },
        async snapshotTreeNoFollow(path: string) {
          if (path.startsWith(outside)) outsideReads += 1;
          return snapshotTreeNoFollow(path);
        },
      },
    };

    const mutation =
      kind === "config"
        ? mutateBuiltinAgent(env, {
            storeRoot,
            agentId: "codex",
            action: "disable",
            dryRun: true,
          })
        : kind === "ledger"
          ? mutateCustomAdapter(env, {
              storeRoot,
              agentId: "missing",
              action: "remove",
              dryRun: true,
            })
          : mutateCollection(env, {
              storeRoot,
              action: "create",
              collectionName: "safe",
              resourceIds: [],
              dryRun: true,
            });

    await expect(mutation).rejects.toThrow(/symlink|unsafe|provenance|snapshot/i);
    expect(outsideReads).toBe(0);
    const sentinel = isDirectory ? t.path("outside", kind, "sentinel.txt") : outside;
    await expect(t.env.fs.readFile(sentinel)).resolves.toBe("outside-unchanged");
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(listOperationReceipts(t.env, storeRoot)).resolves.toEqual([]);
  });

  it.each([
    "darwin",
    "linux",
    "win32",
  ] as const)("rejects a %s Store-root symlink before config provenance reads", async (platform) => {
    const outsideStore = t.path(`outside-store-${platform}`);
    await t.env.fs.rename(storeRoot, outsideStore);
    await t.env.fs.symlink(outsideStore, storeRoot, "dir");
    let outsideReads = 0;
    const readFile = t.env.fs.readFile;
    const env = {
      ...t.env,
      platform,
      fs: {
        ...t.env.fs,
        async readFile(path: string) {
          if (path.startsWith(outsideStore) || path.startsWith(storeRoot)) outsideReads += 1;
          return readFile(path);
        },
      },
    };

    await expect(
      mutateBuiltinAgent(env, {
        storeRoot,
        agentId: "codex",
        action: "disable",
        dryRun: true,
      }),
    ).rejects.toThrow(/root|symlink|provenance/i);
    expect(outsideReads).toBe(0);
    await expect(
      t.env.fs.readFile(t.path(`outside-store-${platform}`, "config.json")),
    ).resolves.toContain('"version": 1');
  });

  it("rejects adapter enable/config provenance drift without a revision change", async () => {
    const planned = await mutateBuiltinAgent(t.env, {
      storeRoot,
      agentId: "codex",
      action: "disable",
      dryRun: true,
    });
    const configPath = t.path("home", ".cellarer", "config.json");
    const originalWriteFileExclusive = t.env.fs.writeFileExclusive;
    let injected = false;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        writeFileExclusive: async (...args: Parameters<typeof originalWriteFileExclusive>) => {
          const acquired = await originalWriteFileExclusive(...args);
          if (acquired && !injected && args[0].endsWith("mutation.lock")) {
            injected = true;
            const config = await loadConfig(t.env, storeRoot);
            await t.env.fs.publishFileAtomically(
              configPath,
              `${JSON.stringify(
                { ...config, adapterOverrides: { codex: { enabled: true } } },
                null,
                2,
              )}\n`,
              { mode: 0o600 },
            );
          }
          return acquired;
        },
      },
    };

    const applied = await applyControlPlaneMutationPlan(env, planned.plan, { storeRoot });

    expect(applied.operation).toMatchObject({
      ok: false,
      conflict: { code: expect.stringMatching(/INVALID_PLAN|TARGET_PRECONDITION_CONFLICT/) },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(listOperationReceipts(t.env, storeRoot)).resolves.toEqual([]);
  });

  it("publishes reference-only safe bytes and rejects a known plaintext secret", async () => {
    const reference = "$" + "{KNOWN_CONTROL_PLANE_SECRET}";
    const referenceEnv = { ...t.env, env: { KNOWN_CONTROL_PLANE_SECRET: "known-value-123" } };
    const planned = await mutateBuiltinAgent(referenceEnv, {
      storeRoot,
      agentId: "codex",
      action: "configure",
      adapter: { displayName: reference },
      dryRun: true,
    });
    expect(JSON.stringify(planned.plan)).toContain(reference);
    expect(JSON.stringify(planned.plan)).not.toContain("known-value-123");

    await expect(
      mutateBuiltinAgent(referenceEnv, {
        storeRoot,
        agentId: "codex",
        action: "configure",
        adapter: { displayName: "known-value-123" },
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: "FINAL_SECRET_BYTE_GUARD" });
  });

  it("rejects stale, unknown-operation/action, and authorized extra-payload plans", async () => {
    const stale = await mutateControlPlaneSettings(t.env, {
      storeRoot,
      action: "update",
      settings: { method: "copy" },
      dryRun: true,
    });
    await mutateBuiltinAgent(t.env, {
      storeRoot,
      agentId: "codex",
      action: "disable",
    });
    expect(
      (await applyControlPlaneMutationPlan(t.env, stale.plan, { storeRoot })).operation,
    ).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });

    const fresh = await mutateControlPlaneSettings(t.env, {
      storeRoot,
      action: "update",
      settings: { method: "copy" },
      dryRun: true,
    });
    const { authorization: _authorization, digest: _digest, ...input } = fresh.plan;
    const action = input.actions[0];
    if (!action) throw new Error("expected publication action");
    const extraPayload = createAuthorizedMutationPlan(t.env, storeRoot, {
      ...input,
      actions: [{ ...action, payload: { ...action.payload, extra: true } }],
    });
    expect(
      (await applyControlPlaneMutationPlan(t.env, extraPayload, { storeRoot })).operation,
    ).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });

    expect(
      (
        await applyControlPlaneMutationPlan(
          t.env,
          { ...fresh.plan, operation: "unknown" } as never,
          { storeRoot },
        )
      ).operation,
    ).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    expect(
      (
        await applyControlPlaneMutationPlan(
          t.env,
          { ...fresh.plan, actions: [{ ...action, kind: "unknown-action" }] },
          { storeRoot },
        )
      ).operation,
    ).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
  });

  it("upserts Web-facing adapter config through planned merge semantics", async () => {
    await mutateBuiltinAgent(t.env, {
      storeRoot,
      agentId: "codex",
      action: "disable",
    });

    const configured = await mutateAgentAdapter(t.env, {
      storeRoot,
      agentId: "codex",
      kind: "builtin",
      adapter: { displayName: "Codex Web" },
    });
    expect(configured).toMatchObject({
      changedFields: ["adapterOverrides.codex.displayName"],
      plan: { normalizedInputs: { mutationKind: "builtin-agent-configure" } },
      receipt: { outcome: "committed", resultingRevision: 2 },
    });
    expect((await loadConfig(t.env, storeRoot)).adapterOverrides.codex).toEqual({
      enabled: false,
      displayName: "Codex Web",
    });

    const customDryRun = await mutateAgentAdapter(t.env, {
      storeRoot,
      agentId: "web-agent",
      kind: "custom",
      adapter: { rules: { global: "~/.web-agent/RULES.md" } },
      dryRun: true,
    });
    expect(customDryRun).toMatchObject({
      changedFields: ["customAdapters.web-agent"],
      plan: {
        operation: "settings",
        baseRevision: 2,
        normalizedInputs: { mutationKind: "custom-adapter-upsert" },
      },
    });
    expect((await loadConfig(t.env, storeRoot)).customAdapters["web-agent"]).toBeUndefined();

    const tamperedKind = {
      ...customDryRun.plan,
      normalizedInputs: {
        ...customDryRun.plan.normalizedInputs,
        mutationKind: "builtin-agent-configure",
      },
    };
    expect(
      (await applyControlPlaneMutationPlan(t.env, tamperedKind, { storeRoot })).operation,
    ).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
  });

  it("rejects a resealed custom upsert plan relabeled as a built-in mutation", async () => {
    const planned = await mutateAgentAdapter(t.env, {
      storeRoot,
      agentId: "web-agent",
      kind: "custom",
      adapter: { rules: { global: "~/.web-agent/RULES.md" } },
      dryRun: true,
    });
    const beforeConfig = await loadConfig(t.env, storeRoot);
    const beforeRevision = await readStoreRevision(t.env, storeRoot);
    const beforeReceipts = await listOperationReceipts(t.env, storeRoot);
    const beforeStore = await t.env.fs.snapshotTreeNoFollow(storeRoot);
    const forged = resealConfigPublicationPlan(t, storeRoot, planned.plan, {
      mutationKind: "builtin-agent-configure",
      changedFields: ["adapterOverrides.codex.displayName"],
    });

    const applied = await applyControlPlaneMutationPlan(t.env, forged, { storeRoot });

    expect(applied.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    await expect(loadConfig(t.env, storeRoot)).resolves.toEqual(beforeConfig);
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(beforeRevision);
    await expect(listOperationReceipts(t.env, storeRoot)).resolves.toEqual(beforeReceipts);
    await expect(t.env.fs.snapshotTreeNoFollow(storeRoot)).resolves.toEqual(beforeStore);
  });

  it("rejects a resealed remove plan whose publication deletes another enabled adapter", async () => {
    await mutateCustomAdapter(t.env, {
      storeRoot,
      agentId: "unused-agent",
      action: "add",
      adapter: { rules: { global: "~/.unused/RULES.md" } },
    });
    await mutateBuiltinAgent(t.env, {
      storeRoot,
      agentId: "unused-agent",
      action: "disable",
    });
    await mutateCustomAdapter(t.env, {
      storeRoot,
      agentId: "victim-agent",
      action: "add",
      adapter: { rules: { global: "~/.victim/RULES.md" } },
    });
    const planned = await mutateCustomAdapter(t.env, {
      storeRoot,
      agentId: "unused-agent",
      action: "remove",
      dryRun: true,
    });
    const beforeConfig = await loadConfig(t.env, storeRoot);
    const beforeRevision = await readStoreRevision(t.env, storeRoot);
    const beforeReceipts = await listOperationReceipts(t.env, storeRoot);
    const beforeStore = await t.env.fs.snapshotTreeNoFollow(storeRoot);
    const { "victim-agent": _removed, ...customAdapters } = beforeConfig.customAdapters;
    const forged = resealConfigPublicationPlan(t, storeRoot, planned.plan, {
      config: { ...beforeConfig, customAdapters },
      changedFields: ["customAdapters.victim-agent"],
      businessInput: {
        ...(planned.plan.normalizedInputs.businessInput as Record<string, unknown>),
        agentId: "victim-agent",
      },
    });

    const applied = await applyControlPlaneMutationPlan(t.env, forged, { storeRoot });

    expect(applied.operation).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    await expect(loadConfig(t.env, storeRoot)).resolves.toEqual(beforeConfig);
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(beforeRevision);
    await expect(listOperationReceipts(t.env, storeRoot)).resolves.toEqual(beforeReceipts);
    await expect(t.env.fs.snapshotTreeNoFollow(storeRoot)).resolves.toEqual(beforeStore);
  });

  // This real transaction must finish before fixture teardown; Vitest timeouts do not cancel it.
  it("rejects resealed business-input and publication tampering across every control-plane domain", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await mutateCollection(t.env, {
      storeRoot,
      action: "create",
      collectionName: "existing",
      resourceIds: [],
    });
    await mutateControlPlaneSettings(t.env, {
      storeRoot,
      action: "update",
      settings: { method: "copy" },
    });
    const agentPlan = await mutateCustomAdapter(t.env, {
      storeRoot,
      action: "add",
      agentId: "matrix-agent",
      adapter: { rules: { global: "~/.matrix/RULES.md" } },
      dryRun: true,
    });
    const settingsPlan = await mutateControlPlaneSettings(t.env, {
      storeRoot,
      action: "update",
      settings: { method: "symlink" },
      dryRun: true,
    });
    const resetPlan = await mutateControlPlaneSettings(t.env, {
      storeRoot,
      action: "reset",
      fields: ["method"],
      dryRun: true,
    });
    const collectionPlan = await mutateCollection(t.env, {
      storeRoot,
      action: "create",
      collectionName: "matrix",
      description: "Matrix",
      resourceIds: ["rules/style"],
      dryRun: true,
    });
    const defaultsPlan = await mutateCollection(t.env, {
      storeRoot,
      action: "set-defaults",
      collectionNames: ["existing"],
      dryRun: true,
    });
    const config = await loadConfig(t.env, storeRoot);
    const withExtraDelta = {
      ...config,
      defaults: { ...config.defaults, method: "symlink" as const },
      customAdapters: {
        ...config.customAdapters,
        "matrix-agent": { rules: { global: "~/.matrix/RULES.md" } },
      },
    };
    const agentInput = agentPlan.plan.normalizedInputs.businessInput as Record<string, unknown>;
    const settingsInput = settingsPlan.plan.normalizedInputs.businessInput as Record<
      string,
      unknown
    >;
    const resetInput = resetPlan.plan.normalizedInputs.businessInput as Record<string, unknown>;
    const collectionInput = collectionPlan.plan.normalizedInputs.businessInput as Record<
      string,
      unknown
    >;
    const defaultsInput = defaultsPlan.plan.normalizedInputs.businessInput as Record<
      string,
      unknown
    >;
    const cases: readonly [string, MutationPlan][] = [
      [
        "agent id",
        resealConfigPublicationPlan(t, storeRoot, agentPlan.plan, {
          businessInput: { ...agentInput, agentId: "other-agent" },
        }),
      ],
      [
        "agent action",
        resealConfigPublicationPlan(t, storeRoot, agentPlan.plan, {
          mutationKind: "custom-adapter-update",
          businessInput: { ...agentInput, action: "update" },
        }),
      ],
      [
        "adapter body",
        resealConfigPublicationPlan(t, storeRoot, agentPlan.plan, {
          businessInput: {
            ...agentInput,
            adapter: { displayName: "Tampered", rules: { global: "~/.matrix/RULES.md" } },
          },
        }),
      ],
      [
        "settings value",
        resealConfigPublicationPlan(t, storeRoot, settingsPlan.plan, {
          businessInput: { ...settingsInput, settings: { secretMode: "env" } },
          changedFields: ["defaults.secretMode"],
        }),
      ],
      [
        "settings reset fields",
        resealConfigPublicationPlan(t, storeRoot, resetPlan.plan, {
          businessInput: { ...resetInput, fields: ["secretMode"] },
          changedFields: ["defaults.secretMode"],
        }),
      ],
      [
        "settings capability snapshot",
        resealConfigPublicationPlan(t, storeRoot, resetPlan.plan, {
          businessInput: {
            ...resetInput,
            capabilitySnapshot: {
              packagedDefaults: { method: "copy", secretMode: "env" },
            },
          },
        }),
      ],
      [
        "collection name",
        resealConfigPublicationPlan(t, storeRoot, collectionPlan.plan, {
          businessInput: { ...collectionInput, collectionName: "other-matrix" },
          changedFields: ["collections.other-matrix", "collections.other-matrix.members"],
        }),
      ],
      [
        "collection membership",
        resealConfigPublicationPlan(t, storeRoot, collectionPlan.plan, {
          businessInput: { ...collectionInput, resourceIds: [] },
        }),
      ],
      [
        "collection defaults",
        resealConfigPublicationPlan(t, storeRoot, defaultsPlan.plan, {
          businessInput: { ...defaultsInput, collectionNames: ["default"] },
        }),
      ],
      [
        "changed fields",
        resealConfigPublicationPlan(t, storeRoot, agentPlan.plan, {
          changedFields: ["customAdapters.someone-else"],
        }),
      ],
      [
        "extra publication delta",
        resealConfigPublicationPlan(t, storeRoot, agentPlan.plan, { config: withExtraDelta }),
      ],
    ];

    for (const [label, forged] of cases) {
      await assertInvalidControlPlanePlanHasNoEffects(t, storeRoot, forged, label);
    }
  }, 30_000);

  it.each([
    {},
    { displayName: "Incomplete" },
  ])("rejects an explicit custom adapter definition %j before every Env touch", async (adapter) => {
    let envTouches = 0;
    const env = new Proxy(t.env, {
      get(target, key, receiver) {
        envTouches += 1;
        return Reflect.get(target, key, receiver);
      },
    });

    await expect(
      mutateAgentAdapter(env, {
        storeRoot,
        agentId: "incomplete-custom",
        kind: "custom",
        adapter,
        dryRun: true,
      } as never),
    ).rejects.toMatchObject({
      code: "DOMAIN_VALIDATION_FAILED",
      details: { agentId: "incomplete-custom", reason: "INVALID_ADAPTER_DEFINITION" },
    });
    expect(envTouches).toBe(0);
  });

  it("requires an explicit adapter kind before every Env touch", async () => {
    let envTouches = 0;
    const env = new Proxy(t.env, {
      get(target, key, receiver) {
        envTouches += 1;
        return Reflect.get(target, key, receiver);
      },
    });

    await expect(
      mutateAgentAdapter(env, {
        storeRoot,
        agentId: "web-agent",
        adapter: { rules: { global: "~/.web-agent/RULES.md" } },
        dryRun: true,
      } as never),
    ).rejects.toMatchObject({
      code: "DOMAIN_VALIDATION_FAILED",
      details: { reason: "INVALID_ADAPTER_MUTATION" },
    });
    expect(envTouches).toBe(0);
  });

  it.each([
    [
      "accessor",
      () => {
        let traps = 0;
        const body = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(body, "enabled", {
          enumerable: true,
          get() {
            traps += 1;
            return false;
          },
        });
        return { body, traps: () => traps };
      },
    ],
    [
      "Proxy",
      () => {
        let traps = 0;
        const body = new Proxy(
          { enabled: false },
          {
            ownKeys(target) {
              traps += 1;
              return Reflect.ownKeys(target);
            },
            get(target, key, receiver) {
              traps += 1;
              return Reflect.get(target, key, receiver);
            },
          },
        );
        return { body, traps: () => traps };
      },
    ],
    [
      "toJSON",
      () => ({ body: { enabled: false, toJSON: () => ({ enabled: true }) }, traps: () => 0 }),
    ],
    [
      "custom prototype",
      () => ({
        body: Object.assign(Object.create({ inherited: true }), { enabled: false }),
        traps: () => 0,
      }),
    ],
    [
      "symbol key",
      () => ({ body: { enabled: false, [Symbol("unexpected")]: true }, traps: () => 0 }),
    ],
  ])("rejects a hostile enabled body %s without executing traps", (_label, create) => {
    const hostile = create();
    expect(() => parseAgentEnabledMutationBody(hostile.body)).toThrow(
      expect.objectContaining({
        name: "ControlPlaneValidationError",
        code: "DOMAIN_VALIDATION_FAILED",
      }),
    );
    expect(hostile.traps()).toBe(0);
  });

  it("adds and updates typed customAdapters and blocks removal with exact owned dependencies", async () => {
    await mutateCustomAdapter(t.env, {
      storeRoot,
      agentId: "my-agent",
      action: "add",
      adapter: {
        displayName: "My Agent",
        rules: { global: "~/.my-agent/RULES.md" },
      },
    });
    expect((await loadConfig(t.env, storeRoot)).customAdapters["my-agent"]).toMatchObject({
      displayName: "My Agent",
    });

    await mutateCustomAdapter(t.env, {
      storeRoot,
      agentId: "my-agent",
      action: "update",
      adapter: {
        displayName: "My Updated Agent",
        rules: { global: "~/.my-agent/RULES.md" },
      },
    });
    expect((await loadConfig(t.env, storeRoot)).customAdapters["my-agent"]?.displayName).toBe(
      "My Updated Agent",
    );

    await expect(
      mutateCustomAdapter(t.env, { storeRoot, agentId: "my-agent", action: "remove" }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_CONFLICT",
      dependencies: { ownedTargets: [], desiredSelections: ["agent:my-agent:enabled"] },
    });
    await mutateBuiltinAgent(t.env, {
      storeRoot,
      agentId: "my-agent",
      action: "disable",
    });

    const ownedTarget = t.path("targets", "RULES.md");
    await saveLedger(t.env, storeRoot, {
      version: 2,
      owners: [
        {
          agent: "my-agent",
          scope: "global",
          capability: "rules",
          target: ownedTarget,
          artifactIds: ["rules/style"],
          receipt: {
            method: "write",
            fingerprint: "sha256:owned",
            backup: null,
            generated: true,
            appliedAt: FIXED_NOW.toISOString(),
          },
        },
      ],
    });
    const before = await loadConfig(t.env, storeRoot);

    await expect(
      mutateCustomAdapter(t.env, {
        storeRoot,
        agentId: "my-agent",
        action: "remove",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ControlPlaneDependencyError>>({
        code: "DEPENDENCY_CONFLICT",
        dependencies: expect.objectContaining({
          ownedTargets: [ownedTarget],
        }),
      }),
    );
    await expect(loadConfig(t.env, storeRoot)).resolves.toEqual(before);
  });

  it("rejects a custom adapter id that collides with a built-in without effects", async () => {
    const configPath = t.path("home", ".cellarer", "config.json");
    const beforeConfig = await t.env.fs.readFile(configPath);
    const beforeRevision = await readStoreRevision(t.env, storeRoot);
    const beforeReceipts = await listOperationReceipts(t.env, storeRoot);
    const beforeStore = await t.env.fs.snapshotTreeNoFollow(storeRoot);

    for (const dryRun of [true, false]) {
      await expect(
        mutateCustomAdapter(t.env, {
          storeRoot,
          agentId: "codex",
          action: "add",
          adapter: { rules: { global: "~/.collision/RULES.md" } },
          dryRun,
        }),
      ).rejects.toMatchObject({
        name: "ControlPlaneValidationError",
        code: "DOMAIN_VALIDATION_FAILED",
        details: { agentId: "codex" },
      });
      await expect(t.env.fs.readFile(configPath)).resolves.toBe(beforeConfig);
      await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(beforeRevision);
      await expect(listOperationReceipts(t.env, storeRoot)).resolves.toEqual(beforeReceipts);
      await expect(t.env.fs.snapshotTreeNoFollow(storeRoot)).resolves.toEqual(beforeStore);
      await expect(loadConfig(t.env, storeRoot)).resolves.toBeDefined();
    }
  });

  it("removes a disabled dependency-free custom adapter and its override", async () => {
    await mutateCustomAdapter(t.env, {
      storeRoot,
      agentId: "unused-agent",
      action: "add",
      adapter: { rules: { global: "~/.unused/RULES.md" } },
    });
    await mutateBuiltinAgent(t.env, {
      storeRoot,
      agentId: "unused-agent",
      action: "disable",
    });

    const removed = await mutateCustomAdapter(t.env, {
      storeRoot,
      agentId: "unused-agent",
      action: "remove",
    });

    expect(removed.receipt?.changedFields).toEqual([
      "customAdapters.unused-agent",
      "adapterOverrides.unused-agent",
    ]);
    const config = await loadConfig(t.env, storeRoot);
    expect(config.customAdapters["unused-agent"]).toBeUndefined();
    expect(config.adapterOverrides["unused-agent"]).toBeUndefined();
  });

  it("updates and resets typed non-secret settings and rejects secret-shaped fields", async () => {
    const updated = await mutateControlPlaneSettings(t.env, {
      storeRoot,
      action: "update",
      settings: { method: "copy", secretMode: "env" },
    });
    expect(updated.changedFields).toEqual(["defaults.method", "defaults.secretMode"]);
    expect(updated.receipt).toMatchObject({ resultingRevision: 1 });
    expect((await loadConfig(t.env, storeRoot)).defaults).toMatchObject({
      method: "copy",
      secretMode: "env",
    });

    await mutateControlPlaneSettings(t.env, {
      storeRoot,
      action: "reset",
      fields: ["method"],
    });
    expect((await loadConfig(t.env, storeRoot)).defaults.method).toBe("symlink");

    const before = await loadConfig(t.env, storeRoot);
    await expect(
      mutateControlPlaneSettings(t.env, {
        storeRoot,
        action: "update",
        settings: { method: "copy", apiToken: "hunter2" } as never,
      }),
    ).rejects.toThrow(/apiToken|unrecognized/i);
    await expect(loadConfig(t.env, storeRoot)).resolves.toEqual(before);
  });

  it.each([
    ["unknown key", () => ({ patch: { method: "copy", unexpectedOption: true }, reads: () => 0 })],
    [
      "accessor",
      () => {
        let reads = 0;
        const patch = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(patch, "method", {
          enumerable: true,
          get() {
            reads += 1;
            return "copy";
          },
        });
        return { patch, reads: () => reads };
      },
    ],
    [
      "Proxy",
      () => {
        let traps = 0;
        const patch = new Proxy(
          { method: "copy" },
          {
            ownKeys() {
              traps += 1;
              return ["method"];
            },
            get() {
              traps += 1;
              return "copy";
            },
          },
        );
        return { patch, reads: () => traps };
      },
    ],
    [
      "toJSON",
      () => ({ patch: { method: "copy", toJSON: () => ({ method: "copy" }) }, reads: () => 0 }),
    ],
    [
      "custom prototype",
      () => ({
        patch: Object.assign(Object.create({ inherited: true }), { method: "copy" }),
        reads: () => 0,
      }),
    ],
    [
      "symbol key",
      () => ({ patch: { method: "copy", [Symbol("unexpected")]: true }, reads: () => 0 }),
    ],
    [
      "prototype-pollution-like key",
      () => {
        const patch = { method: "copy" } as Record<string, unknown>;
        Object.defineProperty(patch, "constructor", { enumerable: true, value: "unsafe" });
        return { patch, reads: () => 0 };
      },
    ],
  ])("rejects a runtime settings patch %s on dry-run and apply without effects", async (_label, create) => {
    for (const dryRun of [true, false]) {
      const hostile = create();
      const configPath = t.path("home", ".cellarer", "config.json");
      const beforeConfig = await t.env.fs.readFile(configPath);
      const beforeRevision = await readStoreRevision(t.env, storeRoot);
      const beforeReceipts = await listOperationReceipts(t.env, storeRoot);
      const beforeStore = await t.env.fs.snapshotTreeNoFollow(storeRoot);

      await expect(
        mutateControlPlaneSettings(t.env, {
          storeRoot,
          action: "update",
          settings: hostile.patch as never,
          dryRun,
        }),
      ).rejects.toMatchObject({
        name: "ControlPlaneValidationError",
        code: "DOMAIN_VALIDATION_FAILED",
        details: { reason: "INVALID_SETTINGS_PATCH" },
      });

      expect(hostile.reads()).toBe(0);
      await expect(t.env.fs.readFile(configPath)).resolves.toBe(beforeConfig);
      await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(beforeRevision);
      await expect(listOperationReceipts(t.env, storeRoot)).resolves.toEqual(beforeReceipts);
      await expect(t.env.fs.snapshotTreeNoFollow(storeRoot)).resolves.toEqual(beforeStore);
      await expect(loadConfig(t.env, storeRoot)).resolves.toBeDefined();
    }
  });

  // This real transaction must finish before fixture teardown; Vitest timeouts do not cancel it.
  it("plans and applies exact collection create, membership, update, and defaults mutations", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await writeRuleArtifact(t.env, storeRoot, "safety", "# safety");
    const before = await loadConfig(t.env, storeRoot);

    const dryRun = await mutateCollection(t.env, {
      storeRoot,
      action: "create",
      collectionName: "work",
      description: "Work resources",
      resourceIds: ["rules/style"],
      dryRun: true,
    });

    expect(dryRun).toMatchObject({
      plan: { operation: "settings", baseRevision: 0 },
      changedFields: ["collections.work", "collections.work.members"],
    });
    expect(dryRun.receipt).toBeUndefined();
    await expect(loadConfig(t.env, storeRoot)).resolves.toEqual(before);
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(listOperationReceipts(t.env, storeRoot)).resolves.toEqual([]);

    const created = await mutateCollection(t.env, {
      storeRoot,
      action: "create",
      collectionName: "work",
      description: "Work resources",
      resourceIds: ["rules/style"],
    });
    expect(created.receipt).toMatchObject({
      outcome: "committed",
      baseRevision: 0,
      resultingRevision: 1,
    });
    expect(await loadConfig(t.env, storeRoot)).toMatchObject({
      collections: { work: { description: "Work resources" } },
      artifacts: { "rules/style": { collections: ["work"] } },
    });

    await mutateCollection(t.env, {
      storeRoot,
      action: "set-members",
      collectionName: "work",
      resourceIds: ["rules/safety"],
    });
    await mutateCollection(t.env, {
      storeRoot,
      action: "update",
      collectionName: "work",
      description: "Updated",
    });
    await mutateCollection(t.env, {
      storeRoot,
      action: "set-defaults",
      collectionNames: ["work"],
    });

    expect(await loadConfig(t.env, storeRoot)).toMatchObject({
      defaults: { collections: ["work"] },
      collections: { work: { description: "Updated" } },
      artifacts: {
        "rules/style": { collections: [] },
        "rules/safety": { collections: ["work"] },
      },
    });
  }, 30_000);

  it("rejects unknown member IDs and blocks deletion selected by desired defaults", async () => {
    const beforeStore = await t.env.fs.snapshotTreeNoFollow(storeRoot);
    const beforeReceipts = await listOperationReceipts(t.env, storeRoot);
    await expect(
      mutateCollection(t.env, {
        storeRoot,
        action: "create",
        collectionName: "invalid",
        resourceIds: ["rules/missing"],
      }),
    ).rejects.toMatchObject({
      code: "DOMAIN_VALIDATION_FAILED",
      details: { resourceIds: ["rules/missing"] },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);

    await expect(
      mutateCollection(t.env, {
        storeRoot,
        action: "delete",
        collectionName: "default",
      }),
    ).rejects.toMatchObject({
      code: "DEPENDENCY_CONFLICT",
      details: {
        collectionName: "default",
        dependencies: { desiredSelections: ["defaults.collections:default"] },
      },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(t.env.fs.snapshotTreeNoFollow(storeRoot)).resolves.toEqual(beforeStore);
    await expect(listOperationReceipts(t.env, storeRoot)).resolves.toEqual(beforeReceipts);
  });

  it("deletes a collection and removes every artifact membership", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    await mutateCollection(t.env, {
      storeRoot,
      action: "create",
      collectionName: "work",
      resourceIds: ["rules/style"],
    });

    const deleted = await mutateCollection(t.env, {
      storeRoot,
      action: "delete",
      collectionName: "work",
    });

    expect(deleted).toMatchObject({
      plan: { operation: "settings" },
      changedFields: ["collections.work"],
      receipt: { outcome: "committed" },
    });
    expect(await loadConfig(t.env, storeRoot)).toMatchObject({
      collections: { default: expect.any(Object) },
      artifacts: { "rules/style": { collections: [] } },
    });
  });
});

function resealConfigPublicationPlan(
  t: TmpEnv,
  storeRoot: string,
  plan: MutationPlan,
  changes: {
    readonly mutationKind?: string;
    readonly changedFields?: readonly string[];
    readonly config?: unknown;
    readonly businessInput?: unknown;
  },
): MutationPlan {
  const action = plan.actions[0];
  const precondition = plan.targetPreconditions[0];
  if (!action || !precondition) throw new Error("expected one config publication action");
  const mutationKind = changes.mutationKind ?? String(plan.normalizedInputs.mutationKind);
  const data =
    changes.config === undefined
      ? String(action.payload.data)
      : `${JSON.stringify(changes.config, null, 2)}\n`;
  const digest = sha256(data);
  const mode = 0o600;
  const actionId = sha256(
    JSON.stringify({
      mutationKind,
      index: 0,
      kind: "publish-file",
      path: action.target,
      digest,
      mode,
      currentUserOnly: false,
    }),
  );
  const { authorization: _authorization, digest: _planDigest, ...unsigned } = plan;
  return createAuthorizedMutationPlan(t.env, storeRoot, {
    ...unsigned,
    normalizedInputs: {
      ...plan.normalizedInputs,
      mutationKind,
      changedFields: changes.changedFields ?? plan.normalizedInputs.changedFields,
      businessInput: changes.businessInput ?? plan.normalizedInputs.businessInput,
    },
    targetPreconditions: [{ ...precondition, actionId }],
    actions: [
      {
        ...action,
        actionId,
        payload: { path: action.target, data, digest, mode },
        postcondition: { state: "present", fingerprint: digest },
      },
    ],
  });
}

async function assertInvalidControlPlanePlanHasNoEffects(
  t: TmpEnv,
  storeRoot: string,
  plan: MutationPlan,
  label: string,
): Promise<void> {
  const configPath = t.path("home", ".cellarer", "config.json");
  const beforeConfig = await t.env.fs.readFile(configPath);
  const beforeRevision = await readStoreRevision(t.env, storeRoot);
  const beforeReceipts = await listOperationReceipts(t.env, storeRoot);

  const applied = await applyControlPlaneMutationPlan(t.env, plan, { storeRoot });

  expect(applied.operation, label).toMatchObject({
    ok: false,
    conflict: { code: "INVALID_PLAN" },
  });
  await expect(t.env.fs.readFile(configPath), label).resolves.toBe(beforeConfig);
  await expect(readStoreRevision(t.env, storeRoot), label).resolves.toBe(beforeRevision);
  await expect(listOperationReceipts(t.env, storeRoot), label).resolves.toEqual(beforeReceipts);
  await expect(
    t.env.fs.lstat(t.path("home", ".cellarer", "operations", "active.json")),
    label,
  ).rejects.toThrow();
}
