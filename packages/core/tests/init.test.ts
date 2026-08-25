import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import {
  initializeStore,
  loadRegistry,
  PACKAGED_CONFIG_PATH,
  parseConfig,
  refreshInventory,
} from "../src/index.js";
import { readOperationJournal } from "../src/protocol/journal.js";
import { acquireStoreMutationLock } from "../src/protocol/mutation-lock.js";
import { diagnoseMutationRecovery, recoverInterruptedOperation } from "../src/protocol/recovery.js";
import { readStoreRevision } from "../src/protocol/store-revision.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("store/initStore", () => {
  let t: TmpEnv;
  let storeRoot: string;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
  });
  afterEach(() => t.cleanup());

  it("creates store/rules + config.json", async () => {
    const r = await initStore(t.env, storeRoot);
    expect(r.createdConfig).toBe(true);
    expect(
      (await t.env.fs.lstat(t.path("home", ".cellarer", "store", "rules"))).isDirectory(),
    ).toBe(true);
    const json = await t.env.fs.readFile(t.path("home", ".cellarer", "config.json"));
    const cfg = parseConfig(json);
    expect(cfg.customAdapters).toEqual({});
    const reg = await loadRegistry(t.env, storeRoot);
    expect(reg.get("claude-code")).toBeDefined();
    expect(reg.get("codex")).toBeDefined();
  });

  it("the packaged config template parses cleanly against the schema (no drift)", async () => {
    expect(PACKAGED_CONFIG_PATH).not.toContain(t.env.cwd());
    const r = await initStore(t.env, storeRoot);
    expect(r.createdConfig).toBe(true);
    const cfg = parseConfig(await t.env.fs.readFile(t.path("home", ".cellarer", "config.json")));
    expect(cfg.defaults.method).toBe("symlink");
    expect(cfg.defaults.os?.win32?.method).toBe("copy");
  });

  it("is idempotent: does not overwrite an existing config.json", async () => {
    await initStore(t.env, storeRoot);
    await t.env.fs.writeFile(t.path("home", ".cellarer", "config.json"), '{ "version": 1 }\n');
    const r = await initStore(t.env, storeRoot);
    expect(r.createdConfig).toBe(false);
    expect(await t.env.fs.readFile(t.path("home", ".cellarer", "config.json"))).toBe(
      '{ "version": 1 }\n',
    );
  });

  it("the public initializer refuses to race an existing store mutation", async () => {
    await t.env.fs.mkdir(storeRoot, { recursive: true });
    const acquired = await acquireStoreMutationLock(t.env, storeRoot, {
      operationId: "operation-held",
      processId: 42,
      hostname: "test-host",
      acquiredAt: "2026-07-28T12:00:00.000Z",
    });
    if (!acquired.ok) throw new Error("expected mutation lock fixture");
    try {
      await expect(initializeStore(t.env, storeRoot)).rejects.toMatchObject({
        code: "LOCK_CONFLICT",
      });
      await expect(t.env.fs.lstat(t.path("home", ".cellarer", "config.json"))).rejects.toThrow();
      await expect(t.env.fs.lstat(t.path("home", ".cellarer", "store", "rules"))).rejects.toThrow();
    } finally {
      await acquired.lock.release();
    }
  });

  it("the public initializer commits a signed operation receipt and advances revision", async () => {
    const result = await initializeStore(t.env, storeRoot);

    expect(result).toMatchObject({
      createdConfig: true,
      operation: {
        ok: true,
        receipt: { operation: "initialize", baseRevision: 0, resultingRevision: 1 },
      },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
    expect((await t.env.fs.lstat(t.path("home", ".cellarer", "config.json"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("leaves activation preferences untouched before live Inventory refresh", async () => {
    await t.env.fs.mkdir(t.path("home", ".agents", "skills", "inventory-demo"), {
      recursive: true,
    });
    await t.env.fs.writeFile(
      t.path("home", ".agents", "skills", "inventory-demo", "SKILL.md"),
      "---\nname: inventory-demo\ndescription: init fixture\n---\n",
    );

    await initializeStore(t.env, storeRoot);
    const config = parseConfig(await t.env.fs.readFile(t.path("home", ".cellarer", "config.json")));
    const inventory = await refreshInventory(t.env, { storeRoot });

    expect(config.adapterOverrides).toEqual({});
    expect(inventory).toMatchObject({
      completeness: "complete",
      candidates: [
        expect.objectContaining({
          kind: "skills",
          name: "inventory-demo",
          state: "ready",
          defaultSelected: true,
        }),
      ],
    });
  });

  it("does not leave a truncated config when config publication fails with EIO", async () => {
    const configPath = t.path("home", ".cellarer", "config.json");
    const writeFile = t.env.fs.writeFile;
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    const failingEnv: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        writeFile: async (path, data, opts) => {
          if (path === configPath) {
            await writeFile(path, data.slice(0, 8), opts);
            const error = new Error("simulated partial config write") as Error & { code: string };
            error.code = "EIO";
            throw error;
          }
          return writeFile(path, data, opts);
        },
        publishFileAtomically: async (path, data, opts) => {
          if (path === configPath) {
            const error = new Error("simulated atomic publication failure") as Error & {
              code: string;
            };
            error.code = "EIO";
            throw error;
          }
          return publishFileAtomically(path, data, opts);
        },
      },
    };

    await expect(initializeStore(failingEnv, storeRoot)).rejects.toMatchObject({
      code: "PARTIAL_FAILURE",
    });
    await expect(t.env.fs.lstat(configPath)).rejects.toThrow();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      plan: { operation: "initialize" },
      status: "recovery-required",
      actions: [
        { status: "failed", receipt: { error: { code: "EIO" } } },
        { status: "pending" },
        { status: "pending" },
        { status: "pending" },
        { status: "pending" },
      ],
    });
    await expect(t.env.fs.lstat(t.path("home", ".cellarer", "store", "rules"))).rejects.toThrow();
  });

  it("does not commit or execute later layout actions when mkdir silently does nothing", async () => {
    const rulesDir = t.path("home", ".cellarer", "store", "rules");
    const mcpDir = t.path("home", ".cellarer", "store", "mcp");
    const mkdir = t.env.fs.mkdir;
    let laterActionExecuted = false;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        mkdir: async (path, opts) => {
          if (path === rulesDir) return;
          if (path === mcpDir) laterActionExecuted = true;
          await mkdir(path, opts);
        },
      },
    };

    await expect(initializeStore(env, storeRoot)).rejects.toMatchObject({
      code: "PARTIAL_FAILURE",
    });
    expect(laterActionExecuted).toBe(false);
    await expect(t.env.fs.lstat(rulesDir)).rejects.toThrow();
    await expect(t.env.fs.lstat(mcpDir)).rejects.toThrow();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "recovery-required",
      actions: [
        { status: "succeeded" },
        {
          status: "failed",
          receipt: { error: { code: "ACTION_POSTCONDITION_FAILED" } },
        },
        { status: "pending" },
        { status: "pending" },
        { status: "pending" },
      ],
    });
  });

  it("recovers a crashed initializer from matching dead-owner and journal evidence", async () => {
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    const rm = t.env.fs.rm;
    let revisionFailed = false;
    const crashingEnv: Env = {
      ...t.env,
      processId: () => 333,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path, data, opts) => {
          if (!revisionFailed && path.endsWith("revision.json")) {
            revisionFailed = true;
            const error = new Error("simulated crash before revision publication") as Error & {
              code: string;
            };
            error.code = "EIO";
            throw error;
          }
          return publishFileAtomically(path, data, opts);
        },
        rm: async (path, opts) => {
          if (path.endsWith("mutation.lock")) {
            throw new Error("simulated process death before lock cleanup");
          }
          return rm(path, opts);
        },
      },
    };

    await expect(initializeStore(crashingEnv, storeRoot)).rejects.toThrow();
    const journal = await readOperationJournal(t.env, storeRoot);
    expect(journal).toMatchObject({
      plan: { operation: "initialize" },
      status: "publishing-state",
    });
    const recoveryEnv: Env = {
      ...t.env,
      processId: () => 444,
      probeProcessLiveness: async (processId) => (processId === 333 ? "dead" : "alive"),
    };
    await expect(diagnoseMutationRecovery(recoveryEnv, storeRoot)).resolves.toMatchObject({
      status: "incomplete",
      journal: { operationId: journal?.operationId },
      lockOwner: { operationId: journal?.operationId, processId: 333 },
    });

    const recovered = await recoverInterruptedOperation(recoveryEnv, storeRoot, {
      operationId: journal?.operationId ?? "missing",
    });
    expect(recovered).toMatchObject({
      ok: true,
      receipt: { operation: "initialize", resultingRevision: 1, outcome: "committed" },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(1);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
  });
});
