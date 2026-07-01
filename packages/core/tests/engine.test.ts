import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply } from "../src/engine/apply.js";
import { plan } from "../src/engine/plan.js";
import { revert } from "../src/engine/revert.js";
import { status } from "../src/engine/status.js";
import { GENERATED_HEADER } from "../src/markers.js";
import { loadLedger, makeLedger, saveLedger } from "../src/store/ledger.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

// 在临时库房里放一个 rule 制品(可选 channel 标签),返回库房根。
async function seedStore(t: TmpEnv, rules: Record<string, string>, toml = ""): Promise<string> {
  const storeRoot = t.path("home", ".cellarer");
  await t.env.fs.mkdir(t.path("home", ".cellarer", "store", "rules"), { recursive: true });
  for (const [name, content] of Object.entries(rules)) {
    await t.env.fs.writeFile(t.path("home", ".cellarer", "store", "rules", `${name}.md`), content);
  }
  if (toml.length > 0) {
    await t.env.fs.writeFile(t.path("home", ".cellarer", "cellarer.toml"), toml);
  }
  return storeRoot;
}

describe("engine/plan", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  it("produces a write action for a rule to claude-code global", async () => {
    const storeRoot = await seedStore(t, { "coding-style": "Use tabs." });
    const p = await plan(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    expect(p.actions).toHaveLength(1);
    const a = p.actions[0]!;
    expect(a.agent).toBe("claude-code");
    expect(a.capability).toBe("rules");
    expect(a.op).toBe("write");
    expect(a.target).toBe(t.path("home", ".claude", "CLAUDE.md"));
    expect(a.preview?.after).toContain(GENERATED_HEADER);
    expect(a.preview?.after).toContain("Use tabs.");
    expect(a.preview?.after).toContain("<!-- Source: rules/coding-style.md -->");
  });

  it("is read-only: plan writes nothing to disk", async () => {
    const storeRoot = await seedStore(t, { "coding-style": "X" });
    await plan(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    await expect(t.env.fs.readFile(t.path("home", ".claude", "CLAUDE.md"))).rejects.toThrow();
  });

  it("filters rules by channel", async () => {
    const storeRoot = await seedStore(
      t,
      { common1: "C", secret1: "S" },
      `[artifacts."rules/secret1"]
channels = ["internal"]
[artifacts."rules/common1"]
channels = ["common"]
`,
    );
    const p = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      channels: ["common"],
    });
    expect(p.actions[0]?.preview?.after).toContain("C");
    expect(p.actions[0]?.preview?.after).not.toContain("\nS\n");
  });

  it("plans for multiple agents at once", async () => {
    const storeRoot = await seedStore(t, { r: "R" });
    const p = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code", "codex", "cursor", "agents-md"],
    });
    expect(p.actions.map((a) => a.agent).sort()).toEqual(
      ["agents-md", "claude-code", "codex", "cursor"].sort(),
    );
    expect(p.actions.find((a) => a.agent === "cursor")?.target).toBe(
      t.path("home", ".cursor", "rules", "cellarer.mdc"),
    );
  });

  it("skips an unsupported capability/scope with a warning", async () => {
    const storeRoot = await seedStore(t, { r: "R" });
    const p = await plan(t.env, {
      storeRoot,
      scope: "global",
      agents: ["agents-md"],
      capabilities: ["mcp"],
    });
    expect(p.actions.every((a) => a.op === "skip")).toBe(true);
    expect(p.warnings.length).toBeGreaterThan(0);
  });

  it("warns about an unknown agent id", async () => {
    const storeRoot = await seedStore(t, { r: "R" });
    const p = await plan(t.env, { storeRoot, scope: "global", agents: ["nope"] });
    expect(p.warnings.some((w) => w.includes("nope"))).toBe(true);
  });

  it("honors the per-OS method override ([defaults.os.win32].method)", async () => {
    const storeRoot = await seedStore(
      t,
      { r: "R" },
      `[defaults]
method = "symlink"
[defaults.os.win32]
method = "copy"
`,
    );
    const win = makeTmpEnv({ platform: "win32", homedir: t.env.homedir() });
    const p = await plan(win.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    expect(p.actions[0]?.method).toBe("copy");
    win.cleanup();
    // darwin 不受 win32 覆盖影响。
    const p2 = await plan(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    expect(p2.actions[0]?.method).toBe("symlink");
  });

  it("de-conflicts agents that map to the same target file (codex + agents-md → AGENTS.md)", async () => {
    const storeRoot = await seedStore(t, { r: "R" });
    const proj = t.path("proj");
    await t.env.fs.mkdir(proj, { recursive: true });
    // codex 与 agents-md 的 project rules 都是 {dir}/AGENTS.md。
    const p = await plan(t.env, {
      storeRoot,
      scope: "project",
      dir: proj,
      agents: ["codex", "agents-md"],
    });
    const writes = p.actions.filter((a) => a.op === "write");
    const skips = p.actions.filter((a) => a.op === "skip");
    // 只保留一个写 AGENTS.md 的动作,另一个被去冲突。
    expect(writes).toHaveLength(1);
    expect(skips).toHaveLength(1);
    expect(p.warnings.some((w) => w.includes("collides"))).toBe(true);
  });
});

describe("engine/apply + revert", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  it("writes rendered rules and records a ledger entry", async () => {
    const storeRoot = await seedStore(t, { "coding-style": "Use tabs." });
    const r = await apply(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    const target = t.path("home", ".claude", "CLAUDE.md");
    const content = await t.env.fs.readFile(target);
    expect(content).toContain("Use tabs.");
    expect(r.entries).toHaveLength(1);
    const led = await loadLedger(t.env, storeRoot);
    expect(led.entries[0]?.target).toBe(target);
    expect(led.entries[0]?.generated).toBe(true);
    expect(led.entries[0]?.method).toBe("write");
  });

  it("backs up a pre-existing user file before overwriting", async () => {
    const storeRoot = await seedStore(t, { r: "new content" });
    const target = t.path("home", ".claude", "CLAUDE.md");
    await t.env.fs.mkdir(t.path("home", ".claude"), { recursive: true });
    await t.env.fs.writeFile(target, "my hand-written rules");
    await apply(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    expect(await t.env.fs.readFile(`${target}.bak`)).toBe("my hand-written rules");
    expect(await t.env.fs.readFile(target)).toContain("new content");
  });

  it("is idempotent: applying twice yields identical disk + ledger", async () => {
    const storeRoot = await seedStore(t, { r: "stuff" });
    await apply(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    const target = t.path("home", ".claude", "CLAUDE.md");
    const after1 = await t.env.fs.readFile(target);
    const led1 = JSON.stringify(await loadLedger(t.env, storeRoot));
    await apply(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    const after2 = await t.env.fs.readFile(target);
    const led2 = JSON.stringify(await loadLedger(t.env, storeRoot));
    expect(after2).toBe(after1);
    // 台账必须字节一致(含 appliedAt),否则破坏「台账与磁盘一致」幂等约束。
    expect(led2).toBe(led1);
    // 第二次不应再产生 .bak(目标已是生成物)
    await expect(t.env.fs.lstat(`${target}.bak`)).rejects.toThrow();
  });

  it("preserves the original backup pointer across re-apply, so revert still restores it", async () => {
    const storeRoot = await seedStore(t, { r: "generated" });
    const target = t.path("home", ".claude", "CLAUDE.md");
    await t.env.fs.mkdir(t.path("home", ".claude"), { recursive: true });
    await t.env.fs.writeFile(target, "user original");
    // 首次 apply 备份用户文件;二次 apply 目标已是生成物。
    await apply(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    await apply(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    const led = await loadLedger(t.env, storeRoot);
    // 台账仍指向首次确立的 .bak,而非被二次 apply 抹成 null。
    expect(led.entries[0]?.backup).toBe(`${target}.bak`);
    await revert(t.env, { storeRoot, agents: ["claude-code"] });
    expect(await t.env.fs.readFile(target)).toBe("user original");
  });

  it("dry-run writes nothing and records no ledger entries", async () => {
    const storeRoot = await seedStore(t, { r: "stuff" });
    const r = await apply(t.env, {
      storeRoot,
      scope: "global",
      agents: ["claude-code"],
      dryRun: true,
    });
    expect(r.entries).toHaveLength(0);
    await expect(t.env.fs.readFile(t.path("home", ".claude", "CLAUDE.md"))).rejects.toThrow();
    const led = await loadLedger(t.env, storeRoot);
    expect(led.entries).toHaveLength(0);
  });

  it("project scope maintains a .gitignore managed block", async () => {
    const storeRoot = await seedStore(t, { r: "stuff" });
    const proj = t.path("proj");
    await t.env.fs.mkdir(proj, { recursive: true });
    await apply(t.env, { storeRoot, scope: "project", dir: proj, agents: ["claude-code"] });
    const gi = await t.env.fs.readFile(t.path("proj", ".gitignore"));
    expect(gi).toContain("/CLAUDE.md");
  });

  it("gitignore block accumulates across separate applies with different --agent (from ledger)", async () => {
    const storeRoot = await seedStore(t, { r: "stuff" });
    const proj = t.path("proj");
    await t.env.fs.mkdir(proj, { recursive: true });
    await apply(t.env, { storeRoot, scope: "project", dir: proj, agents: ["claude-code"] });
    // 第二次换 cursor:block 应同时含两者(从台账整体重建),不丢 claude-code。
    await apply(t.env, { storeRoot, scope: "project", dir: proj, agents: ["cursor"] });
    const gi = await t.env.fs.readFile(t.path("proj", ".gitignore"));
    expect(gi).toContain("/CLAUDE.md");
    expect(gi).toContain("/.cursor/rules/cellarer.mdc");
  });

  it("partial revert keeps surviving agents' entries in the gitignore block", async () => {
    const storeRoot = await seedStore(t, { r: "stuff" });
    const proj = t.path("proj");
    await t.env.fs.mkdir(proj, { recursive: true });
    await apply(t.env, {
      storeRoot,
      scope: "project",
      dir: proj,
      agents: ["claude-code", "cursor"],
    });
    // 只 revert claude-code:cursor 的条目仍应留在 block 内。
    await revert(t.env, { storeRoot, scope: "project", dir: proj, agents: ["claude-code"] });
    const gi = await t.env.fs.readFile(t.path("proj", ".gitignore"));
    expect(gi).not.toContain("/CLAUDE.md");
    expect(gi).toContain("/.cursor/rules/cellarer.mdc");
  });

  it("revert restores .bak and removes the generated file + ledger entry", async () => {
    const storeRoot = await seedStore(t, { r: "generated" });
    const target = t.path("home", ".claude", "CLAUDE.md");
    await t.env.fs.mkdir(t.path("home", ".claude"), { recursive: true });
    await t.env.fs.writeFile(target, "original");
    await apply(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    const rr = await revert(t.env, { storeRoot, agents: ["claude-code"] });
    expect(rr.reverted).toHaveLength(1);
    // .bak 恢复为原始内容
    expect(await t.env.fs.readFile(target)).toBe("original");
    // 台账清空
    const led = await loadLedger(t.env, storeRoot);
    expect(led.entries).toHaveLength(0);
  });

  it("revert deletes the generated file when there was no prior user file", async () => {
    const storeRoot = await seedStore(t, { r: "generated" });
    const target = t.path("home", ".claude", "CLAUDE.md");
    await apply(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    await revert(t.env, { storeRoot, agents: ["claude-code"] });
    await expect(t.env.fs.readFile(target)).rejects.toThrow();
  });

  it("revert --keep-backups leaves the .bak in place", async () => {
    const storeRoot = await seedStore(t, { r: "g" });
    const target = t.path("home", ".claude", "CLAUDE.md");
    await t.env.fs.mkdir(t.path("home", ".claude"), { recursive: true });
    await t.env.fs.writeFile(target, "original");
    await apply(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    await revert(t.env, { storeRoot, agents: ["claude-code"], keepBackups: true });
    expect(await t.env.fs.readFile(`${target}.bak`)).toBe("original");
  });

  it("revert clears the project .gitignore managed block", async () => {
    const storeRoot = await seedStore(t, { r: "g" });
    const proj = t.path("proj");
    await t.env.fs.mkdir(proj, { recursive: true });
    await apply(t.env, { storeRoot, scope: "project", dir: proj, agents: ["claude-code"] });
    await revert(t.env, { storeRoot, scope: "project", dir: proj, agents: ["claude-code"] });
    // .gitignore 只含 block → 被删除
    await expect(t.env.fs.readFile(t.path("proj", ".gitignore"))).rejects.toThrow();
  });

  it("refuses to delete a tampered ledger target outside the managed roots", async () => {
    const storeRoot = await seedStore(t, { r: "stuff" });
    await apply(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    // 模拟被篡改的台账:target 改到 home/cwd 之外的盘外文件。
    const outside = t.path("outside", "victim.txt");
    await t.env.fs.mkdir(t.path("outside"), { recursive: true });
    await t.env.fs.writeFile(outside, "DO NOT DELETE");
    const led = await loadLedger(t.env, storeRoot);
    const tampered = makeLedger(led.entries.map((e) => ({ ...e, target: outside })));
    await saveLedger(t.env, storeRoot, tampered);
    await expect(revert(t.env, { storeRoot, agents: ["claude-code"] })).rejects.toThrow(
      /outside managed root/,
    );
    // 盘外文件必须完好(护栏在 rm 之前拦下)。
    expect(await t.env.fs.readFile(outside)).toBe("DO NOT DELETE");
  });

  it("cannot be bypassed by relabeling a tampered entry as project scope (no --dir)", async () => {
    const storeRoot = await seedStore(t, { r: "stuff" });
    await apply(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    const outside = t.path("outside", "victim.txt");
    await t.env.fs.mkdir(t.path("outside"), { recursive: true });
    await t.env.fs.writeFile(outside, "DO NOT DELETE");
    const led = await loadLedger(t.env, storeRoot);
    // 攻击者把恶意条目标成 project(scope 与 target 同存于可篡改台账),企图绕过按 scope 选根的校验。
    const tampered = makeLedger(
      led.entries.map((e) => ({ ...e, scope: "project" as const, target: outside })),
    );
    await saveLedger(t.env, storeRoot, tampered);
    // 无 --dir:护栏不按 entry.scope 分派根,仍以 home∪cwd 兜底拦下。
    await expect(revert(t.env, { storeRoot, agents: ["claude-code"] })).rejects.toThrow(
      /outside managed root/,
    );
    expect(await t.env.fs.readFile(outside)).toBe("DO NOT DELETE");
  });
});

describe("engine/status", () => {
  let t: TmpEnv;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });
  afterEach(() => t.cleanup());

  it("reports ok right after apply", async () => {
    const storeRoot = await seedStore(t, { r: "stuff" });
    await apply(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    const items = await status(t.env, { storeRoot });
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("ok");
  });

  it("reports drifted when the target is hand-modified", async () => {
    const storeRoot = await seedStore(t, { r: "stuff" });
    await apply(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    await t.env.fs.writeFile(t.path("home", ".claude", "CLAUDE.md"), "tampered");
    const items = await status(t.env, { storeRoot });
    expect(items[0]?.status).toBe("drifted");
  });

  it("reports missing when the target is deleted", async () => {
    const storeRoot = await seedStore(t, { r: "stuff" });
    await apply(t.env, { storeRoot, scope: "global", agents: ["claude-code"] });
    await t.env.fs.rm(t.path("home", ".claude", "CLAUDE.md"), { force: true });
    const items = await status(t.env, { storeRoot });
    expect(items[0]?.status).toBe("missing");
  });
});
