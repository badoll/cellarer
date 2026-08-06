import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { add, type GitClient } from "../src/engine/add.js";
import { applyMutationPlan, planApplyMutation } from "../src/engine/apply.js";
import type { Env } from "../src/env.js";
import { readOperationJournal } from "../src/protocol/journal.js";
import { acquireStoreMutationLock } from "../src/protocol/mutation-lock.js";
import { readStoreRevision } from "../src/protocol/store-revision.js";
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

  it("fails closed when a regular source is replaced by a symlink between inspection and read", async () => {
    const src = t.path("raced-rule.md");
    const outside = t.path("outside-rule.md");
    const target = t.path("home", ".cellarer", "store", "rules", "raced-rule.md");
    await t.env.fs.writeFile(src, "# original");
    await t.env.fs.writeFile(outside, "# replacement");
    const snapshotFileNoFollow = t.env.fs.snapshotFileNoFollow;
    let replaced = false;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        snapshotFileNoFollow: async (path) => {
          const snapshot = await snapshotFileNoFollow(path);
          if (path === src && !replaced) {
            replaced = true;
            await t.env.fs.rm(src, { force: true });
            await t.env.fs.symlink(outside, src, "file");
          }
          return snapshot;
        },
      },
    };

    const result = await add(env, { storeRoot, source: src });

    expect(result.imported).toEqual([]);
    expect(result.operation).toMatchObject({ ok: false, conflict: { code: "PARTIAL_FAILURE" } });
    await expect(t.env.fs.lstat(target)).rejects.toThrow();
  });

  it("advances revision and makes an older apply plan stale after a rules add", async () => {
    const options = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["rules" as const],
    };
    const prepared = await planApplyMutation(t.env, options);
    const src = t.path("revision-rule.md");
    await t.env.fs.writeFile(src, "# revision rule");

    const added = await add(t.env, { storeRoot, source: src });
    const stale = await applyMutationPlan(t.env, prepared.mutationPlan, {
      storeRoot,
      options,
    });

    expect(added.operation).toMatchObject({ ok: true, receipt: { resultingRevision: 1 } });
    expect(stale.operation).toMatchObject({
      ok: false,
      conflict: { code: "INVALID_PLAN" },
    });
  });

  it("performs no artifact or collection write when the store lock conflicts", async () => {
    const src = t.path("locked-rule.md");
    await t.env.fs.writeFile(src, "# locked rule");
    const acquired = await acquireStoreMutationLock(t.env, storeRoot, {
      operationId: "operation-held",
      processId: 4242,
      hostname: "other-process",
      acquiredAt: "2026-07-28T12:00:00.000Z",
    });
    if (!acquired.ok) throw new Error("expected lock fixture");
    try {
      const result = await add(t.env, { storeRoot, source: src, collection: "locked" });
      expect(result).toMatchObject({
        imported: [],
        operation: { ok: false, conflict: { code: "LOCK_CONFLICT" } },
      });
      await expect(
        t.env.fs.lstat(t.path("home", ".cellarer", "store", "rules", "locked-rule.md")),
      ).rejects.toThrow();
      expect((await loadConfig(t.env, storeRoot)).artifacts["rules/locked-rule"]).toBeUndefined();
      await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    } finally {
      await acquired.lock.release();
    }
  });

  it("rejects collection drift before the lock without importing or overwriting config", async () => {
    const src = t.path("drifted-rule.md");
    const configPath = t.path("home", ".cellarer", "config.json");
    const external = `${JSON.stringify({ version: 1, external: true }, null, 2)}\n`;
    await t.env.fs.writeFile(src, "# must not import");
    const driftEnv = driftBeforeMutationLock(t.env, async () => {
      await t.env.fs.writeFile(configPath, external);
    });

    const result = await add(driftEnv, {
      storeRoot,
      source: src,
      collection: "external-drift",
    });

    expect(result).toMatchObject({
      imported: [],
      operation: {
        ok: false,
        conflict: { code: "TARGET_PRECONDITION_CONFLICT", target: "untrusted" },
      },
    });
    await expect(t.env.fs.readFile(configPath)).resolves.toBe(external);
    await expect(
      t.env.fs.lstat(t.path("home", ".cellarer", "store", "rules", "drifted-rule.md")),
    ).rejects.toThrow();
  });

  it("stops before collection publication when the first artifact action fails", async () => {
    const src = t.path("failed-rule.md");
    const target = t.path("home", ".cellarer", "store", "rules", "failed-rule.md");
    const configPath = t.path("home", ".cellarer", "config.json");
    const configBefore = await t.env.fs.readFile(configPath);
    await t.env.fs.writeFile(src, "# must not import or tag");
    const writeFile = t.env.fs.writeFile;
    const failingEnv: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        writeFile: async (path, data, opts) => {
          if (path.startsWith(`${dirname(target)}/.cellarer-tmp-`)) {
            const error = new Error("simulated artifact write failure") as Error & {
              code: string;
            };
            error.code = "EIO";
            throw error;
          }
          return writeFile(path, data, opts);
        },
      },
    };

    const result = await add(failingEnv, {
      storeRoot,
      source: src,
      collection: "must-not-publish",
    });

    expect(result).toMatchObject({
      imported: [],
      operation: {
        ok: false,
        conflict: { code: "PARTIAL_FAILURE" },
        journal: {
          status: "recovery-required",
          actions: [{ status: "failed" }, { status: "pending" }],
        },
      },
    });
    await expect(t.env.fs.lstat(target)).rejects.toThrow();
    await expect(t.env.fs.readFile(configPath)).resolves.toBe(configBefore);
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toMatchObject({
      actions: [{ status: "failed" }, { status: "pending" }],
    });
  });

  it.each([
    { source: "wrong-rule.md", target: ["store", "rules", "wrong-rule.md"] },
    { source: "wrong-mcp.json", target: ["store", "mcp", "wrong-mcp.json"] },
  ])("rejects silently wrong $source file output without advancing revision", async ({
    source,
    target,
  }) => {
    const sourcePath = t.path(source);
    await t.env.fs.writeFile(
      sourcePath,
      source.endsWith(".md") ? "# signed rule" : JSON.stringify({ command: "npx" }),
    );
    const targetPath = t.path("home", ".cellarer", ...target);
    const rename = t.env.fs.rename;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        rename: async (oldPath, newPath) => {
          await rename(oldPath, newPath);
          if (newPath === targetPath) await t.env.fs.writeFile(newPath, "silent wrong output");
        },
      },
    };

    const result = await add(env, { storeRoot, source: sourcePath });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "PARTIAL_FAILURE" },
      journal: {
        status: "recovery-required",
        actions: [
          {
            status: "failed",
            receipt: { error: { code: "ACTION_POSTCONDITION_FAILED" } },
          },
        ],
      },
    });
    expect(result.imported).toEqual([]);
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
  });

  it("rejects a silently wrong skill directory and leaves provenance pending", async () => {
    await writeSkill(t, "wrong-skill", {
      name: "wrong-skill",
      description: "Signed directory output",
    });
    const provenance = skillProvenancePath(storeRoot, "wrong-skill");
    const writeFileBytes = t.env.fs.writeFileBytes;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        writeFileBytes: async (path, data, opts) => {
          await writeFileBytes(path, data, opts);
          if (path.includes(".wrong-skill.cellarer-snapshot-") && path.endsWith("SKILL.md")) {
            await t.env.fs.writeFile(path, "wrong");
          }
        },
      },
    };

    const result = await add(env, { storeRoot, source: t.path("wrong-skill") });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "PARTIAL_FAILURE" },
      journal: {
        status: "recovery-required",
        actions: [
          { status: "failed", receipt: { error: { code: "ESTALE" } } },
          { status: "pending" },
        ],
      },
    });
    await expect(t.env.fs.lstat(provenance)).rejects.toThrow();
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
  });

  it("rejects silently wrong provenance bytes after the signed skill directory action", async () => {
    await writeSkill(t, "wrong-provenance", {
      name: "wrong-provenance",
      description: "Signed provenance output",
    });
    const provenance = skillProvenancePath(storeRoot, "wrong-provenance");
    const rename = t.env.fs.rename;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        rename: async (oldPath, newPath) => {
          await rename(oldPath, newPath);
          if (newPath === provenance) await t.env.fs.writeFile(newPath, "wrong provenance");
        },
      },
    };

    const result = await add(env, { storeRoot, source: t.path("wrong-provenance") });

    expect(result.operation).toMatchObject({
      ok: false,
      conflict: { code: "PARTIAL_FAILURE" },
      journal: {
        status: "recovery-required",
        actions: [
          { status: "succeeded" },
          { status: "failed", receipt: { error: { code: "ACTION_POSTCONDITION_FAILED" } } },
        ],
      },
    });
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(0);
  });

  it("routes rules, MCP, and skills through the same transactional add result", async () => {
    const rule = t.path("shared.md");
    const mcp = t.path("shared.json");
    await t.env.fs.writeFile(rule, "# shared");
    await t.env.fs.writeFile(mcp, JSON.stringify({ command: "npx", args: ["shared"] }));
    await writeSkill(t, "shared-skill", {
      name: "shared-skill",
      description: "Shared transactional path",
    });

    const results = [
      await add(t.env, { storeRoot, source: rule }),
      await add(t.env, { storeRoot, source: mcp }),
      await add(t.env, { storeRoot, source: t.path("shared-skill") }),
    ];

    expect(results.map((result) => result.operation?.ok)).toEqual([true, true, true]);
    await expect(readStoreRevision(t.env, storeRoot)).resolves.toBe(3);
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

  it("imports a single local skill directory and writes collection + provenance", async () => {
    const src = t.path("my-skill");
    await writeSkill(t, "my-skill", {
      name: "my-skill",
      description: "Does one useful thing",
    });
    const r = await add(t.env, { storeRoot, source: src, collection: "public" });
    expect(r.imported[0]?.kind).toBe("skills");
    expect(r.imported[0]?.name).toBe("my-skill");
    expect(
      await t.env.fs.readFile(
        t.path("home", ".cellarer", "store", "skills", "my-skill", "SKILL.md"),
      ),
    ).toContain("Does one useful thing");
    expect((await loadConfig(t.env, storeRoot)).artifacts["skills/my-skill"]?.collections).toEqual([
      "public",
    ]);
    const provenance = JSON.parse(
      await t.env.fs.readFile(skillProvenancePath(storeRoot, "my-skill")),
    );
    expect(provenance).toMatchObject({
      schemaVersion: 1,
      resourceId: "skills/my-skill",
      kind: "skills",
      name: "my-skill",
      currentRevision: {
        contentFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        validation: {
          status: "validated",
          checks: ["content-fingerprint", "manifest", "secret-scan"],
        },
        source: { type: "local-snapshot", capturedFrom: src },
      },
    });
    expect(provenance.currentRevision.validation.checkedAt).toBe("2026-06-30T08:00:00.000Z");
  });

  it("keeps the resource ID stable when a forced import accepts a new revision", async () => {
    const src = t.path("revisioned-skill");
    await writeSkill(t, "revisioned-skill", {
      name: "revisioned-skill",
      description: "First revision",
    });
    await add(t.env, { storeRoot, source: src });
    const first = JSON.parse(
      await t.env.fs.readFile(skillProvenancePath(storeRoot, "revisioned-skill")),
    );

    await t.env.fs.writeFile(
      t.path("revisioned-skill", "SKILL.md"),
      "---\nname: revisioned-skill\ndescription: Second revision\n---\n",
    );
    await add(t.env, { storeRoot, source: src, force: true });
    const second = JSON.parse(
      await t.env.fs.readFile(skillProvenancePath(storeRoot, "revisioned-skill")),
    );

    expect(second.resourceId).toBe(first.resourceId);
    expect(second.currentRevision.id).not.toBe(first.currentRevision.id);
    expect(second.currentRevision.contentFingerprint).not.toBe(
      first.currentRevision.contentFingerprint,
    );
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

  it("skips internal skills under --all unless --collection internal is provided", async () => {
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
      collection: "internal",
    });
    expect(withInternal.imported.map((i) => i.name).sort()).toEqual(["private-one", "public-one"]);
    const config = await loadConfig(t.env, internalStore);
    expect(config.artifacts["skills/private-one"]?.collections).toEqual(["internal"]);
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

  it("blocks a low-entropy active environment value before writing the Store", async () => {
    const src = t.path("low-entropy.md");
    const target = t.path("home", ".cellarer", "store", "rules", "low-entropy.md");
    await t.env.fs.writeFile(src, "reference=$" + "{LOW_ENTROPY}\nactual=tiny\n");
    const env: Env = { ...t.env, env: { LOW_ENTROPY: "tiny" } };

    const result = await add(env, { storeRoot, source: src });

    expect(result.imported).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/known secret value/i);
    expect(JSON.stringify(result)).not.toContain("tiny");
    await expect(t.env.fs.lstat(target)).rejects.toThrow();
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

  it.each([
    ["number", 17],
    ["boolean", false],
    ["null", null],
    ["array", ["tiny"]],
    ["object", { nested: "tiny" }],
  ] as const)("17.1 rejects a raw MCP %s value after a secret flag before normalization", async (label, value) => {
    const src = t.path(`raw-secret-flag-${label}.json`);
    await t.env.fs.writeFile(
      src,
      JSON.stringify({ command: "mcp-server", args: ["--password", value] }),
    );

    const result = await add(t.env, { storeRoot, source: src });

    expect(result.imported).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/structured mcp|command-secret-argument/i);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
    await expect(
      t.env.fs.lstat(t.path("home", ".cellarer", "store", "mcp", `raw-secret-flag-${label}.json`)),
    ).rejects.toThrow();
  });

  it.each([
    ["reference", "tiny"],
    ["references", ["${ENV_VAR}", "tiny"]],
    ["secretRefs", { nested: "tiny" }],
  ] as const)("17.1 rejects plaintext descendants in MCP %s before Store publication", async (field, value) => {
    const src = t.path(`reference-shaped-${field}.json`);
    await t.env.fs.writeFile(src, JSON.stringify({ command: "mcp-server", [field]: value }));

    const result = await add(t.env, { storeRoot, source: src });

    expect(result.imported).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/structured mcp|sensitive-field/i);
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
    expect(JSON.stringify(result)).not.toContain("tiny");
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
    const env: Env = {
      ...t.env,
      secretStore: {
        async get(_service, account) {
          return account === "API_KEY" ? { found: true, value: "tiny" } : { found: false };
        },
        async set() {},
        async delete() {
          return false;
        },
      },
    };
    const r = await add(env, { storeRoot, source: src, secretMode: "keychain" });
    expect(r.imported[0]?.kind).toBe("mcp");
  });

  it("does not read a provider before a local MCP source passes JSON and structural validation", async () => {
    const src = t.path("malformed.json");
    await t.env.fs.writeFile(src, '{"command":"$' + '{CELLARER_SECRET:UNTRUSTED_MCP}",');
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

    await expect(add(env, { storeRoot, source: src, secretMode: "keychain" })).rejects.toThrow(
      /invalid mcp source/i,
    );
    expect(reads).toBe(0);
  });

  it("keeps list, rejected, unselected, and existing Skill candidates provider-free", async () => {
    await writeSkill(t, "repo/skills/selected", {
      name: "selected",
      description: "Selected $" + "{CELLARER_SECRET:SELECTED}",
    });
    await writeSkill(t, "repo/skills/unselected", {
      name: "unselected",
      description: "Unselected $" + "{CELLARER_SECRET:UNSELECTED}",
    });
    await t.env.fs.mkdir(t.path("repo", "skills", "rejected"), { recursive: true });
    await t.env.fs.writeFile(
      t.path("repo", "skills", "rejected", "SKILL.md"),
      "missing frontmatter $" + "{CELLARER_SECRET:REJECTED}",
    );
    const reads: string[] = [];
    const env: Env = {
      ...t.env,
      secretStore: {
        async get(_service, account) {
          reads.push(account);
          return { found: true, value: "tiny" };
        },
        async set() {},
        async delete() {
          return false;
        },
      },
    };

    await add(env, { storeRoot, source: t.path("repo"), list: true, secretMode: "keychain" });
    expect(reads).toEqual([]);

    const selected = await add(env, {
      storeRoot,
      source: t.path("repo"),
      skills: ["selected"],
      secretMode: "keychain",
    });
    expect(selected.operation).toMatchObject({ ok: true });
    expect(selected.imported).toEqual([expect.objectContaining({ name: "selected" })]);
    expect(selected.rejected).toEqual([]);
    expect(selected.skipped).toEqual([]);
    expect(reads).toEqual(["SELECTED"]);

    reads.length = 0;
    const skipped = await add(env, {
      storeRoot,
      source: t.path("repo"),
      skills: ["selected"],
      secretMode: "keychain",
    });
    expect(skipped.skipped).toEqual([
      expect.objectContaining({
        name: "selected",
        reason: expect.stringMatching(/already exists/),
      }),
    ]);
    expect(reads).toEqual([]);
  });

  it("fails before Store or journal writes when an imported reference is unavailable", async () => {
    const src = t.path("missing-reference.md");
    const target = t.path("home", ".cellarer", "store", "rules", "missing-reference.md");
    await t.env.fs.writeFile(src, "use ${CELLARER_SECRET:MISSING}\n");

    await expect(add(t.env, { storeRoot, source: src })).rejects.toMatchObject({
      code: "SECRET_PROVIDER_SCOPE_UNAVAILABLE",
    });
    await expect(t.env.fs.lstat(target)).rejects.toThrow();
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
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

  it.each([
    ["json", "nested/config.json", '{"outer":{"password":"tiny"}}\n'],
    ["jsonc", "nested/config.jsonc", '{\n  // local only\n  "outer": { "token": "tiny" },\n}\n'],
    ["yaml", "nested/config.yaml", "outer:\n  secret: tiny\n"],
    ["toml", "nested/config.toml", '[outer]\npassword = "tiny"\n'],
  ])("13.1 blocks low-entropy sensitive fields in nested Skill %s", async (_format, file, content) => {
    await writeSkill(t, "structured-skill", {
      name: "structured-skill",
      description: "Structured guard fixture",
    });
    await t.env.fs.mkdir(t.path("structured-skill", "nested"), { recursive: true });
    await t.env.fs.writeFile(t.path("structured-skill", ...file.split("/")), content);

    const result = await add(t.env, { storeRoot, source: t.path("structured-skill") });

    expect(result.imported).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({
        kind: "skills",
        name: "structured-skill",
        reason: expect.stringMatching(/structured|sensitive-field/i),
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("tiny");
    await expect(
      t.env.fs.lstat(t.path("home", ".cellarer", "store", "skills", "structured-skill")),
    ).rejects.toThrow();
  });

  it("16.1 rejects the Skill shape matrix before Store or protocol publication", async () => {
    await writeSkill(t, "shape-matrix", {
      name: "shape-matrix",
      description: "Sensitive field shape matrix",
    });
    await t.env.fs.writeFile(
      t.path("shape-matrix", "config.json"),
      JSON.stringify({
        accessToken: ["tiny", 17, false, null, { nested: "tiny-object" }],
        AccessToken: "tiny-pascal",
        refreshToken: "tiny-refresh",
      }),
    );

    const result = await add(t.env, { storeRoot, source: t.path("shape-matrix") });

    expect(result.imported).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/structured|sensitive-field/i);
    await expect(
      t.env.fs.lstat(t.path("home", ".cellarer", "store", "skills", "shape-matrix")),
    ).rejects.toThrow();
    await expect(readOperationJournal(t.env, storeRoot)).resolves.toBeNull();
    const observable = JSON.stringify(result);
    for (const plaintext of ["tiny", "tiny-object", "tiny-pascal"]) {
      expect(observable).not.toContain(plaintext);
    }
  });

  it("14.1 fails a malformed multiline structured Skill import closed", async () => {
    await writeSkill(t, "malformed-structured-skill", {
      name: "malformed-structured-skill",
      description: "Malformed structured guard fixture",
    });
    await t.env.fs.writeFile(
      t.path("malformed-structured-skill", "config.yaml"),
      'outer:\n  password: "unterminated\n  continuation\n',
    );

    const result = await add(t.env, {
      storeRoot,
      source: t.path("malformed-structured-skill"),
    });

    expect(result.imported).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/structured-parse-error/i);
    await expect(
      t.env.fs.lstat(t.path("home", ".cellarer", "store", "skills", "malformed-structured-skill")),
    ).rejects.toThrow();
  });

  it.each([
    ["rules", "portable.md", "# portable rule\n"],
    ["mcp", "portable.json", '{"command":"npx"}\n'],
  ])("14.1 keeps Windows single-file %s import on the portable snapshot path", async (_kind, file, content) => {
    const src = t.path(file);
    await t.env.fs.writeFile(src, content);
    let recursiveCalls = 0;
    const env: Env = {
      ...t.env,
      platform: "win32",
      fs: {
        ...t.env.fs,
        snapshotTreeNoFollow: async (path) => {
          recursiveCalls += 1;
          throw Object.assign(new Error("recursive traversal unsupported"), {
            code: "CELLARER_SNAPSHOT_UNSUPPORTED",
            path,
          });
        },
      },
    };

    const result = await add(env, { storeRoot, source: src });

    expect(result.imported).toHaveLength(1);
    expect(result.rejected).toEqual([]);
    expect(recursiveCalls).toBe(0);
  });

  it("14.4 rejects an unsupported recursive Skill before reading directory content", async () => {
    await writeSkill(t, "unsupported-recursive", {
      name: "unsupported-recursive",
      description: "Must fail before traversal",
    });
    const source = t.path("unsupported-recursive");
    const calls = { readdir: 0, readFile: 0, snapshot: 0 };
    const env: Env = {
      ...t.env,
      platform: "win32",
      fs: {
        ...t.env.fs,
        supportsSafeRecursiveSnapshots: () => false,
        readdir: async (path) => {
          if (path.startsWith(source)) calls.readdir += 1;
          return t.env.fs.readdir(path);
        },
        readFile: async (path) => {
          if (path.startsWith(source)) calls.readFile += 1;
          return t.env.fs.readFile(path);
        },
        snapshotTreeNoFollow: async (path) => {
          if (path.startsWith(source)) calls.snapshot += 1;
          return t.env.fs.snapshotTreeNoFollow(path);
        },
      },
    };

    await expect(add(env, { storeRoot, source })).rejects.toMatchObject({
      code: "UNSAFE_RECURSIVE_SOURCE",
      reason: "unsupported",
    });
    expect(calls).toEqual({ readdir: 0, readFile: 0, snapshot: 0 });
  });

  it("fails closed when a nested Skill file becomes unreadable", async () => {
    await writeSkill(t, "unreadable-skill", {
      name: "unreadable-skill",
      description: "Unreadable skill",
    });
    const nested = t.path("unreadable-skill", "nested.txt");
    await t.env.fs.writeFile(nested, "safe");
    const snapshotTreeNoFollow = t.env.fs.snapshotTreeNoFollow;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        snapshotTreeNoFollow: async (path) => {
          if (path === t.path("unreadable-skill")) {
            throw Object.assign(new Error("raw secret-bearing error"), {
              code: "EACCES",
              path: nested,
            });
          }
          return snapshotTreeNoFollow(path);
        },
      },
    };

    const result = await add(env, { storeRoot, source: t.path("unreadable-skill") });
    expect(result.imported).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/unreadable/);
    await expect(
      t.env.fs.lstat(t.path("home", ".cellarer", "store", "skills", "unreadable-skill")),
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
          commit: "0123456789abcdef0123456789abcdef01234567",
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
      schemaVersion: 1,
      resourceId: "skills/nextjs",
      currentRevision: {
        source: {
          type: "git",
          repositoryUrl: "https://github.com/vercel-labs/skills",
          ref: "main",
          commit: "0123456789abcdef0123456789abcdef01234567",
          subpath: "skills/nextjs",
        },
      },
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
          commit: "def4567890abcdef0123456789abcdef01234567",
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
          commit: "fed7890123456789abcdef0123456789abcdef01",
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

function driftBeforeMutationLock(env: Env, drift: () => Promise<void>): Env {
  const writeFileExclusive = env.fs.writeFileExclusive;
  let injected = false;
  return {
    ...env,
    fs: {
      ...env.fs,
      writeFileExclusive: async (path, data, opts) => {
        if (!injected && path.endsWith("mutation.lock")) {
          injected = true;
          await drift();
        }
        return writeFileExclusive(path, data, opts);
      },
    },
  };
}

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
