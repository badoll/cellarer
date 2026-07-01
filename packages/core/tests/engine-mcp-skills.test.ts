import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply } from "../src/engine/apply.js";
import { plan } from "../src/engine/plan.js";
import { revert } from "../src/engine/revert.js";
import { status } from "../src/engine/status.js";
import { loadLedger } from "../src/store/ledger.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

// 在临时库房里放 mcp / skills 制品 + 可选 cellarer.toml。
async function seedStore(
  t: TmpEnv,
  opts: {
    mcp?: Record<string, unknown>; // name → server json
    skills?: Record<string, Record<string, string>>; // name → {file: content}
    toml?: string;
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
  if (opts.toml) await t.env.fs.writeFile(t.path("home", ".cellarer", "cellarer.toml"), opts.toml);
  return storeRoot;
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
    const target = t.path("home", ".claude", "mcp.json");
    const parsed = JSON.parse(await t.env.fs.readFile(target));
    expect(parsed.mcpServers.context7.command).toBe("npx");
    expect(r.entries[0]?.capability).toBe("mcp");
    expect(r.entries[0]?.generated).toBe(false); // merge 进既有文件,非整文件生成
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
    await apply(t.env, { storeRoot, scope: "global", agents: ["codex"], capabilities: ["mcp"] });
    const content = await t.env.fs.readFile(target);
    expect(content).toContain('model = "gpt-5"');
    expect(content).toContain("[mcp_servers.kept]");
    expect(content).toContain("[mcp_servers.added]");
  });

  it("is idempotent: re-apply yields identical disk + ledger", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { x: { command: "npx", env: { K: "${MY_VAR}" } } },
    });
    const opts = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["mcp" as const],
    };
    await apply(t.env, opts);
    const target = t.path("home", ".claude", "mcp.json");
    const after1 = await t.env.fs.readFile(target);
    const led1 = JSON.stringify(await loadLedger(t.env, storeRoot));
    await apply(t.env, opts);
    expect(await t.env.fs.readFile(target)).toBe(after1);
    expect(JSON.stringify(await loadLedger(t.env, storeRoot))).toBe(led1);
  });

  it("overwrite strategy replaces servers section but keeps other fields", async () => {
    const storeRoot = await seedStore(t, { mcp: { only: { command: "y" } } });
    const target = t.path("home", ".claude", "mcp.json");
    await t.env.fs.mkdir(t.path("home", ".claude"), { recursive: true });
    await t.env.fs.writeFile(
      target,
      JSON.stringify({ other: 1, mcpServers: { gone: { command: "x" } } }),
    );
    await apply(t.env, {
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

  it("env mode (default): CELLARER_SECRET ref renders as ${ENV} — NO plaintext on disk", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { c7: { command: "npx", env: { CONTEXT7_API_KEY: "${CELLARER_SECRET:C7_KEY}" } } },
    });
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["mcp"],
    });
    const content = await t.env.fs.readFile(t.path("home", ".claude", "mcp.json"));
    // 落盘断言:env 引用,无真值。
    expect(content).toContain("${C7_KEY}");
    expect(content).not.toContain("CELLARER_SECRET");
    const led = await loadLedger(t.env, storeRoot);
    expect(led.entries[0]?.secretRefs).toContain("C7_KEY");
  });

  it("env mode also rewrites a CELLARER_SECRET ref inside args (not just env/headers)", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { c7: { command: "npx", args: ["--token", "${CELLARER_SECRET:ARG_KEY}"] } },
    });
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["mcp"],
    });
    const content = await t.env.fs.readFile(t.path("home", ".claude", "mcp.json"));
    expect(content).toContain("${ARG_KEY}"); // args 里的引用也被降级,不残留内部字面量
    expect(content).not.toContain("CELLARER_SECRET");
  });

  it("vault mode: unresolved secret downgrades to ${ENV} ref + emits a warning (never the internal literal)", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { c7: { command: "npx", env: { TOKEN: "${CELLARER_SECRET:MISSING}" } } },
    });
    // vault 不含 MISSING。
    const { saveVault } = await import("../src/secrets/vault.js");
    await saveVault(t.env, storeRoot, { OTHER: "x" }, "pp");
    const r = await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["mcp"],
      secretMode: "vault",
      vaultPassphrase: "pp",
    });
    const content = await t.env.fs.readFile(t.path("home", ".claude", "mcp.json"));
    // 降级为 agent 可识别的 env 引用,绝不写 ${CELLARER_SECRET:..} 内部字面量。
    expect(content).toContain("${MISSING}");
    expect(content).not.toContain("CELLARER_SECRET");
    // 告警提示解析失败。
    expect(r.plan.warnings.some((w) => w.includes("MISSING") && w.includes("unresolved"))).toBe(
      true,
    );
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

  it("vault mode global: resolves real value (escape hatch), recorded in ledger refs only", async () => {
    // 先建 vault。
    const { saveVault } = await import("../src/secrets/vault.js");
    const storeRoot = await seedStore(t, {
      mcp: { c7: { command: "npx", env: { TOKEN: "${CELLARER_SECRET:C7_TOKEN}" } } },
    });
    await saveVault(t.env, storeRoot, { C7_TOKEN: "ghp_realtokenrealtokenrealtoken12345" }, "pp");
    await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["mcp"],
      secretMode: "vault",
      vaultPassphrase: "pp",
    });
    const content = await t.env.fs.readFile(t.path("home", ".claude", "mcp.json"));
    // global scope 是逃生通道:允许真值注入(本机非 git)。
    expect(content).toContain("ghp_realtokenrealtokenrealtoken12345");
    // 但台账只记引用名,不记真值。
    const led = await loadLedger(t.env, storeRoot);
    expect(JSON.stringify(led)).not.toContain("ghp_realtoken");
    expect(led.entries[0]?.secretRefs).toContain("C7_TOKEN");
  });

  it("project scope vault mode: secret-scan guard ABORTS (would write plaintext to git-tracked file)", async () => {
    const { saveVault } = await import("../src/secrets/vault.js");
    const proj = t.path("proj");
    await t.env.fs.mkdir(proj, { recursive: true });
    const storeRoot = await seedStore(t, {
      mcp: { c7: { command: "npx", env: { TOKEN: "${CELLARER_SECRET:T}" } } },
    });
    await saveVault(t.env, storeRoot, { T: "ghp_realtokenrealtokenrealtoken12345" }, "pp");
    const p = await plan(t.env, {
      storeRoot,
      scope: "project",
      dir: proj,
      agents: ["claude-code"],
      capabilities: ["mcp"],
      secretMode: "vault",
      vaultPassphrase: "pp",
    });
    const mcpAction = p.actions.find((a) => a.capability === "mcp");
    expect(mcpAction?.op).toBe("skip");
    expect(mcpAction?.reason).toContain("secret-scan");
    // apply 不落地该动作 → 无 .mcp.json 写出。
    await apply(t.env, {
      storeRoot,
      scope: "project",
      dir: proj,
      agents: ["claude-code"],
      capabilities: ["mcp"],
      secretMode: "vault",
      vaultPassphrase: "pp",
    });
    await expect(t.env.fs.readFile(t.path("proj", ".mcp.json"))).rejects.toThrow();
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
    // 修正后的策略:逃生通道(§10.2)只给「vault/keychain 故意解析注入的真值」,
    // rules 片段里误写的明文 token 是脏数据,global 也必须拦(无 allowResolvedPlaintext 标记)。
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
    expect(r.entries[0]?.method).toBe("symlink");
  });

  it("on win32, a skill dir lands as a junction (recorded in the ledger)", async () => {
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
      });
      expect(r.entries[0]?.method).toBe("junction");
      const led = await loadLedger(w.env, storeRoot);
      expect(led.entries[0]?.method).toBe("junction");
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
      }; // 默认 method=symlink
      const r1 = await apply(w.env, opts);
      expect(r1.entries[0]?.method).toBe("copy"); // 回退落地为 copy
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

  it("re-apply self-heals a hand-modified copy skill and stays idempotent afterwards", async () => {
    const storeRoot = await seedStore(t, { skills: { s: { "a.txt": "A" } } });
    const opts = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["skills" as const],
      method: "copy" as const,
    };
    await apply(t.env, opts);
    // 手改后 re-apply 应把内容改回库房真源(自愈)。
    await t.env.fs.writeFile(t.path("home", ".claude", "skills", "s", "a.txt"), "TAMPERED");
    await apply(t.env, opts);
    expect(await t.env.fs.readFile(t.path("home", ".claude", "skills", "s", "a.txt"))).toBe("A");
    // 自愈后未再改 → 再次 apply 台账字节不变(幂等)。
    const led1 = JSON.stringify(await loadLedger(t.env, storeRoot));
    await apply(t.env, opts);
    expect(JSON.stringify(await loadLedger(t.env, storeRoot))).toBe(led1);
  });

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

  it("re-apply self-heals when a copy-landed skill dir was replaced by a plain file (no ENOTDIR crash)", async () => {
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
    // 不应抛;应重拷修复为目录。
    await apply(t.env, opts);
    expect(await t.env.fs.readFile(t.path("home", ".claude", "skills", "s", "a.txt"))).toBe("A");
  });
});

describe("channel filtering across capabilities", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  it("filters mcp + skills by channel like rules", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { common1: { command: "a" }, internal1: { command: "b" } },
      skills: { commonSkill: { "x.md": "x" }, internalSkill: { "y.md": "y" } },
      toml: `[artifacts."mcp/internal1"]
channels = ["internal"]
[artifacts."skills/internalSkill"]
channels = ["internal"]
`,
    });
    const p = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      capabilities: ["mcp", "skills"],
      channels: ["common"],
    });
    // mcp:internal1 被过滤,只剩 common1。
    const mcp = p.actions.find((a) => a.capability === "mcp");
    expect(mcp?.preview?.after).toContain("common1");
    expect(mcp?.preview?.after).not.toContain("internal1");
    // skills:只下发 commonSkill。
    const skillTargets = p.actions.filter((a) => a.capability === "skills").map((a) => a.artifact);
    expect(skillTargets).toContain("skills/commonSkill");
    expect(skillTargets).not.toContain("skills/internalSkill");
  });
});

describe("per-agent config ([agents.<id>])", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  it("[agents.<id>].enabled = false skips that agent entirely", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { x: { command: "npx" } },
      toml: `[agents.claude-code]
enabled = false
`,
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

  it("[agents.<id>.mcp].merge_strategy = overwrite is honored (no CLI flag)", async () => {
    const storeRoot = await seedStore(t, {
      mcp: { only: { command: "y" } },
      toml: `[agents.claude-code.mcp]
merge_strategy = "overwrite"
`,
    });
    const target = t.path("home", ".claude", "mcp.json");
    await t.env.fs.mkdir(t.path("home", ".claude"), { recursive: true });
    await t.env.fs.writeFile(target, JSON.stringify({ mcpServers: { gone: { command: "x" } } }));
    await apply(t.env, {
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
