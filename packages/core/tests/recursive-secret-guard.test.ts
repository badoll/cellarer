import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMutationPlan, planApplyMutation } from "../src/engine/apply.js";
import { discoverActiveSecretValuesForActions } from "../src/engine/plan/secret-guard.js";
import { plan } from "../src/engine/plan.js";
import { readFileOrNull } from "../src/fs/probe.js";
import type { Capability, PlanAction, SecretGuardFinding } from "../src/model/index.js";
import { initialConfigText, parseConfig } from "../src/store/config.js";
import { writeRuleArtifact } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const KNOWN_SECRET = "known credential value 9f4c2!";
const KNOWN_REFERENCE = "${CELLARER_TEST_SECRET}";
const PROBABLE_CREDENTIAL = "ghp_0123456789abcdefghijklmnopqrstuvwx";

interface Fixture {
  artifactId: string;
  capability: Capability;
  source: string;
  line: number;
  content(value: string): string;
}

const FIXTURES: readonly Fixture[] = [
  {
    artifactId: "rules/leaky",
    capability: "rules",
    source: "rules/leaky.md",
    line: 2,
    content: (value) => `# Rule\ncredential: ${value}\n`,
  },
  {
    artifactId: "mcp/leaky",
    capability: "mcp",
    source: "mcp/leaky.json",
    line: 1,
    content: (value) => JSON.stringify({ command: "npx", args: ["--credential", value] }),
  },
  {
    artifactId: "skills/leaky",
    capability: "skills",
    source: "skills/leaky/nested/examples/fixture.txt",
    line: 1,
    content: (value) => `fixture credential = ${value}\n`,
  },
];

async function seedFixture(t: TmpEnv, fixture: Fixture, value: string): Promise<string> {
  const storeRoot = t.path("home", ".cellarer");
  const path = join(storeRoot, "store", fixture.source);
  await t.env.fs.mkdir(dirname(path), { recursive: true });
  await t.env.fs.writeFile(path, fixture.content(value));
  return storeRoot;
}

function options(storeRoot: string, capability: Capability) {
  return {
    storeRoot,
    scope: "global" as const,
    agents: ["claude-code"],
    capabilities: [capability],
  };
}

function expectNonDisclosingFinding(
  finding: SecretGuardFinding | undefined,
  fixture: Fixture,
  forbidden: string,
): void {
  expect(finding).toMatchObject({
    artifact: fixture.artifactId,
    source: fixture.source,
    line: fixture.line,
  });
  expect(JSON.stringify(finding)).not.toContain(forbidden);
  expect(finding).not.toHaveProperty("preview");
}

describe("recursive staged-tree secret guard", () => {
  let t: TmpEnv;

  beforeEach(async () => {
    t = makeTmpEnv({ env: { CELLARER_TEST_SECRET: KNOWN_SECRET } });
    await ensureBaseDirs(t);
  });

  afterEach(() => t.cleanup());

  for (const fixture of FIXTURES) {
    it(`blocks a configured known value in staged ${fixture.capability} content`, async () => {
      const storeRoot = await seedFixture(t, fixture, `${KNOWN_SECRET}\n${KNOWN_REFERENCE}`);
      const result = await plan(t.env, options(storeRoot, fixture.capability));

      expect(result.actions.filter((action) => action.op !== "skip")).toEqual([]);
      const finding = result.secretFindings?.find(
        (candidate) =>
          candidate.artifact === fixture.artifactId && candidate.source === fixture.source,
      );
      expectNonDisclosingFinding(finding, fixture, KNOWN_SECRET);
      expect(finding?.rule).toBe("known-secret-value");
      expect(JSON.stringify(result)).not.toContain(KNOWN_SECRET);
    });

    it(`blocks a probable credential in staged ${fixture.capability} content`, async () => {
      const storeRoot = await seedFixture(t, fixture, PROBABLE_CREDENTIAL);
      const result = await plan(t.env, options(storeRoot, fixture.capability));

      expect(result.actions.filter((action) => action.op !== "skip")).toEqual([]);
      const finding = result.secretFindings?.find(
        (candidate) =>
          candidate.artifact === fixture.artifactId && candidate.source === fixture.source,
      );
      expectNonDisclosingFinding(finding, fixture, PROBABLE_CREDENTIAL);
      expect(finding).toMatchObject({ rule: "github-pat", patternVersion: 1 });
      expect(JSON.stringify(result)).not.toContain(PROBABLE_CREDENTIAL);
    });
  }

  it("blocks the complete mutation when one staged artifact has a finding", async () => {
    const storeRoot = await seedFixture(t, FIXTURES[0], "safe rules content");
    await seedFixture(t, FIXTURES[2], PROBABLE_CREDENTIAL);
    const result = await plan(t.env, {
      ...options(storeRoot, "rules"),
      capabilities: ["rules", "skills"],
    });

    expect(result.actions).toHaveLength(2);
    expect(result.actions.every((action) => action.op === "skip")).toBe(true);
    expect(result.actions.every((action) => action.reason?.includes("secret-scan"))).toBe(true);
  });

  it.each([
    ["jsonc", "config.jsonc", '{\n  // generated target\n  "outer": { "token": "tiny" },\n}\n'],
    ["yaml", "config.yaml", "outer:\n  secret: tiny\n"],
    ["toml", "config.toml", '[outer]\npassword = "tiny"\n'],
  ])("14.1 blocks final staged %s low-entropy sensitive values", async (_format, file, content) => {
    const storeRoot = t.path("home", ".cellarer");
    const skillRoot = join(storeRoot, "store", "skills", "structured");
    await t.env.fs.mkdir(skillRoot, { recursive: true });
    await t.env.fs.writeFile(join(skillRoot, "SKILL.md"), "# Structured\n");
    await t.env.fs.writeFile(join(skillRoot, file), content);

    const result = await plan(t.env, options(storeRoot, "skills"));

    expect(result.actions.every((action) => action.op === "skip")).toBe(true);
    expect(result.secretFindings).toContainEqual(
      expect.objectContaining({
        artifact: "skills/structured",
        source: `skills/structured/${file}`,
        rule: "sensitive-field",
      }),
    );
    expect(JSON.stringify(result)).not.toContain("tiny");
  });

  it("14.1 treats a shell-style placeholder default as plaintext at final staging", async () => {
    const storeRoot = t.path("home", ".cellarer");
    const skillRoot = join(storeRoot, "store", "skills", "placeholder-default");
    await t.env.fs.mkdir(skillRoot, { recursive: true });
    await t.env.fs.writeFile(join(skillRoot, "SKILL.md"), "# Placeholder default\n");
    await t.env.fs.writeFile(
      join(skillRoot, "config.jsonc"),
      '{ "password": "${MISSING:-hunter2}" }\n',
    );

    const result = await plan(t.env, options(storeRoot, "skills"));

    expect(result.actions.every((action) => action.op === "skip")).toBe(true);
    expect(result.secretFindings).toContainEqual(
      expect.objectContaining({ rule: "sensitive-field" }),
    );
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it.each([
    ["array descendant", '{"token":["tiny"]}\n'],
    ["object descendant", '{"password":{"nested":"tiny"}}\n'],
  ])("15.1 preserves sensitive parent context through a %s", async (_label, content) => {
    const storeRoot = t.path("home", ".cellarer");
    const skillRoot = join(storeRoot, "store", "skills", "sensitive-descendant");
    await t.env.fs.mkdir(skillRoot, { recursive: true });
    await t.env.fs.writeFile(join(skillRoot, "SKILL.md"), "# Sensitive descendant\n");
    await t.env.fs.writeFile(join(skillRoot, "config.json"), content);

    const result = await plan(t.env, options(storeRoot, "skills"));

    expect(result.actions.every((action) => action.op === "skip")).toBe(true);
    expect(result.secretFindings).toContainEqual(
      expect.objectContaining({
        artifact: "skills/sensitive-descendant",
        source: "skills/sensitive-descendant/config.json",
        rule: "sensitive-field",
      }),
    );
    expect(JSON.stringify(result)).not.toContain("tiny");
  });

  it("16.1 blocks the complete final-staged shape matrix", async () => {
    const storeRoot = t.path("home", ".cellarer");
    const skillRoot = join(storeRoot, "store", "skills", "shape-matrix");
    await t.env.fs.mkdir(skillRoot, { recursive: true });
    await t.env.fs.writeFile(join(skillRoot, "SKILL.md"), "# Shape matrix\n");
    await t.env.fs.writeFile(
      join(skillRoot, "config.json"),
      JSON.stringify({
        AccessToken: ["tiny", 17, false, null, { nested: "tiny-object" }],
        accessToken: "tiny-camel",
        refreshToken: "tiny-refresh",
      }),
    );

    const result = await plan(t.env, options(storeRoot, "skills"));

    expect(result.actions.every((action) => action.op === "skip")).toBe(true);
    expect(result.secretFindings).toContainEqual(
      expect.objectContaining({
        artifact: "skills/shape-matrix",
        source: "skills/shape-matrix/config.json",
        rule: "sensitive-field",
      }),
    );
    const observable = JSON.stringify(result);
    for (const plaintext of ["tiny", "tiny-object", "tiny-pascal"]) {
      expect(observable).not.toContain(plaintext);
    }
  });

  it.each([
    ["reference", "reference: tiny\n"],
    ["references", "references:\n- ${ENV_VAR}\n- tiny\n"],
    ["secretRefs", "secretRefs:\n- nested:\n    value: tiny\n"],
    ["indentless sensitive sequence", "password:\n- tiny\n- ${ENV_VAR}\n"],
  ])("17.1 blocks final-staged YAML plaintext in %s", async (label, content) => {
    const storeRoot = t.path("home", ".cellarer");
    const name = label.replaceAll(" ", "-");
    const skillRoot = join(storeRoot, "store", "skills", name);
    await t.env.fs.mkdir(skillRoot, { recursive: true });
    await t.env.fs.writeFile(join(skillRoot, "SKILL.md"), "# Parser closure\n");
    await t.env.fs.writeFile(join(skillRoot, "config.yaml"), content);

    const result = await plan(t.env, options(storeRoot, "skills"));

    expect(result.actions.every((action) => action.op === "skip")).toBe(true);
    expect(result.secretFindings).toContainEqual(
      expect.objectContaining({
        artifact: `skills/${name}`,
        source: `skills/${name}/config.yaml`,
        rule: "sensitive-field",
      }),
    );
    expect(JSON.stringify(result)).not.toContain("tiny");
  });

  it.each([
    ["json", "config.json", '{"token":"tiny","token":"${CELLARER_SECRET:SAFE}"}\n'],
    [
      "jsonc",
      "config.jsonc",
      '{\n  "token": "tiny",\n  // last-wins parsers must not hide the first value\n  "token": "${CELLARER_SECRET:SAFE}",\n}\n',
    ],
  ])("15.1 rejects duplicate keys from exact %s source bytes", async (_format, file, content) => {
    const storeRoot = t.path("home", ".cellarer");
    const skillRoot = join(storeRoot, "store", "skills", `duplicate-${_format}`);
    await t.env.fs.mkdir(skillRoot, { recursive: true });
    await t.env.fs.writeFile(join(skillRoot, "SKILL.md"), "# Duplicate key\n");
    await t.env.fs.writeFile(join(skillRoot, file), content);

    const result = await plan(t.env, options(storeRoot, "skills"));

    expect(result.actions.every((action) => action.op === "skip")).toBe(true);
    expect(result.secretFindings).toContainEqual(
      expect.objectContaining({
        artifact: `skills/duplicate-${_format}`,
        source: `skills/duplicate-${_format}/${file}`,
        rule: "duplicate-key",
      }),
    );
    expect(JSON.stringify(result)).not.toContain("tiny");
  });

  it.each([
    ["jsonc", "broken.jsonc", '{\n  "outer": { "token": "safe" }\n  /* unterminated\n'],
    ["yaml", "broken.yaml", 'outer:\n  token: "unterminated\n  continuation\n'],
    ["toml", "broken.toml", '[outer]\npassword = """unterminated\ncontinuation\n'],
  ])("14.1 fails malformed multiline staged %s closed", async (_format, file, content) => {
    const storeRoot = t.path("home", ".cellarer");
    const skillRoot = join(storeRoot, "store", "skills", `malformed-${_format}`);
    await t.env.fs.mkdir(skillRoot, { recursive: true });
    await t.env.fs.writeFile(join(skillRoot, "SKILL.md"), "# Malformed\n");
    await t.env.fs.writeFile(join(skillRoot, file), content);

    const result = await plan(t.env, options(storeRoot, "skills"));

    expect(result.actions.every((action) => action.op === "skip")).toBe(true);
    expect(result.secretFindings).toContainEqual(
      expect.objectContaining({ rule: "structured-parse-error" }),
    );
  });

  it("rechecks the recursive tree immediately before apply and writes no target", async () => {
    const fixture = FIXTURES[2];
    const storeRoot = await seedFixture(t, fixture, "safe fixture");
    const opts = { ...options(storeRoot, fixture.capability), method: "copy" as const };
    const prepared = await planApplyMutation(t.env, opts);
    await seedFixture(t, fixture, PROBABLE_CREDENTIAL);

    await expect(
      applyMutationPlan(t.env, prepared.mutationPlan, { storeRoot, options: opts }),
    ).resolves.toMatchObject({ operation: { ok: false, conflict: { code: "INVALID_PLAN" } } });
    expect(
      await readFileOrNull(
        t.env,
        t.path("home", ".claude", "skills", "leaky", "nested", "examples", "fixture.txt"),
      ),
    ).toBeNull();
  });

  it("fails closed when a staged Skill contains a symlink", async () => {
    const fixture = FIXTURES[2];
    const storeRoot = await seedFixture(t, fixture, "safe fixture");
    const linked = join(storeRoot, "store", "skills", "leaky", "nested", "linked.txt");
    await t.env.fs.symlink(fixture.source, linked, "file");

    const result = await plan(t.env, options(storeRoot, fixture.capability));
    expect(result.actions.every((action) => action.op === "skip")).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/symbolic-link/);
  });

  it("fails closed when a staged Skill contains a non-regular entry", async () => {
    const fixture = FIXTURES[2];
    const storeRoot = await seedFixture(t, fixture, "safe fixture");
    const other = join(storeRoot, "store", "skills", "leaky", "nested", "device");
    await t.env.fs.writeFile(other, "safe");
    const snapshotTreeNoFollow = t.env.fs.snapshotTreeNoFollow;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        snapshotTreeNoFollow: async (path: string) => {
          if (path === join(storeRoot, "store", "skills", "leaky")) {
            throw Object.assign(new Error("non regular"), {
              code: "CELLARER_SNAPSHOT_NON_REGULAR",
              path: other,
            });
          }
          return snapshotTreeNoFollow(path);
        },
      },
    };

    const result = await plan(env, options(storeRoot, fixture.capability));
    expect(result.actions.every((action) => action.op === "skip")).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/non-regular/);
  });

  it("fails closed when a staged Skill entry cannot be read", async () => {
    const fixture = FIXTURES[2];
    const storeRoot = await seedFixture(t, fixture, "safe fixture");
    const unreadable = join(storeRoot, "store", fixture.source);
    const snapshotTreeNoFollow = t.env.fs.snapshotTreeNoFollow;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        snapshotTreeNoFollow: async (path: string) => {
          if (path === join(storeRoot, "store", "skills", "leaky")) {
            throw Object.assign(new Error("raw read error"), {
              code: "EACCES",
              path: unreadable,
            });
          }
          return snapshotTreeNoFollow(path);
        },
      },
    };

    const result = await plan(env, options(storeRoot, fixture.capability));
    expect(result.actions.every((action) => action.op === "skip")).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/unreadable/);
  });

  it("validates the signed source under the mutation lock before creating a target", async () => {
    const fixture = FIXTURES[2];
    const storeRoot = await seedFixture(t, fixture, "safe fixture");
    const opts = { ...options(storeRoot, fixture.capability), method: "copy" as const };
    const prepared = await planApplyMutation(t.env, opts);
    const writeFileExclusive = t.env.fs.writeFileExclusive;
    let changed = false;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        writeFileExclusive: async (path: string, data: string, mode?: { mode?: number }) => {
          if (!changed && path.endsWith("mutation.lock")) {
            changed = true;
            await t.env.fs.writeFile(join(storeRoot, "store", fixture.source), PROBABLE_CREDENTIAL);
          }
          return writeFileExclusive(path, data, mode);
        },
      },
    };

    await expect(
      applyMutationPlan(env, prepared.mutationPlan, { storeRoot, options: opts }),
    ).rejects.toThrow(/recursive secret guard|source changed/i);
    await expect(
      readFileOrNull(
        t.env,
        t.path("home", ".claude", "skills", "leaky", "nested", "examples", "fixture.txt"),
      ),
    ).resolves.toBeNull();
  });

  it("does not create a target when a validated Skill source is replaced before placement", async () => {
    const fixture = FIXTURES[2];
    const storeRoot = await seedFixture(t, fixture, "safe fixture");
    const sourceRoot = join(storeRoot, "store", "skills", "leaky");
    const targetRoot = t.path("home", ".claude", "skills", "leaky");
    const opts = {
      ...options(storeRoot, fixture.capability),
      method: "copy" as const,
    };
    const prepared = await planApplyMutation(t.env, opts);
    const publishFileAtomically = t.env.fs.publishFileAtomically;
    let replaced = false;
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        publishFileAtomically: async (path: string, data: string, opts?: { mode?: number }) => {
          await publishFileAtomically(path, data, opts);
          if (
            !replaced &&
            path.endsWith("operations/active.json") &&
            data.includes('"status": "executing"')
          ) {
            replaced = true;
            await t.env.fs.rm(sourceRoot, { recursive: true, force: true });
            await t.env.fs.mkdir(sourceRoot, { recursive: true });
            await t.env.fs.writeFile(join(sourceRoot, "SKILL.md"), "replacement");
          }
        },
      },
    };

    const result = await applyMutationPlan(env, prepared.mutationPlan, {
      storeRoot,
      options: opts,
    });

    expect(result.operation).toMatchObject({ ok: false });
    await expect(t.env.fs.lstat(targetRoot)).rejects.toThrow();
  });

  it("fails before journal or target creation when the apply provider scope becomes unavailable", async () => {
    const storeRoot = t.path("home", ".cellarer");
    const target = t.path("home", ".claude", "CLAUDE.md");
    let providerAvailable = true;
    t.env.secretStore = {
      async get() {
        return providerAvailable
          ? { found: true as const, value: "tiny" }
          : { error: "locked" as const };
      },
      async set() {},
      async delete() {
        return false;
      },
    };
    await writeRuleArtifact(
      t.env,
      storeRoot,
      "scoped",
      "# Scoped provider\n${CELLARER_SECRET:SCOPED}\n",
    );
    const opts = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["rules" as const],
      secretMode: "keychain" as const,
    };
    const prepared = await planApplyMutation(t.env, opts);
    providerAvailable = false;

    await expect(
      applyMutationPlan(t.env, prepared.mutationPlan, {
        storeRoot,
        options: opts,
        secretMode: "keychain",
      }),
    ).rejects.toMatchObject({ code: "SECRET_PROVIDER_SCOPE_UNAVAILABLE" });
    await expect(readFileOrNull(t.env, target)).resolves.toBeNull();
    await expect(
      readFileOrNull(t.env, join(storeRoot, "operations", "active.json")),
    ).resolves.toBeNull();
  });

  it("does not discover provider values from an explicit skip action", async () => {
    const storeRoot = t.path("home", ".cellarer");
    const config = parseConfig(await initialConfigText(t.env));
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
    const skipped: PlanAction = {
      artifact: "mcp/skipped",
      artifactIds: ["mcp/skipped"],
      agent: "reference-native",
      scope: "global",
      capability: "mcp",
      target: t.path("home", ".reference-native", "mcp.json"),
      method: "copy",
      op: "skip",
      reason: "not executable",
      preview: { after: "$" + "{CELLARER_SECRET:SKIPPED}" },
    };

    const active = await discoverActiveSecretValuesForActions(t.env, [skipped], {
      storeRoot,
      config,
      secretMode: "keychain",
    });

    expect(active).toEqual([]);
    expect(reads).toBe(0);
  });
});

describe("versioned secret-pattern suppressions", () => {
  let t: TmpEnv;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });

  afterEach(() => t.cleanup());

  async function configureSuppression(
    storeRoot: string,
    suppression: { source: string; rule: string; patternVersion: number },
  ): Promise<void> {
    const config = parseConfig(await initialConfigText(t.env));
    config.artifacts["skills/leaky"] = {
      collections: [],
      secretPatternSuppressions: [suppression],
    };
    await t.env.fs.writeFile(
      join(storeRoot, "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );
  }

  it("honors only an exact artifact, source, rule, and pattern-version match", async () => {
    const fixture = FIXTURES[2];
    const storeRoot = await seedFixture(t, fixture, PROBABLE_CREDENTIAL);
    await configureSuppression(storeRoot, {
      source: fixture.source,
      rule: "github-pat",
      patternVersion: 1,
    });

    const result = await plan(t.env, options(storeRoot, fixture.capability));
    expect(result.secretFindings).toBeUndefined();
    expect(result.actions[0]?.op).not.toBe("skip");
  });

  it("does not let a pattern suppression bypass structured MCP argument detection", async () => {
    const fixture = FIXTURES[1];
    const storeRoot = await seedFixture(t, fixture, PROBABLE_CREDENTIAL);
    const config = parseConfig(await initialConfigText(t.env));
    config.artifacts[fixture.artifactId] = {
      collections: [],
      secretPatternSuppressions: [
        {
          source: fixture.source,
          rule: "github-pat",
          patternVersion: 1,
        },
      ],
    };
    await t.env.fs.writeFile(
      join(storeRoot, "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
    );

    const result = await plan(t.env, options(storeRoot, fixture.capability));
    expect(result.secretFindings).toContainEqual(
      expect.objectContaining({ rule: "command-secret-argument", patternVersion: 1 }),
    );
    expect(result.actions[0]?.op).toBe("skip");
  });

  it.each([
    ["source", { source: "skills/leaky/other.txt", rule: "github-pat", patternVersion: 1 }],
    ["rule", { source: FIXTURES[2].source, rule: "gitlab-pat", patternVersion: 1 }],
    ["version", { source: FIXTURES[2].source, rule: "github-pat", patternVersion: 2 }],
  ] as const)("does not broaden a suppression with the wrong %s", async (_label, suppression) => {
    const fixture = FIXTURES[2];
    const storeRoot = await seedFixture(t, fixture, PROBABLE_CREDENTIAL);
    await configureSuppression(storeRoot, suppression);

    const result = await plan(t.env, options(storeRoot, fixture.capability));
    expect(result.secretFindings?.[0]).toMatchObject({
      artifact: fixture.artifactId,
      source: fixture.source,
      rule: "github-pat",
      patternVersion: 1,
    });
  });

  it("rejects every global plaintext bypass shape", () => {
    expect(() => parseConfig(JSON.stringify({ allowResolvedPlaintext: true }))).toThrow();
    expect(() =>
      parseConfig(JSON.stringify({ defaults: { allowResolvedPlaintext: true } })),
    ).toThrow();
    expect(() =>
      parseConfig(JSON.stringify({ secretPatternSuppressions: [{ rule: "github-pat" }] })),
    ).toThrow();
  });
});
