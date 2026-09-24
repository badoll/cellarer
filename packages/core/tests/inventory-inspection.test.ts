import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { InventorySource } from "../src/inventory/enumerator.js";
import { groupInventoryCandidates } from "../src/inventory/grouper.js";
import { inspectInventorySource } from "../src/inventory/inspector.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const SECRET_CANARY = "ghp_1234567890abcdefghij1234567890";

describe("unified Inventory candidate inspection", () => {
  let t: TmpEnv;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });

  afterEach(async () => {
    await t.cleanup();
  });

  function adapter(id = "fixture"): AgentAdapter {
    return {
      id,
      displayName: id,
      capabilities: { rules: ["global"], mcp: ["global"], skills: ["global"] },
      detect: async () => ({ installed: true, root: t.env.homedir() }),
      paths: () => ({}),
      mcp: {
        codec: {
          decode: (content) => ({
            servers: JSON.parse(content),
            doc: {},
            serversKey: "mcpServers",
          }),
          encode: () => "",
        },
        serversKey: "mcpServers",
        defaultStrategy: "merge",
        supportedSecretReferences: [],
      },
    };
  }

  function source(
    kind: InventorySource["kind"],
    path: string,
    adapterId = "fixture",
  ): InventorySource {
    return {
      id: `${adapterId}:global:${kind}:${path}`,
      adapterId,
      displayName: adapterId,
      scope: "global",
      kind,
      path,
      enabled: true,
      detected: true,
    };
  }

  it("captures one no-follow snapshot and emits closed secret findings without content", async () => {
    const path = t.path("home", ".fixture", "RULES.md");
    await t.env.fs.mkdir(join(path, ".."), { recursive: true });
    await t.env.fs.writeFile(path, `Use ${SECRET_CANARY}\n`);

    const result = await inspectInventorySource(t.env, source("rules", path), adapter());

    expect(result.findings).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.findings).toEqual(["PROBABLE_SECRET"]);
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
  });

  it("fails closed on unsafe links while preserving a typed source finding", async () => {
    const external = t.path("external-skill");
    const skills = t.path("home", ".fixture", "skills");
    await t.env.fs.mkdir(external, { recursive: true });
    await t.env.fs.mkdir(skills, { recursive: true });
    await t.env.fs.symlink(external, join(skills, "linked"), "dir");

    const result = await inspectInventorySource(t.env, source("skills", skills), adapter());

    expect(result.candidates).toEqual([]);
    expect(result.findings.map((finding) => finding.code)).toEqual(["UNSAFE_LINK"]);
  });

  it("discovers a bounded linked Skill and an ordinary sibling independently", async () => {
    const skills = t.path("home", ".fixture", "skills");
    const target = t.path("home", "shared", "linked-skill");
    await t.env.fs.mkdir(target, { recursive: true });
    await t.env.fs.mkdir(join(skills, "ordinary"), { recursive: true });
    await t.env.fs.writeFile(
      join(target, "SKILL.md"),
      "---\nname: linked-skill\ndescription: Linked skill\n---\n# Linked\n",
    );
    await t.env.fs.writeFile(
      join(skills, "ordinary", "SKILL.md"),
      "---\nname: ordinary\ndescription: Ordinary skill\n---\n# Ordinary\n",
    );
    await t.env.fs.symlink(target, join(skills, "linked-skill"), "dir");

    const result = await inspectInventorySource(
      t.env,
      { ...source("skills", skills), boundaryRoot: t.env.homedir() },
      adapter(),
    );

    expect(result.findings).toEqual([]);
    expect(result.candidates.map((candidate) => candidate.name)).toEqual([
      "linked-skill",
      "ordinary",
    ]);
    expect(result.candidates.every((candidate) => candidate.findings.length === 0)).toBe(true);
  });

  it("retains safe siblings when one linked Skill escapes the declared boundary", async () => {
    const skills = t.path("home", ".fixture", "skills");
    const outside = t.path("external-skill");
    await t.env.fs.mkdir(outside, { recursive: true });
    await t.env.fs.mkdir(join(skills, "ordinary"), { recursive: true });
    await t.env.fs.writeFile(
      join(skills, "ordinary", "SKILL.md"),
      "---\nname: ordinary\ndescription: Ordinary skill\n---\n# Ordinary\n",
    );
    await t.env.fs.symlink(outside, join(skills, "escaped"), "dir");

    const result = await inspectInventorySource(
      t.env,
      { ...source("skills", skills), boundaryRoot: t.env.homedir() },
      adapter(),
    );

    expect(result.candidates.map((candidate) => candidate.name)).toEqual(["ordinary"]);
    expect(result.findings.map((finding) => finding.code)).toEqual(["UNSAFE_LINK"]);
  });

  it("never follows a nested link in an otherwise bounded linked Skill", async () => {
    const skills = t.path("home", ".fixture", "skills");
    const target = t.path("home", "shared", "linked");
    const outside = t.path("outside-secret");
    await t.env.fs.mkdir(target, { recursive: true });
    await t.env.fs.mkdir(skills, { recursive: true });
    await t.env.fs.writeFile(
      join(target, "SKILL.md"),
      "---\nname: linked\ndescription: Linked skill\n---\n# Linked\n",
    );
    await t.env.fs.writeFile(outside, SECRET_CANARY);
    await t.env.fs.symlink(outside, join(target, "credentials"), "file");
    await t.env.fs.symlink(target, join(skills, "linked"), "dir");

    const result = await inspectInventorySource(
      t.env,
      { ...source("skills", skills), boundaryRoot: t.env.homedir() },
      adapter(),
    );

    expect(result.candidates).toEqual([]);
    expect(result.findings.map((finding) => finding.code)).toEqual(["UNSAFE_LINK"]);
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
  });

  it("falls back to child isolation when an ordinary Skill has a nested link", async () => {
    const skills = t.path("home", ".fixture", "skills");
    const blocked = join(skills, "blocked");
    const ordinary = join(skills, "ordinary");
    const outside = t.path("outside-secret");
    await t.env.fs.mkdir(blocked, { recursive: true });
    await t.env.fs.mkdir(ordinary, { recursive: true });
    await t.env.fs.writeFile(
      join(ordinary, "SKILL.md"),
      "---\nname: ordinary\ndescription: Ordinary skill\n---\n# Ordinary\n",
    );
    await t.env.fs.writeFile(outside, SECRET_CANARY);
    await t.env.fs.symlink(outside, join(blocked, "credentials"), "file");

    const result = await inspectInventorySource(t.env, source("skills", skills), adapter());

    expect(result.candidates.map(({ name }) => name)).toEqual(["ordinary"]);
    expect(result.findings.map(({ code }) => code)).toEqual(["UNSAFE_LINK"]);
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
  });

  it("enforces one aggregate entry budget across linked and ordinary Skills", async () => {
    const skills = t.path("home", ".fixture", "skills");
    const target = t.path("home", "shared", "linked");
    await t.env.fs.mkdir(target, { recursive: true });
    await t.env.fs.mkdir(join(skills, "ordinary"), { recursive: true });
    for (const directory of [target, join(skills, "ordinary")]) {
      await t.env.fs.writeFile(
        join(directory, "SKILL.md"),
        "---\nname: valid\ndescription: Valid skill\n---\n# Skill\n",
      );
    }
    await t.env.fs.symlink(target, join(skills, "linked"), "dir");
    const declaration = {
      sourceId: "skills",
      scope: "global" as const,
      kind: "skills" as const,
      path: skills,
      locator: "tree" as const,
      maxDepth: 16,
      maxEntries: 4,
      maxBytes: 16777216,
      precedence: { policy: "unknown" as const, evidence: "fixture" },
    };

    const result = await inspectInventorySource(
      t.env,
      { ...source("skills", skills), boundaryRoot: t.env.homedir(), discovery: declaration },
      adapter(),
    );

    expect(result.findings.map((finding) => finding.code)).toEqual(["SOURCE_BUDGET_EXCEEDED"]);
    expect(result.candidates).toHaveLength(1);
  });

  it("normalizes Skills, merges equivalent observations, and retains redacted provenance", async () => {
    const first = t.path("home", ".one", "skills", "Alpha");
    const second = t.path("home", ".two", "skills", "alpha");
    for (const path of [first, second]) {
      await t.env.fs.mkdir(path, { recursive: true });
      await t.env.fs.writeFile(
        join(path, "SKILL.md"),
        "---\nname: alpha\ndescription: Equivalent\n---\n# Equivalent\n",
      );
    }
    const left = await inspectInventorySource(
      t.env,
      source("skills", join(first, ".."), "left"),
      adapter("left"),
    );
    const right = await inspectInventorySource(
      t.env,
      source("skills", join(second, ".."), "right"),
      adapter("right"),
    );

    const result = groupInventoryCandidates(t.env, [...left.candidates, ...right.candidates], []);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "skills",
      state: "ready",
      defaultSelected: true,
      relatedAdapters: [{ id: "left" }, { id: "right" }],
    });
    expect(result[0]?.sources.map((item) => item.location)).toEqual([
      "~/.one/skills/Alpha",
      "~/.two/skills/alpha",
    ]);
    expect(JSON.stringify(result)).not.toContain(t.root);
  });

  it("forms deterministic conflict groups and keeps invalid candidates visible", async () => {
    const roots = [t.path("home", ".one", "skills"), t.path("home", ".two", "skills")];
    for (const [index, root] of roots.entries()) {
      await t.env.fs.mkdir(join(root, "same"), { recursive: true });
      await t.env.fs.writeFile(join(root, "same", "SKILL.md"), `# Variant ${index}\n`);
      await t.env.fs.mkdir(join(root, "invalid"), { recursive: true });
      await t.env.fs.writeFile(join(root, "invalid", "README.md"), "missing manifest\n");
    }
    const observations = await Promise.all(
      roots.map((root, index) =>
        inspectInventorySource(
          t.env,
          source("skills", root, `agent-${index}`),
          adapter(`agent-${index}`),
        ),
      ),
    );

    const result = groupInventoryCandidates(
      t.env,
      observations.flatMap((item) => item.candidates),
      [],
    );
    const conflicts = result.filter((candidate) => candidate.name === "same");
    const invalid = result.find((candidate) => candidate.name === "invalid");

    expect(conflicts).toHaveLength(2);
    expect(new Set(conflicts.map((candidate) => candidate.conflictGroupId)).size).toBe(1);
    expect(conflicts.every((candidate) => candidate.state === "needs-attention")).toBe(true);
    expect(invalid).toMatchObject({
      state: "needs-attention",
      defaultSelected: false,
      findings: [{ code: "INVALID_STRUCTURE" }],
    });
  });
});
