import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GITIGNORE_END,
  GITIGNORE_START,
  gitignorePath,
  removeManagedBlock,
  updateGitignore,
} from "../src/fs/gitignore.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("fs/gitignore", () => {
  let t: TmpEnv;
  let projectDir: string;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    projectDir = t.path("project");
    await t.env.fs.mkdir(projectDir, { recursive: true });
  });
  afterEach(() => t.cleanup());

  it("exposes the managed block markers", () => {
    expect(GITIGNORE_START).toBe("# START cellarer Generated Files");
    expect(GITIGNORE_END).toBe("# END cellarer Generated Files");
  });

  it("requires an absolute project root at the pure path boundary", () => {
    expect(() => gitignorePath("relative-project")).toThrow(/must be absolute/);
  });

  it("creates .gitignore with a managed block (relative, POSIX, leading slash) + .bak", async () => {
    await updateGitignore(t.env, projectDir, [
      t.path("project", "CLAUDE.md"),
      t.path("project", ".cursor", "rules", "cellarer.mdc"),
    ]);
    const gi = await t.env.fs.readFile(t.path("project", ".gitignore"));
    expect(gi).toContain(GITIGNORE_START);
    expect(gi).toContain(GITIGNORE_END);
    expect(gi).toContain("/CLAUDE.md");
    expect(gi).toContain("/CLAUDE.md.bak");
    expect(gi).toContain("/.cursor/rules/cellarer.mdc");
    expect(gi).toContain("/.cursor/rules/cellarer.mdc.bak");
  });

  it("preserves pre-existing user content outside the managed block", async () => {
    await t.env.fs.writeFile(t.path("project", ".gitignore"), "node_modules\n*.log\n");
    await updateGitignore(t.env, projectDir, [t.path("project", "AGENTS.md")]);
    const gi = await t.env.fs.readFile(t.path("project", ".gitignore"));
    expect(gi).toContain("node_modules");
    expect(gi).toContain("*.log");
    expect(gi).toContain("/AGENTS.md");
  });

  it("replaces the managed block in place (idempotent, no duplication)", async () => {
    await updateGitignore(t.env, projectDir, [t.path("project", "AGENTS.md")]);
    await updateGitignore(t.env, projectDir, [t.path("project", "CLAUDE.md")]);
    const gi = await t.env.fs.readFile(t.path("project", ".gitignore"));
    // 只有一个 managed block。
    expect(gi.split(GITIGNORE_START).length - 1).toBe(1);
    expect(gi.split(GITIGNORE_END).length - 1).toBe(1);
    // 旧条目被替换。
    expect(gi).not.toContain("/AGENTS.md");
    expect(gi).toContain("/CLAUDE.md");
  });

  it("filters out paths outside the project dir (store真源不写 ignore)", async () => {
    await updateGitignore(t.env, projectDir, [
      t.path("project", "AGENTS.md"),
      t.path("store", "rules", "a.md"), // 在 project 之外
    ]);
    const gi = await t.env.fs.readFile(t.path("project", ".gitignore"));
    expect(gi).toContain("/AGENTS.md");
    expect(gi).not.toContain("a.md");
  });

  it("removeManagedBlock strips the block but keeps user content", async () => {
    await t.env.fs.writeFile(t.path("project", ".gitignore"), "node_modules\n");
    await updateGitignore(t.env, projectDir, [t.path("project", "AGENTS.md")]);
    await removeManagedBlock(t.env, projectDir);
    const gi = await t.env.fs.readFile(t.path("project", ".gitignore"));
    expect(gi).toContain("node_modules");
    expect(gi).not.toContain(GITIGNORE_START);
    expect(gi).not.toContain("/AGENTS.md");
  });

  it("removeManagedBlock is a no-op when no .gitignore exists", async () => {
    await expect(removeManagedBlock(t.env, projectDir)).resolves.toBeUndefined();
  });

  it("removes an empty .gitignore left after stripping the only block", async () => {
    await updateGitignore(t.env, projectDir, [t.path("project", "AGENTS.md")]);
    await removeManagedBlock(t.env, projectDir);
    // 之前文件里只有 managed block,移除后应删除空 .gitignore。
    await expect(t.env.fs.readFile(t.path("project", ".gitignore"))).rejects.toThrow();
  });
});
