import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply } from "../src/engine/apply.js";
import { plan } from "../src/engine/plan.js";
import { revert } from "../src/engine/revert.js";
import { status } from "../src/engine/status.js";
import type { DistributeOptions } from "../src/engine/types.js";
import { type CellarerConfig, initialConfigText, parseConfig } from "../src/store/config.js";
import { loadLedger } from "../src/store/ledger.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

// 在临时库房里放 mcp / skills 制品 + 可选 config.json 调整。
async function seedStore(
  t: TmpEnv,
  opts: {
    mcp?: Record<string, unknown>; // name → server json
    skills?: Record<string, Record<string, string>>; // name → {file: content}
    configure?: (config: CellarerConfig) => void;
  },
): Promise<string> {
  const storeRoot = t.path("home", ".cellarer");
  await t.env.fs.mkdir(t.path("home", ".cellarer", "store", "mcp"), { recursive: true });
  await t.env.fs.mkdir(t.path("home", ".cellarer", "store", "skills"), { recursive: true });
  for (const [name, server] of Object.entries(opts.mcp ?? {})) {
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "store", "mcp", `${name}.json`),
      JSON.stringify(server, null, 2),
    );
  }
  for (const [name, files] of Object.entries(opts.skills ?? {})) {
    await t.env.fs.mkdir(t.path("home", ".cellarer", "store", "skills", name), { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      await t.env.fs.writeFile(t.path("home", ".cellarer", "store", "skills", name, file), content);
    }
  }
  if (opts.configure) {
    const config = parseConfig(await initialConfigText(t.env));
    opts.configure(config);
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  }
  return storeRoot;
}

function addReferenceNativeAdapter(config: CellarerConfig): void {
  addReferenceAdapter(config, "reference-native", "~/.reference-native/mcp.json");
}

function addReferenceAdapter(config: CellarerConfig, id: string, globalTarget: string): void {
  config.customAdapters[id] = {
    displayName: id,
    mcp: {
      global: globalTarget,
      project: `{dir}/.${id}/mcp.json`,
      format: "json",
      supportedSecretReferences: ["environment", "cellarer"],
      dialect: { expansionPositions: ["env", "args"] },
    },
  };
}

async function applyReplacingUnowned(t: TmpEnv, opts: DistributeOptions) {
  const conflict = (await plan(t.env, opts)).conflicts.find(
    (item) => item.code === "UNOWNED_TARGET",
  );
  const token = conflict?.acknowledgement?.token;
  if (!token) throw new Error("expected unowned-target replacement acknowledgement");
  return apply(t.env, {
    ...opts,
    replaceUnowned: [token],
    snapshotPassphrase: "test-snapshot-passphrase",
  });
}

describe("engine mcp distribution", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  it("writes a JSON mcp file for claude-code (merge into mcpServers)", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { context7: { command: "npx", args: ["-y", "c7"] } },
    });
    const r = await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["mcp"],
    });
    expect(r.entries).toHaveLength(1);
    const target = t.path("home", ".claude.json");
    const parsed = JSON.parse(await t.env.fs.readFile(target));
    expect(parsed.mcpServers.context7.command).toBe("npx");
    expect(r.entries[0]?.capability).toBe("mcp");
    expect(r.entries[0]?.receipt.generated).toBe(false); // merge 进既有文件,非整文件生成
  });

  it("writes codex config.toml under [mcp_servers.*]", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { context7: { command: "npx", args: ["-y", "c7"] } },
    });
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["codex"],
      capabilities: ["mcp"],
    });
    const target = t.path("home", ".codex", "config.toml");
    const content = await t.env.fs.readFile(target);
    expect(content).toContain("[mcp_servers.context7]");
    expect(content).toContain('command = "npx"');
  });

  it("merge preserves existing servers + non-server fields in codex config", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { added: { command: "new" } },
    });
    const target = t.path("home", ".codex", "config.toml");
    await t.env.fs.mkdir(t.path("home", ".codex"), { recursive: true });
    await t.env.fs.writeFile(target, `model = "gpt-5"\n\n[mcp_servers.kept]\ncommand = "old"\n`);
    await applyReplacingUnowned(t, {
      storeRoot,
      scope: "global",
      agents: ["codex"],
      capabilities: ["mcp"],
    });
    const content = await t.env.fs.readFile(target);
    expect(content).toContain('model = "gpt-5"');
    expect(content).toContain("[mcp_servers.kept]");
    expect(content).toContain("[mcp_servers.added]");
  });

  it("is idempotent: re-apply yields identical disk + ledger", async () => {
    t.env.env.MY_VAR = "configured";
    const storeRoot = await seedStore(t, {
      mcp: { x: { command: "npx", env: { K: "$" + "{MY_VAR}" } } },
    });
    const opts = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["mcp" as const],
    };
    await apply(t.env, opts);
    const target = t.path("home", ".claude.json");
    const after1 = await t.env.fs.readFile(target);
    const led1 = JSON.stringify(await loadLedger(t.env, storeRoot));
    await apply(t.env, opts);
    expect(await t.env.fs.readFile(target)).toBe(after1);
    expect(JSON.stringify(await loadLedger(t.env, storeRoot))).toBe(led1);
  });

  it("overwrite strategy replaces servers section but keeps other fields", async () => {
    const storeRoot = await seedStore(t, { mcp: { only: { command: "y" } } });
    const target = t.path("home", ".claude.json");
    await t.env.fs.mkdir(t.path("home", ".claude"), { recursive: true });
    await t.env.fs.writeFile(
      target,
      JSON.stringify({ other: 1, mcpServers: { gone: { command: "x" } } }),
    );
    await applyReplacingUnowned(t, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["mcp"],
      mcpStrategy: "overwrite",
    });
    const parsed = JSON.parse(await t.env.fs.readFile(target));
    expect(parsed.other).toBe(1);
    expect(parsed.mcpServers.gone).toBeUndefined();
    expect(parsed.mcpServers.only.command).toBe("y");
  });
});

describe("engine mcp — secret handling (red line)", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  it("preserves a CELLARER_SECRET reference token exactly", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { c7: { command: "npx", env: { CONTEXT7_API_KEY: "${CELLARER_SECRET:C7_KEY}" } } },
      configure: addReferenceNativeAdapter,
    });
    const { saveVault } = await import("../src/secrets/secret-metadata-runtime.js");
    await saveVault(t.env, storeRoot, { C7_KEY: "configured" }, "pp");
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["reference-native"],
      capabilities: ["mcp"],
      secretMode: "vault",
      vaultPassphrase: "pp",
    });
    const content = await t.env.fs.readFile(t.path("home", ".reference-native", "mcp.json"));
    expect(content).toContain("${CELLARER_SECRET:C7_KEY}");
    const led = await loadLedger(t.env, storeRoot);
    expect(led.owners[0]?.secretRefs).toContain("C7_KEY");
  });

  it("preserves a CELLARER_SECRET reference token inside args", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { c7: { command: "npx", args: ["--token", "${CELLARER_SECRET:ARG_KEY}"] } },
      configure: addReferenceNativeAdapter,
    });
    const { saveVault } = await import("../src/secrets/secret-metadata-runtime.js");
    await saveVault(t.env, storeRoot, { ARG_KEY: "configured" }, "pp");
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["reference-native"],
      capabilities: ["mcp"],
      secretMode: "vault",
      vaultPassphrase: "pp",
    });
    const content = await t.env.fs.readFile(t.path("home", ".reference-native", "mcp.json"));
    expect(content).toContain("${CELLARER_SECRET:ARG_KEY}");
  });

  it("does not resolve a reference through keychain while rendering", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { c7: { command: "npx", env: { TOKEN: "${CELLARER_SECRET:C7_TOKEN}" } } },
      configure: addReferenceNativeAdapter,
    });
    let reads = 0;
    t.env.secretStore = {
      async get() {
        reads += 1;
        return { found: true, value: "ghp_realtokenrealtokenrealtoken12345" };
      },
      async set() {},
      async delete() {
        return false;
      },
    };
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["reference-native"],
      capabilities: ["mcp"],
      secretMode: "keychain",
    });
    const content = await t.env.fs.readFile(t.path("home", ".reference-native", "mcp.json"));
    // The complete apply operation shares one provider scope across planning and under-lock guards.
    expect(reads).toBe(1);
    expect(content).toContain("${CELLARER_SECRET:C7_TOKEN}");
    expect(content).not.toContain("ghp_realtoken");
  });

  it("uses only the referenced keychain value as a scoped known-value guard", async () => {
    const lowEntropyCanary = "low entropy provider canary";
    const storeRoot = await seedStore(t, {
      mcp: {
        c7: {
          command: "npx",
          args: ["${CELLARER_SECRET:NEEDED}", `literal=${lowEntropyCanary}`],
        },
      },
      configure: addReferenceNativeAdapter,
    });
    const reads: string[] = [];
    t.env.secretStore = {
      async get(_service, account) {
        reads.push(account);
        if (account !== "NEEDED") throw new Error("unreferenced keychain entry was accessed");
        return { found: true, value: lowEntropyCanary };
      },
      async set() {},
      async delete() {
        return false;
      },
    };

    const result = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["reference-native"],
      capabilities: ["mcp"],
      secretMode: "keychain",
    });

    expect(reads.every((name) => name === "NEEDED")).toBe(true);
    expect(result.secretFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifact: "mcp/c7", rule: "known-secret-value" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain(lowEntropyCanary);
  });

  it("blocks a selected MCP resource when its required reference is missing", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { c7: { command: "npx", env: { TOKEN: "${CELLARER_SECRET:MISSING_TOKEN}" } } },
      configure: addReferenceNativeAdapter,
    });
    t.env.secretStore = {
      async get() {
        return { found: false };
      },
      async set() {},
      async delete() {
        return false;
      },
    };

    const result = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["reference-native"],
      capabilities: ["mcp"],
      secretMode: "keychain",
    });

    expect(result.actions.find((action) => action.capability === "mcp")?.op).toBe("skip");
    expect(result.secretReferenceFindings).toEqual([
      {
        reference: "$" + "{CELLARER_SECRET:MISSING_TOKEN}",
        provider: "keychain",
        status: "missing",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("ghp_realtoken");
  });

  it("keeps reference evidence only on every active MCP action guarded for that name", async () => {
    const storeRoot = await seedStore(t, {
      mcp: {
        shared: { command: "npx", env: { TOKEN: "$" + "{CELLARER_SECRET:SHARED_TOKEN}" } },
      },
      configure(config) {
        addReferenceAdapter(config, "ordinary-pre-skip", "~/.ordinary-pre-skip/mcp.json");
        addReferenceAdapter(config, "guarded-a", "~/.guarded-a/mcp.json");
        addReferenceAdapter(config, "guarded-b", "~/.guarded-b/mcp.json");
      },
    });
    await t.env.fs.mkdir(t.path("home", ".ordinary-pre-skip"), { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".ordinary-pre-skip", "mcp.json"),
      JSON.stringify({ userOwned: true }),
    );
    t.env.secretStore = {
      async get() {
        return { found: false };
      },
      async set() {},
      async delete() {
        return false;
      },
    };

    const result = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["ordinary-pre-skip", "guarded-a", "guarded-b"],
      capabilities: ["mcp"],
      secretMode: "keychain",
    });

    const ordinaryPreSkip = result.actions.find((action) => action.agent === "ordinary-pre-skip");
    expect(ordinaryPreSkip?.op).toBe("skip");
    expect(ordinaryPreSkip).not.toHaveProperty("secretRefs");
    expect(
      result.actions
        .filter((action) => action.agent.startsWith("guarded-"))
        .map(({ agent, op, secretRefs }) => ({ agent, op, secretRefs })),
    ).toEqual([
      { agent: "guarded-a", op: "skip", secretRefs: ["SHARED_TOKEN"] },
      { agent: "guarded-b", op: "skip", secretRefs: ["SHARED_TOKEN"] },
    ]);
    expect(result.secretReferenceFindings).toEqual([
      {
        reference: "$" + "{CELLARER_SECRET:SHARED_TOKEN}",
        provider: "keychain",
        status: "missing",
      },
    ]);
  });

  it("does not verify unrequested MCP references while planning Rules", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { unused: { command: "npx", env: { TOKEN: "${CELLARER_SECRET:UNUSED}" } } },
    });
    await t.env.fs.mkdir(t.path("home", ".cellarer", "store", "rules"), { recursive: true });
    await t.env.fs.writeFile(t.path("home", ".cellarer", "store", "rules", "safe.md"), "# Safe");
    let reads = 0;
    t.env.secretStore = {
      async get() {
        reads += 1;
        return { found: false };
      },
      async set() {},
      async delete() {
        return false;
      },
    };

    const result = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["rules"],
      secretMode: "keychain",
    });

    expect(reads).toBe(0);
    expect(result.secretReferenceFindings).toBeUndefined();
    expect(result.actions.find((action) => action.capability === "rules")?.op).toBe("write");
  });

  it("does not let an adapter-skipped MCP reference block an executable Rules action", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { skipped: { command: "npx", env: { TOKEN: "${CELLARER_SECRET:SKIPPED}" } } },
    });
    await t.env.fs.mkdir(t.path("home", ".cellarer", "store", "rules"), { recursive: true });
    await t.env.fs.writeFile(t.path("home", ".cellarer", "store", "rules", "safe.md"), "# Safe");
    let reads = 0;
    t.env.secretStore = {
      async get() {
        reads += 1;
        return { found: false };
      },
      async set() {},
      async delete() {
        return false;
      },
    };

    const result = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["rules", "mcp"],
      secretMode: "keychain",
    });

    expect(reads).toBe(0);
    expect(result.secretReferenceFindings).toBeUndefined();
    expect(result.actions.find((action) => action.capability === "mcp")?.op).toBe("skip");
    expect(result.actions.find((action) => action.capability === "rules")?.op).toBe("write");
  });

  it("does not read a provider for an ownership-rejected MCP action", async () => {
    const storeRoot = await seedStore(t, {
      mcp: {
        rejected: { command: "npx", env: { TOKEN: "$" + "{CELLARER_SECRET:REJECTED}" } },
      },
      configure: addReferenceNativeAdapter,
    });
    await t.env.fs.mkdir(t.path("home", ".reference-native"), { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".reference-native", "mcp.json"),
      JSON.stringify({ userOwned: true }),
    );
    let reads = 0;
    t.env.secretStore = {
      async get() {
        reads += 1;
        return { found: true, value: "must-not-be-read" };
      },
      async set() {},
      async delete() {
        return false;
      },
    };

    const result = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["reference-native"],
      capabilities: ["mcp"],
      secretMode: "keychain",
    });

    expect(result.actions.find((action) => action.capability === "mcp")?.op).toBe("skip");
    expect(result.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "UNOWNED_TARGET" })]),
    );
    expect(reads).toBe(0);
  });

  it("blocked action's preview.after is cleared so no plaintext leaks via the returned plan", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { bad: { command: "npx", env: { API_KEY: "ghp_0123456789abcdefghijklmnopqrstuvwx" } } },
    });
    const p = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["mcp"],
    });
    const a = p.actions.find((x) => x.capability === "mcp");
    expect(a?.op).toBe("skip");
    expect(a?.preview?.after).toBeUndefined();
  });

  // This real transaction must finish before fixture teardown; Vitest timeouts do not cancel it.
  it("vault mode preserves references and never sends resolved values to the target writer", async () => {
    // 先建 vault。
    const { saveVault } = await import("../src/secrets/secret-metadata-runtime.js");
    const storeRoot = await seedStore(t, {
      mcp: { c7: { command: "npx", env: { TOKEN: "${CELLARER_SECRET:C7_TOKEN}" } } },
      configure: addReferenceNativeAdapter,
    });
    await saveVault(t.env, storeRoot, { C7_TOKEN: "ghp_realtokenrealtokenrealtoken12345" }, "pp");
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["reference-native"],
      capabilities: ["mcp"],
      secretMode: "vault",
      vaultPassphrase: "pp",
    });
    const content = await t.env.fs.readFile(t.path("home", ".reference-native", "mcp.json"));
    expect(content).toContain("${CELLARER_SECRET:C7_TOKEN}");
    expect(content).not.toContain("ghp_realtokenrealtokenrealtoken12345");
    const led = await loadLedger(t.env, storeRoot);
    expect(JSON.stringify(led)).not.toContain("ghp_realtoken");
    expect(led.owners[0]?.secretRefs).toContain("C7_TOKEN");
  }, 30_000);

  // This real transaction must finish before fixture teardown; Vitest timeouts do not cancel it.
  it("project scope vault mode also writes only the reference token", async () => {
    const { saveVault } = await import("../src/secrets/secret-metadata-runtime.js");
    const proj = t.path("proj");
    await t.env.fs.mkdir(proj, { recursive: true });
    const storeRoot = await seedStore(t, {
      mcp: { c7: { command: "npx", env: { TOKEN: "${CELLARER_SECRET:T}" } } },
      configure: addReferenceNativeAdapter,
    });
    await saveVault(t.env, storeRoot, { T: "ghp_realtokenrealtokenrealtoken12345" }, "pp");
    const p = await plan(t.env, {
      storeRoot,
      scope: "project",
      dir: proj,
      agents: ["reference-native"],
      capabilities: ["mcp"],
      secretMode: "vault",
      vaultPassphrase: "pp",
    });
    const mcpAction = p.actions.find((a) => a.capability === "mcp");
    expect(mcpAction?.op).toBe("merge");
    await apply(t.env, {
      storeRoot,
      scope: "project",
      dir: proj,
      agents: ["reference-native"],
      capabilities: ["mcp"],
      secretMode: "vault",
      vaultPassphrase: "pp",
    });
    const content = await t.env.fs.readFile(t.path("proj", ".reference-native", "mcp.json"));
    expect(content).toContain("${CELLARER_SECRET:T}");
    expect(content).not.toContain("ghp_realtokenrealtokenrealtoken12345");
  }, 30_000);

  it("blocks an adapter that requires cellarer to materialize plaintext", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { c7: { command: "npx", env: { TOKEN: "${CELLARER_SECRET:C7_TOKEN}" } } },
      configure(config) {
        config.customAdapters.legacy = {
          displayName: "Legacy",
          mcp: {
            global: "~/.legacy/mcp.json",
            format: "json",
            supportedSecretReferences: [],
          },
        };
      },
    });
    const result = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["legacy"],
      capabilities: ["mcp"],
    });
    const action = result.actions.find((candidate) => candidate.agent === "legacy");
    expect(action?.op).toBe("skip");
    expect(action?.reason).toMatch(/incompatible.*plaintext materialization/i);
    expect(result.warnings.join("\n")).not.toContain("C7_TOKEN=");
  });

  it.each([
    "codex",
    "cursor",
    "opencode",
    "windsurf",
  ])("17.1 makes the built-in %s planner fail closed for the current literal environment token", async (agent) => {
    const storeRoot = await seedStore(t, {
      mcp: { c7: { command: "npx", env: { TOKEN: "${EXACT_ENV_TOKEN}" } } },
    });
    const env = { ...t.env, env: { EXACT_ENV_TOKEN: "configured" } };

    const result = await plan(env, {
      storeRoot,
      scope: "global",
      agents: [agent],
      capabilities: ["mcp"],
    });

    expect(result.actions.find((candidate) => candidate.agent === agent)).toMatchObject({
      op: "skip",
      reason: expect.stringMatching(/incompatible.*plaintext materialization|MCP_ENV_REFERENCE/i),
    });
    expect(JSON.stringify(result)).not.toContain("configured");
  });

  it.each([
    "claude-code",
    "gemini-cli",
  ])("17.1 preserves the exact environment token for the compatible built-in %s planner", async (agent) => {
    const storeRoot = await seedStore(t, {
      mcp: { c7: { command: "npx", env: { TOKEN: "${EXACT_ENV_TOKEN}" } } },
    });
    const env = { ...t.env, env: { EXACT_ENV_TOKEN: "configured" } };

    const result = await plan(env, {
      storeRoot,
      scope: "global",
      agents: [agent],
      capabilities: ["mcp"],
    });
    const action = result.actions.find((candidate) => candidate.agent === agent);

    expect(action?.op).not.toBe("skip");
    expect(action?.preview?.after).toContain("${EXACT_ENV_TOKEN}");
    expect(action?.preview?.after).not.toContain("configured");
  });

  it.each([
    {
      label: "stdio extension",
      server: {
        command: "npx",
        extension: { nested: { credential: "${CELLARER_SECRET:STDIO_EXTRA}" } },
      },
    },
    {
      label: "remote extension",
      server: {
        url: "https://example.test/mcp",
        extension: [{ nested: "${CELLARER_SECRET:REMOTE_EXTRA}" }],
      },
    },
    {
      label: "custom config",
      server: {
        transport: { options: { token: "${CELLARER_SECRET:CUSTOM_CONFIG}" } },
      },
    },
  ])("13.1 rejects unsupported references nested in $label", async ({ server }) => {
    const storeRoot = await seedStore(t, {
      mcp: { nested: server },
      configure(config) {
        config.customAdapters.legacy = {
          displayName: "Legacy",
          mcp: {
            global: "~/.legacy/mcp.json",
            format: "json",
            supportedSecretReferences: ["environment"],
          },
        };
      },
    });

    const result = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["legacy"],
      capabilities: ["mcp"],
    });

    expect(result.actions.find((candidate) => candidate.agent === "legacy")).toMatchObject({
      op: "skip",
      reason: expect.stringMatching(/incompatible.*plaintext materialization|MCP_ENV_REFERENCE/i),
    });
  });

  it("dirty store plaintext is ALWAYS blocked (even global, even env mode)", async () => {
    const storeRoot = await seedStore(t, {
      // 库房脏数据:直接写了明文 token(违反零明文),护栏必须拦。
      mcp: { bad: { command: "npx", env: { API_KEY: "ghp_0123456789abcdefghijklmnopqrstuvwx" } } },
    });
    const p = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["mcp"],
    });
    const mcpAction = p.actions.find((a) => a.capability === "mcp");
    expect(mcpAction?.op).toBe("skip");
    expect(mcpAction?.reason).toContain("plaintext");
  });

  it("generic guard: plaintext secret in a RULE fragment is blocked in project scope", async () => {
    // 通用护栏覆盖 rules(不止 mcp):rule 片段里误写明文 token,project(git 跟踪)必须拦。
    const storeRoot = t.path("home", ".cellarer");
    const proj = t.path("proj");
    await t.env.fs.mkdir(t.path("home", ".cellarer", "store", "rules"), { recursive: true });
    await t.env.fs.mkdir(proj, { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "store", "rules", "leaky.md"),
      "Use this key: ghp_0123456789abcdefghijklmnopqrstuvwx",
    );
    const p = await plan(t.env, {
      storeRoot,
      scope: "project",
      dir: proj,
      agents: ["claude-code"],
      capabilities: ["rules"],
    });
    const rulesAction = p.actions.find((a) => a.capability === "rules");
    expect(rulesAction?.op).toBe("skip");
    expect(rulesAction?.reason).toContain("secret-scan");
  });

  it("generic guard: accidental plaintext in a RULE is blocked in GLOBAL scope too (no escape hatch)", async () => {
    // rules 片段里误写的明文 token 是脏数据,任何 scope 都必须拦。
    const storeRoot = t.path("home", ".cellarer");
    await t.env.fs.mkdir(t.path("home", ".cellarer", "store", "rules"), { recursive: true });
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "store", "rules", "leaky.md"),
      "Use this key: ghp_0123456789abcdefghijklmnopqrstuvwx",
    );
    const p = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["rules"],
    });
    const rulesAction = p.actions.find((a) => a.capability === "rules");
    expect(rulesAction?.op).toBe("skip");
    // 拦下后真值不得残留在返回的 plan 预览里(红线)。
    expect(rulesAction?.preview?.after).toBeUndefined();
  });
});

describe("engine skills distribution", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  it("symlinks a skill directory into the agent skills dir", async () => {
    const storeRoot = await seedStore(t, {
      skills: { "my-skill": { "SKILL.md": "# My Skill" } },
    });
    const r = await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["skills"],
    });
    expect(r.entries).toHaveLength(1);
    const target = t.path("home", ".claude", "skills", "my-skill");
    // 软链落地:能读到真源内容。
    expect(
      await t.env.fs.readFile(t.path("home", ".claude", "skills", "my-skill", "SKILL.md")),
    ).toBe("# My Skill");
    const st = await t.env.fs.lstat(target);
    expect(st.isSymbolicLink()).toBe(true);
    expect(r.entries[0]?.receipt.method).toBe("symlink");
  });

  it("on win32, an explicit symlink skill dir lands as a junction (recorded in the ledger)", async () => {
    const storeRoot = await seedStore(t, {
      skills: { "win-skill": { "SKILL.md": "# Win" } },
    });
    // 复用同一 home(库房就在那),但 platform=win32 → 目录走 junction。
    const w = makeTmpEnv({ platform: "win32", homedir: t.env.homedir() });
    try {
      const r = await apply(w.env, {
        storeRoot,
        scope: "global",
        agents: ["claude-code"],
        capabilities: ["skills"],
        method: "symlink",
      });
      expect(r.entries[0]?.receipt.method).toBe("junction");
      const led = await loadLedger(w.env, storeRoot);
      expect(led.owners[0]?.receipt.method).toBe("junction");
    } finally {
      await w.cleanup();
    }
  });

  it("on win32, a symlink-request that falls back to copy stays idempotent on re-apply (no churn)", async () => {
    const storeRoot = await seedStore(t, {
      skills: { "fb-skill": { "SKILL.md": "# Fallback" } },
    });
    const w = makeTmpEnv({ platform: "win32", homedir: t.env.homedir() });
    try {
      // 注入:junction 抛错(跨卷/权限)→ linkOrCopy 回退 copy;ledger.method="copy" 而 action.method="symlink"。
      const realSymlink = w.env.fs.symlink.bind(w.env.fs);
      w.env.fs.symlink = async (target, path, type) => {
        if (type === "junction") throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        return realSymlink(target, path, type);
      };
      const opts = {
        storeRoot,
        scope: "global" as const,
        agents: ["claude-code"],
        capabilities: ["skills" as const],
        method: "symlink" as const,
      };
      const r1 = await apply(w.env, opts);
      expect(r1.entries[0]?.receipt.method).toBe("copy"); // 回退落地为 copy
      const led1 = JSON.stringify(await loadLedger(w.env, storeRoot));
      // 再次 apply:必须幂等(不 clearDest+重拷、不 churn appliedAt),尽管 action.method 仍是 symlink。
      await apply(w.env, opts);
      expect(JSON.stringify(await loadLedger(w.env, storeRoot))).toBe(led1);
    } finally {
      await w.cleanup();
    }
  });

  it("copy method materializes a real directory", async () => {
    const storeRoot = await seedStore(t, { skills: { s: { "a.txt": "A" } } });
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["skills"],
      method: "copy",
    });
    const target = t.path("home", ".claude", "skills", "s");
    const st = await t.env.fs.lstat(target);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isDirectory()).toBe(true);
    expect(await t.env.fs.readFile(t.path("home", ".claude", "skills", "s", "a.txt"))).toBe("A");
  });

  it("is idempotent: re-applying a symlinked skill keeps the same ledger entry", async () => {
    const storeRoot = await seedStore(t, { skills: { s: { "a.txt": "A" } } });
    const opts = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["skills" as const],
    };
    await apply(t.env, opts);
    const led1 = JSON.stringify(await loadLedger(t.env, storeRoot));
    await apply(t.env, opts);
    expect(JSON.stringify(await loadLedger(t.env, storeRoot))).toBe(led1);
  });

  it("revert removes the symlinked skill (not the store source)", async () => {
    const storeRoot = await seedStore(t, { skills: { s: { "a.txt": "A" } } });
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["skills"],
    });
    await revert(t.env, { storeRoot, agents: ["claude-code"] });
    // 链接已删。
    await expect(t.env.fs.lstat(t.path("home", ".claude", "skills", "s"))).rejects.toThrow();
    // 库房真源仍在。
    expect(
      await t.env.fs.readFile(t.path("home", ".cellarer", "store", "skills", "s", "a.txt")),
    ).toBe("A");
  });

  it("status reports ok for a freshly symlinked skill", async () => {
    const storeRoot = await seedStore(t, { skills: { s: { "a.txt": "A" } } });
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["skills"],
    });
    const items = await status(t.env, { storeRoot });
    expect(items[0]?.status).toBe("ok");
  });

  it("status reports drifted when a copy-landed skill dir is hand-modified", async () => {
    const storeRoot = await seedStore(t, { skills: { s: { "a.txt": "A" } } });
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["skills"],
      method: "copy",
    });
    // 未改:内容指纹匹配 → ok。
    expect((await status(t.env, { storeRoot }))[0]?.status).toBe("ok");
    // 手改落地的 copy 目录内容 → 内容指纹不符 → drifted(横评 §5.2 补齐的缺口)。
    await t.env.fs.writeFile(t.path("home", ".claude", "skills", "s", "a.txt"), "TAMPERED");
    expect((await status(t.env, { storeRoot }))[0]?.status).toBe("drifted");
  });

  // This real transaction must finish before fixture teardown; Vitest timeouts do not cancel it.
  it("blocks a drifted copy skill until exact override, then heals it idempotently", async () => {
    const storeRoot = await seedStore(t, { skills: { s: { "a.txt": "A" } } });
    const opts = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["skills" as const],
      method: "copy" as const,
    };
    await apply(t.env, opts);
    // 手改后的普通 re-apply 必须保留用户改动并返回 drift conflict。
    await t.env.fs.writeFile(t.path("home", ".claude", "skills", "s", "a.txt"), "TAMPERED");
    const blocked = await apply(t.env, opts);
    expect(blocked.entries).toEqual([]);
    expect(blocked.plan.conflicts[0]?.code).toBe("OWNED_TARGET_DRIFTED");
    expect(await t.env.fs.readFile(t.path("home", ".claude", "skills", "s", "a.txt"))).toBe(
      "TAMPERED",
    );
    const token = blocked.plan.conflicts[0]?.acknowledgement?.token;
    if (!token) throw new Error("expected drift acknowledgement");
    await apply(t.env, {
      ...opts,
      overrideDrift: [token],
      snapshotPassphrase: "test-snapshot-passphrase",
    });
    expect(await t.env.fs.readFile(t.path("home", ".claude", "skills", "s", "a.txt"))).toBe("A");
    // 自愈后未再改 → 再次 apply 台账字节不变(幂等)。
    const led1 = JSON.stringify(await loadLedger(t.env, storeRoot));
    await apply(t.env, opts);
    expect(JSON.stringify(await loadLedger(t.env, storeRoot))).toBe(led1);
  }, 30_000);

  it("is idempotent for a copy-landed skill when unchanged", async () => {
    const storeRoot = await seedStore(t, { skills: { s: { "a.txt": "A" } } });
    const opts = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["skills" as const],
      method: "copy" as const,
    };
    await apply(t.env, opts);
    const led1 = JSON.stringify(await loadLedger(t.env, storeRoot));
    await apply(t.env, opts);
    expect(JSON.stringify(await loadLedger(t.env, storeRoot))).toBe(led1);
  });

  // This real transaction must finish before fixture teardown; Vitest timeouts do not cancel it.
  it("can explicitly heal a copy-landed skill replaced by a plain file without ENOTDIR", async () => {
    const storeRoot = await seedStore(t, { skills: { s: { "a.txt": "A" } } });
    const opts = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["skills" as const],
      method: "copy" as const,
    };
    await apply(t.env, opts);
    const target = t.path("home", ".claude", "skills", "s");
    // 用户把落地目录换成普通文件:hashDir(target) 若不先判目录会 readdir→ENOTDIR 中断整个 apply。
    await t.env.fs.rm(target, { recursive: true, force: true });
    await t.env.fs.writeFile(target, "not a dir");
    const blocked = await plan(t.env, opts);
    expect(blocked.conflicts[0]?.code).toBe("OWNED_TARGET_DRIFTED");
    const token = blocked.conflicts[0]?.acknowledgement?.token;
    if (!token) throw new Error("expected drift acknowledgement");
    await apply(t.env, {
      ...opts,
      overrideDrift: [token],
      snapshotPassphrase: "test-snapshot-passphrase",
    });
    expect(await t.env.fs.readFile(t.path("home", ".claude", "skills", "s", "a.txt"))).toBe("A");
  }, 30_000);
});

describe("collection filtering across capabilities", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  it("filters mcp + skills by collection like rules", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { default1: { command: "a" }, internal1: { command: "b" } },
      skills: { defaultSkill: { "x.md": "x" }, internalSkill: { "y.md": "y" } },
      configure: (config) => {
        config.artifacts["mcp/internal1"] = { collections: ["internal"] };
        config.artifacts["skills/internalSkill"] = { collections: ["internal"] };
      },
    });
    const p = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["mcp", "skills"],
      collections: ["default"],
    });
    // mcp:internal1 被过滤,只剩 default1。
    const mcp = p.actions.find((a) => a.capability === "mcp");
    expect(mcp?.preview?.after).toContain("default1");
    expect(mcp?.preview?.after).not.toContain("internal1");
    // skills:只下发 defaultSkill。
    const skillTargets = p.actions.filter((a) => a.capability === "skills").map((a) => a.artifact);
    expect(skillTargets).toContain("skills/defaultSkill");
    expect(skillTargets).not.toContain("skills/internalSkill");
  });
});

describe("per-agent config (adapterOverrides.<id>)", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  it("adapterOverrides.<id>.enabled = false skips that agent entirely", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { x: { command: "npx" } },
      configure: (config) => {
        config.adapterOverrides["claude-code"] = { enabled: false };
      },
    });
    const p = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["mcp"],
    });
    // 该 agent 被禁用 → 无任何动作,且有告警。
    expect(p.actions.filter((a) => a.agent === "claude-code")).toHaveLength(0);
    expect(p.warnings.some((w) => w.includes("disabled"))).toBe(true);
  });

  it("adapterOverrides.<id>.mcp.mergeStrategy = overwrite is honored (no CLI flag)", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { only: { command: "y" } },
      configure: (config) => {
        config.adapterOverrides["claude-code"] = { mcp: { mergeStrategy: "overwrite" } };
      },
    });
    const target = t.path("home", ".claude.json");
    await t.env.fs.mkdir(t.path("home", ".claude"), { recursive: true });
    await t.env.fs.writeFile(target, JSON.stringify({ mcpServers: { gone: { command: "x" } } }));
    await applyReplacingUnowned(t, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["mcp"],
    });
    const parsed = JSON.parse(await t.env.fs.readFile(target));
    // overwrite:既有 gone 被替换,只剩 only。
    expect(parsed.mcpServers.gone).toBeUndefined();
    expect(parsed.mcpServers.only.command).toBe("y");
  });
});
