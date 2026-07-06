import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { add, type GitClient } from "../src/engine/add.js";
import { loadConfig } from "../src/store/config.js";
import { initStore, skillProvenancePath } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("engine/add — local source import", () => {
  let t: TmpEnv;
  let storeRoot: string;
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });
  afterEach(() => t.cleanup());

  it("imports a local .md file into store/rules", async () => {
    const src = t.path("style.md");
    await t.env.fs.writeFile(src, "# coding style\nuse tabs");
    const r = await add(t.env, { storeRoot, source: src });
    expect(r.imported).toEqual([
      {
        kind: "rules",
        name: "style",
        path: t.path("home", ".cellarer", "store", "rules", "style.md"),
      },
    ]);
    expect(
      await t.env.fs.readFile(t.path("home", ".cellarer", "store", "rules", "style.md")),
    ).toContain("use tabs");
  });

  it("imports a local .json file into store/mcp (normalized)", async () => {
    const src = t.path("ctx.json");
    await t.env.fs.writeFile(src, JSON.stringify({ command: "npx", args: ["ctx7"] }));
    const r = await add(t.env, { storeRoot, source: src });
    expect(r.imported[0]?.kind).toBe("mcp");
    expect(r.imported[0]?.name).toBe("ctx");
    const written = await t.env.fs.readFile(
      t.path("home", ".cellarer", "store", "mcp", "ctx.json"),
    );
    expect(JSON.parse(written).command).toBe("npx");
  });

  it("imports a single local skill directory and writes channel + provenance", async () => {
    const src = t.path("my-skill");
    await writeSkill(t, "my-skill", {
      name: "my-skill",
      description: "Does one useful thing",
    });
    const r = await add(t.env, { storeRoot, source: src, channel: "public" });
    expect(r.imported[0]?.kind).toBe("skills");
    expect(r.imported[0]?.name).toBe("my-skill");
    expect(
      await t.env.fs.readFile(
        t.path("home", ".cellarer", "store", "skills", "my-skill", "SKILL.md"),
      ),
    ).toContain("Does one useful thing");
    expect((await loadConfig(t.env, storeRoot)).artifacts["skills/my-skill"]?.channels).toEqual([
      "public",
    ]);
    const provenance = JSON.parse(
      await t.env.fs.readFile(skillProvenancePath(storeRoot, "my-skill")),
    );
    expect(provenance).toMatchObject({
      kind: "skills",
      name: "my-skill",
      vcs: "local",
      channel: "public",
      commit: null,
      subpath: ".",
    });
    expect(provenance.importedAt).toBe("2026-06-30T08:00:00.000Z");
  });

  it("lists multiple skills in a local repo without writing store", async () => {
    await writeSkill(t, "repo/skills/alpha", {
      name: "alpha",
      description: "Alpha skill",
    });
    await writeSkill(t, "repo/skills/beta", {
      name: "beta",
      description: "Beta skill",
    });

    const r = await add(t.env, { storeRoot, source: t.path("repo"), list: true });
    expect(r.candidates.map((c) => c.name)).toEqual(["alpha", "beta"]);
    expect(r.imported).toHaveLength(0);
    await expect(
      t.env.fs.stat(t.path("home", ".cellarer", "store", "skills", "alpha")),
    ).rejects.toThrow();
  });

  it("requires an explicit selection for a multi-skill source", async () => {
    await writeSkill(t, "repo/skills/alpha", {
      name: "alpha",
      description: "Alpha skill",
    });
    await writeSkill(t, "repo/skills/beta", {
      name: "beta",
      description: "Beta skill",
    });

    await expect(add(t.env, { storeRoot, source: t.path("repo") })).rejects.toThrow(
      /Source contains 2 skills/,
    );
  });

  it("imports repeated --skill selections from a local repo", async () => {
    await writeSkill(t, "repo/skills/alpha", {
      name: "alpha",
      description: "Alpha skill",
    });
    await writeSkill(t, "repo/skills/beta", {
      name: "beta",
      description: "Beta skill",
    });

    const r = await add(t.env, {
      storeRoot,
      source: t.path("repo"),
      skills: ["beta", "alpha"],
    });
    expect(r.imported.map((i) => i.name).sort()).toEqual(["alpha", "beta"]);
  });

  it("skips internal skills under --all unless --channel internal is provided", async () => {
    await writeSkill(t, "repo/skills/public-one", {
      name: "public-one",
      description: "Public skill",
    });
    await writeSkill(t, "repo/skills/private-one", {
      name: "private-one",
      description: "Private skill",
      internal: true,
    });

    const publicOnly = await add(t.env, { storeRoot, source: t.path("repo"), all: true });
    expect(publicOnly.imported.map((i) => i.name)).toEqual(["public-one"]);
    expect(publicOnly.skipped[0]?.name).toBe("private-one");

    const internalStore = t.path("home", "internal-cellarer");
    await initStore(t.env, internalStore);
    const withInternal = await add(t.env, {
      storeRoot: internalStore,
      source: t.path("repo"),
      all: true,
      channel: "internal",
    });
    expect(withInternal.imported.map((i) => i.name).sort()).toEqual(["private-one", "public-one"]);
    const config = await loadConfig(t.env, internalStore);
    expect(config.artifacts["skills/private-one"]?.channels).toEqual(["internal"]);
  });

  it("imports good candidates while rejecting invalid frontmatter under --all", async () => {
    await writeSkill(t, "repo/skills/good", {
      name: "good",
      description: "Good skill",
    });
    await t.env.fs.mkdir(t.path("repo", "skills", "bad"), { recursive: true });
    await t.env.fs.writeFile(t.path("repo", "skills", "bad", "SKILL.md"), "# Missing frontmatter");

    const r = await add(t.env, { storeRoot, source: t.path("repo"), all: true });
    expect(r.imported.map((i) => i.name)).toEqual(["good"]);
    expect(r.rejected[0]).toMatchObject({
      kind: "skills",
      name: "bad",
    });
  });

  it("rejects a symlinked SKILL.md candidate without following the link", async () => {
    await writeSkill(t, "repo/skills/good", {
      name: "good",
      description: "Good skill",
    });
    await t.env.fs.mkdir(t.path("repo", "skills", "bad-link"), { recursive: true });
    await t.env.fs.symlink(
      t.path("missing-skill.md"),
      t.path("repo", "skills", "bad-link", "SKILL.md"),
      "file",
    );

    const r = await add(t.env, { storeRoot, source: t.path("repo"), all: true });
    expect(r.imported.map((i) => i.name)).toEqual(["good"]);
    expect(r.rejected[0]).toMatchObject({
      kind: "skills",
      name: "bad-link",
    });
    expect(r.rejected[0]?.reason).toMatch(/SKILL\.md is a symlink/);
  });

  it("skips a same-named artifact by default, overwrites with --force", async () => {
    const src = t.path("style.md");
    await t.env.fs.writeFile(src, "v1");
    await add(t.env, { storeRoot, source: src });
    await t.env.fs.writeFile(src, "v2");
    const skip = await add(t.env, { storeRoot, source: src });
    expect(skip.imported).toHaveLength(0);
    expect(skip.skipped[0]?.reason).toMatch(/already exists/);
    expect(await t.env.fs.readFile(t.path("home", ".cellarer", "store", "rules", "style.md"))).toBe(
      "v1",
    );
    const forced = await add(t.env, { storeRoot, source: src, force: true });
    expect(forced.imported).toHaveLength(1);
    expect(await t.env.fs.readFile(t.path("home", ".cellarer", "store", "rules", "style.md"))).toBe(
      "v2",
    );
  });

  it("rejects importing content with a plaintext secret (no plaintext into store)", async () => {
    const src = t.path("leak.md");
    await t.env.fs.writeFile(src, "token: ghp_0123456789abcdefghijklmnopqrstuvwx");
    const r = await add(t.env, { storeRoot, source: src });
    expect(r.imported).toHaveLength(0);
    expect(r.rejected[0]?.kind).toBe("rules");
    expect(r.rejected[0]?.reason).toMatch(/plaintext secret/);
    await expect(
      t.env.fs.readFile(t.path("home", ".cellarer", "store", "rules", "leak.md")),
    ).rejects.toThrow();
  });

  it("rejects a skill dir containing a plaintext secret in any file", async () => {
    await writeSkill(t, "bad-skill", {
      name: "bad-skill",
      description: "Bad skill",
    });
    await t.env.fs.writeFile(t.path("bad-skill", "cfg.txt"), "AKIAABCDEFGHIJKLMNOP");
    const r = await add(t.env, { storeRoot, source: t.path("bad-skill") });
    expect(r.rejected[0]?.kind).toBe("skills");
    await expect(
      t.env.fs.stat(t.path("home", ".cellarer", "store", "skills", "bad-skill")),
    ).rejects.toThrow();
  });

  it("rejects an mcp source with a structured (non-prefix) secret in env", async () => {
    const src = t.path("leaky.json");
    await t.env.fs.writeFile(
      src,
      JSON.stringify({ command: "npx", env: { API_KEY: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4" } }),
    );
    const r = await add(t.env, { storeRoot, source: src });
    expect(r.imported).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/mcp field/);
    await expect(
      t.env.fs.readFile(t.path("home", ".cellarer", "store", "mcp", "leaky.json")),
    ).rejects.toThrow();
  });

  it("rejects an mcp env secret detectable only by NAME", async () => {
    const src = t.path("named.json");
    await t.env.fs.writeFile(
      src,
      JSON.stringify({ command: "npx", env: { PASSWORD: "hunter2pw" } }),
    );
    const r = await add(t.env, { storeRoot, source: src });
    expect(r.imported).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/mcp field/);
  });

  it("rejects a name-only secret nested in a custom mcp config", async () => {
    const src = t.path("custom.json");
    await t.env.fs.writeFile(
      src,
      JSON.stringify({ mcpServers: { c7: { env: { TOKEN: "hunter2pw" } } } }),
    );
    const r = await add(t.env, { storeRoot, source: src });
    expect(r.imported).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/mcp field/);
  });

  it("accepts an mcp source that uses placeholders (no plaintext)", async () => {
    const src = t.path("ok.json");
    await t.env.fs.writeFile(
      src,
      JSON.stringify({ command: "npx", env: { API_KEY: "$" + "{CELLARER_SECRET:API_KEY}" } }),
    );
    const r = await add(t.env, { storeRoot, source: src });
    expect(r.imported[0]?.kind).toBe("mcp");
  });

  it("rejects a skill dir containing a symlink", async () => {
    const secret = t.path("host-secret.txt");
    await t.env.fs.writeFile(secret, "ghp_0123456789abcdefghijklmnopqrstuvwx");
    await writeSkill(t, "link-skill", {
      name: "link-skill",
      description: "Link skill",
    });
    await t.env.fs.symlink(secret, t.path("link-skill", "creds"), "file");
    const r = await add(t.env, { storeRoot, source: t.path("link-skill") });
    expect(r.imported).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/symlink/);
    await expect(
      t.env.fs.stat(t.path("home", ".cellarer", "store", "skills", "link-skill")),
    ).rejects.toThrow();
  });

  it("stages a GitHub shorthand source through the injected GitClient", async () => {
    await writeSkill(t, "staged/skills/nextjs", {
      name: "nextjs",
      description: "Next.js skill",
    });
    const calls: string[] = [];
    const gitClient: GitClient = {
      async stageGitHub(source) {
        calls.push(`${source.owner}/${source.repo}`);
        return {
          path: t.path("staged"),
          resolvedUrl: source.resolvedUrl,
          ref: source.ref ?? "main",
          commit: "abc123",
          subpath: source.subpath,
        };
      },
    };

    const r = await add(t.env, {
      storeRoot,
      source: "vercel-labs/skills",
      skills: ["nextjs"],
      gitClient,
    });
    expect(calls).toEqual(["vercel-labs/skills"]);
    expect(r.imported[0]?.name).toBe("nextjs");
    const provenance = JSON.parse(
      await t.env.fs.readFile(skillProvenancePath(storeRoot, "nextjs")),
    );
    expect(provenance).toMatchObject({
      vcs: "git",
      source: "vercel-labs/skills",
      ref: "main",
      commit: "abc123",
      subpath: "skills/nextjs",
    });
  });

  it("resolves a GitHub tree URL subpath and discovers the skill at that subpath", async () => {
    await writeSkill(t, "staged/skills/web-design-guidelines", {
      name: "web-design-guidelines",
      description: "Design skill",
    });
    const gitClient: GitClient = {
      async stageGitHub(source) {
        expect(source.ref).toBe("main");
        expect(source.subpath).toBe("skills/web-design-guidelines");
        return {
          path: t.path("staged"),
          resolvedUrl: source.resolvedUrl,
          ref: source.ref,
          commit: "def456",
          subpath: source.subpath,
        };
      },
    };

    const r = await add(t.env, {
      storeRoot,
      source: "https://github.com/vercel-labs/skills/tree/main/skills/web-design-guidelines",
      gitClient,
    });
    expect(r.imported[0]?.name).toBe("web-design-guidelines");
  });

  it("resolves a GitHub tree URL whose ref contains slashes", async () => {
    await writeSkill(t, "staged/skills/web-design-guidelines", {
      name: "web-design-guidelines",
      description: "Design skill",
    });
    const gitClient: GitClient = {
      async stageGitHub(source) {
        expect(source.ref).toBe("feature/slash-ref");
        expect(source.subpath).toBe("skills/web-design-guidelines");
        return {
          path: t.path("staged"),
          resolvedUrl: source.resolvedUrl,
          ref: source.ref,
          commit: "fed789",
          subpath: source.subpath,
        };
      },
    };

    const r = await add(t.env, {
      storeRoot,
      source:
        "https://github.com/vercel-labs/skills/tree/feature/slash-ref/skills/web-design-guidelines",
      gitClient,
    });
    expect(r.imported[0]?.name).toBe("web-design-guidelines");
  });

  it("rejects unsupported remote sources", async () => {
    await expect(add(t.env, { storeRoot, source: "https://gitlab.com/org/repo" })).rejects.toThrow(
      /Unsupported source format/,
    );
  });

  it("rejects an unsupported local file type", async () => {
    const src = t.path("weird.xyz");
    await t.env.fs.writeFile(src, "content");
    await expect(add(t.env, { storeRoot, source: src })).rejects.toThrow(
      /unsupported source file type/,
    );
  });
});

async function writeSkill(
  t: TmpEnv,
  rel: string,
  opts: { name: string; description: string; internal?: boolean },
): Promise<void> {
  const dir = t.path(rel);
  await t.env.fs.mkdir(dir, { recursive: true });
  const metadata = opts.internal ? "\nmetadata:\n  internal: true" : "";
  await t.env.fs.writeFile(
    t.path(rel, "SKILL.md"),
    `---\nname: ${opts.name}\ndescription: ${opts.description}${metadata}\n---\n# ${opts.name}\n`,
  );
}
