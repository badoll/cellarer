import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activityPath } from "../src/activity.js";
import { apply, applyMutationPlan, planApplyMutation } from "../src/engine/apply.js";
import type { Env } from "../src/env.js";
import { readFileOrNull } from "../src/fs/probe.js";
import { operationReceiptPath, readOperationJournal } from "../src/protocol/journal.js";
import { recoverInterruptedOperation } from "../src/protocol/recovery.js";
import { observableKnownValues, serializeObservable } from "../src/secrets/observable.js";
import { loadConfig } from "../src/store/config.js";
import { initStore, writeMcpArtifact } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const CANARY = "ghp_0123456789abcdefghijklmnopqrstuvwx";
const ENV_REFERENCE = "${" + "CANARY_E2E}";

describe("reference-only secret canary end to end", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv({
      env: { CANARY_E2E: CANARY },
      randomId: () => "secret-canary",
    });
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });

  afterEach(() => t.cleanup());

  it("keeps a successful apply, receipt, state, and activity free of the canary", async () => {
    await seedReferencedMcp(t, storeRoot);

    const result = await apply(t.env, mcpOptions(storeRoot, ["claude-code"]));

    expect(result.mutation.result).toMatchObject({
      ok: true,
      receipt: { outcome: "committed" },
    });
    expect(result).not.toHaveProperty("operation");
    expect(JSON.stringify(result)).not.toContain(CANARY);
    const target = t.path("home", ".claude.json");
    await expect(t.env.fs.readFile(target)).resolves.toContain(ENV_REFERENCE);
    await expect(t.env.fs.readFile(target)).resolves.not.toContain(CANARY);
    await expect(t.env.fs.readFile(join(storeRoot, "state.json"))).resolves.not.toContain(CANARY);
    await expect(t.env.fs.readFile(activityPath(storeRoot))).resolves.not.toContain(CANARY);
    if (!result.mutation.result?.ok) throw new Error("expected a committed operation");
    await expect(
      t.env.fs.readFile(
        operationReceiptPath(storeRoot, result.mutation.result.receipt.operationId),
      ),
    ).resolves.not.toContain(CANARY);
  });

  it("blocks a staged canary before mutation without disclosing it", async () => {
    // Simulate legacy or externally introduced Store bytes; the supported writer itself must
    // reject these bytes before they reach the recursive apply guard exercised below.
    await t.env.fs.writeFile(
      join(storeRoot, "store", "mcp", "blocked.json"),
      `${JSON.stringify({ command: "npx", args: [CANARY] }, null, 2)}\n`,
    );

    const result = await apply(t.env, mcpOptions(storeRoot, ["claude-code"]));

    expect(result.entries).toEqual([]);
    expect(result.plan.secretFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifact: "mcp/blocked", rule: "github-pat" }),
      ]),
    );
    expect(JSON.stringify(result.plan.secretFindings)).not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain(CANARY);
    await expect(readFileOrNull(t.env, t.path("home", ".claude.json"))).resolves.toBeNull();
    await expect(readFileOrNull(t.env, join(storeRoot, "state.json"))).resolves.toBeNull();
    await expect(readFileOrNull(t.env, activityPath(storeRoot))).resolves.toBeNull();
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
  });

  it("redacts a thrown provider error at the observable error boundary", async () => {
    const readFile = t.env.fs.readFile;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        readFile: async (path) => {
          if (path === join(storeRoot, "config.json")) {
            throw new Error(`provider failed while handling ${CANARY}`);
          }
          return readFile(path);
        },
      },
    };
    let thrown: unknown;

    try {
      await planApplyMutation(env, mcpOptions(storeRoot, ["claude-code"]));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const observable = serializeObservable("error", thrown);
    expect(observable).not.toContain(CANARY);
    expect(observable).toContain("[REDACTED]");
  });

  it("keeps a partial-failure journal and explicit recovery free of the canary", async () => {
    await seedReferencedMcp(t, storeRoot);
    const options = mcpOptions(storeRoot, ["claude-code", "gemini-cli"]);
    const prepared = await planApplyMutation(t.env, options);
    const writeFile = t.env.fs.writeFile;
    const failingEnv: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        writeFile: async (path, data, options) => {
          if (path.startsWith(t.path("home", ".gemini", ".cellarer-tmp-"))) {
            const error = Object.assign(new Error(`write failed around ${CANARY}`), {
              code: "EACCES",
            });
            throw error;
          }
          await writeFile(path, data, options);
        },
      },
    };

    const failed = await applyMutationPlan(failingEnv, prepared.mutationPlan, {
      storeRoot,
      options,
    });

    expect(failed.operation).toMatchObject({
      ok: false,
      conflict: { code: "PARTIAL_FAILURE" },
      journal: { status: "recovery-required" },
    });
    expect(JSON.stringify(failed)).not.toContain(CANARY);
    await expect(
      t.env.fs.readFile(join(storeRoot, "operations", "active.json")),
    ).resolves.not.toContain(CANARY);
    if (failed.operation.ok || failed.operation.conflict.code !== "PARTIAL_FAILURE") {
      throw new Error("expected a partial-failure operation");
    }

    const recovered = await recoverInterruptedOperation(t.env, storeRoot, {
      operationId: failed.operation.conflict.operationId,
    });

    expect(recovered).toMatchObject({
      ok: false,
      conflict: { code: "MANUAL_RECOVERY_REQUIRED", targets: [] },
    });
    expect(JSON.stringify(recovered)).not.toContain(CANARY);
    await expect(
      t.env.fs.lstat(operationReceiptPath(storeRoot, failed.operation.conflict.operationId)),
    ).rejects.toThrow();
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "recovery-required",
    });
  });

  it("rejects an active low-entropy value in protocol identity before journal publication", async () => {
    await t.cleanup();
    t = makeTmpEnv({ env: { LOW_JOURNAL: "tiny" }, randomId: () => "tiny" });
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
    await writeMcpArtifact(t.env, storeRoot, "referenced", {
      kind: "stdio",
      command: "npx",
      env: { API_KEY: "$" + "{LOW_JOURNAL}" },
    });
    const options = mcpOptions(storeRoot, ["claude-code"]);
    const prepared = await planApplyMutation(t.env, options);
    await expect(
      applyMutationPlan(t.env, prepared.mutationPlan, { storeRoot, options }),
    ).rejects.toThrow("active secret value is not allowed in signed mutation metadata");
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
  });

  it("keeps an active low-entropy value out of a real recoverable journal", async () => {
    await t.cleanup();
    t = makeTmpEnv({ env: { LOW_JOURNAL: "tiny" } });
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
    await writeMcpArtifact(t.env, storeRoot, "referenced", {
      kind: "stdio",
      command: "npx",
      env: { API_KEY: "$" + "{LOW_JOURNAL}" },
    });
    const options = mcpOptions(storeRoot, ["claude-code", "gemini-cli"]);
    const prepared = await planApplyMutation(t.env, options);
    const writeFile = t.env.fs.writeFile;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        writeFile: async (path, data, options) => {
          if (path.startsWith(t.path("home", ".gemini", ".cellarer-tmp-"))) {
            throw Object.assign(new Error("write failed around tiny"), { code: "EACCES" });
          }
          await writeFile(path, data, options);
        },
      },
    };

    const failed = await applyMutationPlan(env, prepared.mutationPlan, { storeRoot, options });
    expect(failed.operation).toMatchObject({
      ok: false,
      conflict: { code: "PARTIAL_FAILURE" },
      journal: { status: "recovery-required" },
    });
    const raw = await t.env.fs.readFile(join(storeRoot, "operations", "active.json"));
    expect(raw).not.toContain("tiny");
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      status: "recovery-required",
    });
  });

  it("uses one rotating provider scope across plan, apply, final guard, and afterCommit", async () => {
    const config = await loadConfig(t.env, storeRoot);
    config.customAdapters["reference-native"] = {
      displayName: "Reference Native",
      mcp: {
        global: "~/.reference-native/mcp.json",
        project: "{dir}/.reference-native/mcp.json",
        format: "json",
        supportedSecretReferences: ["environment", "cellarer"],
      },
    };
    await t.env.fs.writeFile(
      join(storeRoot, "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );
    await writeMcpArtifact(t.env, storeRoot, "rotating", {
      kind: "stdio",
      command: "npx",
      env: { API_KEY: "${CELLARER_SECRET:ROTATING}" },
    });
    let reads = 0;
    const appendFile = t.env.fs.appendFile;
    const env: Env = {
      ...t.env,
      secretStore: {
        async get() {
          reads += 1;
          return { found: true, value: reads === 1 ? "tiny" : `rotated-${reads}` };
        },
        async set() {},
        async delete() {
          return false;
        },
      },
      fs: {
        ...t.env.fs,
        appendFile: async (path, data) => {
          if (path === activityPath(storeRoot)) throw new Error("activity failed around tiny");
          await appendFile(path, data);
        },
      },
    };

    const result = await apply(env, {
      ...mcpOptions(storeRoot, ["reference-native"]),
      secretMode: "keychain",
      keychainService: "review-scope",
    });

    expect(result.mutation.result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty("operation");
    expect(reads).toBe(1);
    expect(result.plan.warnings.join("\n")).toContain("tiny");
    expect(
      serializeObservable("cli", result, {
        knownValues: observableKnownValues(result),
      }),
    ).not.toContain("tiny");
    const prepared = await planApplyMutation(t.env, {
      ...mcpOptions(storeRoot, ["reference-native"]),
      secretMode: "keychain",
      keychainService: "review-scope",
    });
    const durablePlan = JSON.stringify(prepared.mutationPlan);
    expect(durablePlan).not.toContain("secretMode");
    expect(durablePlan).not.toContain("keychainService");
    expect(durablePlan).not.toContain("review-scope");
  });

  it("creates one fresh provider scope for an independently applied signed plan", async () => {
    const config = await loadConfig(t.env, storeRoot);
    config.customAdapters["reference-native"] = {
      displayName: "Reference Native",
      mcp: {
        global: "~/.reference-native/mcp.json",
        project: "{dir}/.reference-native/mcp.json",
        format: "json",
        supportedSecretReferences: ["environment", "cellarer"],
      },
    };
    await t.env.fs.writeFile(
      join(storeRoot, "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );
    await writeMcpArtifact(t.env, storeRoot, "independent", {
      kind: "stdio",
      command: "npx",
      env: { API_KEY: "${CELLARER_SECRET:INDEPENDENT}" },
    });
    const planningEnv: Env = {
      ...t.env,
      secretStore: {
        async get() {
          return { found: true, value: "tiny" };
        },
        async set() {},
        async delete() {
          return false;
        },
      },
    };
    const options = {
      ...mcpOptions(storeRoot, ["reference-native"]),
      secretMode: "keychain" as const,
      keychainService: "independent-service",
    };
    const prepared = await planApplyMutation(planningEnv, options);
    const signedPlan = JSON.parse(JSON.stringify(prepared.mutationPlan));
    let reads = 0;
    const applyEnv: Env = {
      ...t.env,
      secretStore: {
        async get() {
          reads += 1;
          return { found: true, value: reads === 1 ? "tiny" : `rotated-${reads}` };
        },
        async set() {},
        async delete() {
          return false;
        },
      },
    };

    const result = await applyMutationPlan(applyEnv, signedPlan, {
      storeRoot,
      options,
      secretMode: "keychain",
      keychainService: "independent-service",
    });

    expect(result.operation).toMatchObject({ ok: true });
    expect(reads).toBe(1);
  });

  it("does not read a provider for malformed MCP that cannot become executable", async () => {
    const config = await loadConfig(t.env, storeRoot);
    config.customAdapters["reference-native"] = {
      displayName: "Reference Native",
      mcp: {
        global: "~/.reference-native/mcp.json",
        project: "{dir}/.reference-native/mcp.json",
        format: "json",
        supportedSecretReferences: ["environment", "cellarer"],
      },
    };
    await t.env.fs.writeFile(
      join(storeRoot, "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );
    await t.env.fs.writeFile(
      join(storeRoot, "store", "mcp", "malformed.json"),
      '{"command":"$' + '{CELLARER_SECRET:PARSE}",',
    );
    let reads = 0;
    const env: Env = {
      ...t.env,
      secretStore: {
        async get() {
          reads += 1;
          return { found: true, value: "tiny" };
        },
        async set() {},
        async delete() {
          return false;
        },
      },
    };
    let thrown: unknown;

    try {
      await planApplyMutation(env, {
        ...mcpOptions(storeRoot, ["reference-native"]),
        secretMode: "keychain",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(reads).toBe(0);
    expect(Object.keys(thrown as object)).not.toContain("providerScope");
    expect(observableKnownValues(thrown)).toEqual([]);
  });
});

async function seedReferencedMcp(t: TmpEnv, storeRoot: string): Promise<void> {
  await writeMcpArtifact(t.env, storeRoot, "referenced", {
    kind: "stdio",
    command: "npx",
    env: { API_KEY: ENV_REFERENCE },
  });
}

function mcpOptions(storeRoot: string, agents: string[]) {
  return {
    storeRoot,
    scope: "global" as const,
    agents,
    capabilities: ["mcp" as const],
    mcpStrategy: "overwrite" as const,
    secretMode: "env" as const,
  };
}
