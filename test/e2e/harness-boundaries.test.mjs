import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("isolated resource harness exposes its boundary API", async () => {
  const harness = await import("./harness-boundaries.mjs").catch(() => null);

  assert.notEqual(harness, null, "harness boundary module must exist");
  for (const name of [
    "assertInside",
    "assertIsolatedSourcePool",
    "createHarnessLayout",
    "createIsolatedEnvironment",
    "fingerprintTree",
    "stageSkillsPool",
    "cleanHarnessOutputs",
    "runSubprocess",
    "writeClosedReport",
  ]) {
    assert.equal(typeof harness[name], "function", `${name} must be exported`);
  }
});

test("subprocess results and reports are closed, structured, and secret-safe", async (t) => {
  const harness = await import("./harness-boundaries.mjs");
  const repositoryRoot = await fs.mkdtemp(join(tmpdir(), "cellarer-harness-report-"));
  t.after(() => fs.rm(repositoryRoot, { recursive: true, force: true }));
  await fs.mkdir(join(repositoryRoot, "test"));
  const layout = harness.createHarnessLayout(repositoryRoot);

  const succeeded = await harness.runSubprocess({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("ok\\n")'],
    cwd: layout.testRoot,
    env: { ...process.env },
    testRoot: layout.testRoot,
  });
  assert.deepEqual(succeeded, { code: 0, signal: null, stdout: "ok\n", stderr: "" });

  const failed = await harness.runSubprocess({
    command: process.execPath,
    args: ["-e", 'process.stderr.write("expected failure\\n"); process.exit(7)'],
    cwd: layout.testRoot,
    env: { ...process.env },
    allowFailure: true,
    testRoot: layout.testRoot,
  });
  assert.equal(failed.code, 7);
  await assert.rejects(
    harness.runSubprocess({
      command: process.execPath,
      args: ["-e", "process.exit(8)"],
      cwd: layout.testRoot,
      env: { ...process.env },
      testRoot: layout.testRoot,
    }),
    /subprocess failed with exit code 8/,
  );

  const reportPath = await harness.writeClosedReport({
    layout,
    name: "fixture-report.json",
    report: {
      mode: "fixture",
      status: "passed",
      phases: [{ id: "boundary", status: "passed" }],
      assertions: [{ id: "source-unchanged", passed: true }],
      skips: [],
    },
    secretCanaries: ["never-write-this-secret"],
  });
  assert.equal(reportPath, join(layout.reportsRoot, "fixture-report.json"));
  assert.deepEqual(JSON.parse(await fs.readFile(reportPath, "utf8")), {
    schemaVersion: 1,
    mode: "fixture",
    status: "passed",
    phases: [{ id: "boundary", status: "passed" }],
    assertions: [{ id: "source-unchanged", passed: true }],
    skips: [],
  });
  await assert.rejects(
    harness.writeClosedReport({
      layout,
      name: "unsafe.json",
      report: {
        mode: "fixture",
        status: "failed",
        phases: [],
        assertions: [{ id: "failure", passed: false, detail: "never-write-this-secret" }],
        skips: [],
      },
      secretCanaries: ["never-write-this-secret"],
    }),
    /secret canary/,
  );
  await assert.rejects(
    harness.writeClosedReport({
      layout,
      name: "../outside.json",
      report: { mode: "fixture", status: "passed", phases: [], assertions: [], skips: [] },
      secretCanaries: [],
    }),
    /report name/,
  );
});

test("layout and environment stay inside the canonical test root", async (t) => {
  const harness = await import("./harness-boundaries.mjs");
  const repositoryRoot = await fs.mkdtemp(join(tmpdir(), "cellarer-harness-layout-"));
  t.after(() => fs.rm(repositoryRoot, { recursive: true, force: true }));
  await fs.mkdir(join(repositoryRoot, "test"));

  const layout = harness.createHarnessLayout(repositoryRoot);

  assert.equal(layout.testRoot, await fs.realpath(join(repositoryRoot, "test")));
  for (const [name, path] of Object.entries(layout)) {
    if (name === "repositoryRoot" || !name.endsWith("Root")) continue;
    assert.equal(harness.assertInside(layout.testRoot, path, name), path);
  }
  assert.throws(
    () => harness.assertInside(layout.testRoot, join(repositoryRoot, "outside"), "outside"),
    /escapes the isolated test root/,
  );

  const env = harness.createIsolatedEnvironment(
    {
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      HOME: "/real-home",
      NODE_PATH: "/workspace/node_modules",
      REAL_API_TOKEN: "must-not-be-inherited",
    },
    layout,
    "test-authority",
  );
  assert.equal(env.HOME, layout.homeRoot);
  assert.equal(env.CELLARER_HOME, layout.storeRoot);
  assert.equal(env.TMPDIR, layout.tempRoot);
  assert.equal(env.XDG_CONFIG_HOME, join(layout.homeRoot, ".config"));
  assert.equal(env.XDG_DATA_HOME, join(layout.homeRoot, ".local", "share"));
  assert.equal(env.XDG_CACHE_HOME, join(layout.homeRoot, ".cache"));
  assert.equal(env.CELLARER_MUTATION_AUTHORITY, "test-authority");
  assert.equal(env.NODE_PATH, "");
  assert.equal(env.CI, "true");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.REAL_API_TOKEN, undefined);
});

test("skill pool staging copies bytes without following links or mutating the source", async (t) => {
  const harness = await import("./harness-boundaries.mjs");
  const repositoryRoot = await fs.mkdtemp(join(tmpdir(), "cellarer-harness-stage-"));
  t.after(() => fs.rm(repositoryRoot, { recursive: true, force: true }));
  const sourceRoot = join(repositoryRoot, "pool");
  const testRoot = join(repositoryRoot, "test");
  const destinationRoot = join(testRoot, ".sandbox", "source", "skills");
  await fs.mkdir(join(sourceRoot, "valid-skill", "references"), { recursive: true });
  await fs.mkdir(testRoot);
  await fs.writeFile(join(sourceRoot, "valid-skill", "SKILL.md"), "# Valid skill\n", "utf8");
  await fs.writeFile(join(sourceRoot, "valid-skill", "references", "note.md"), "fixture\n", "utf8");

  const before = await harness.fingerprintTree(sourceRoot);
  const result = await harness.stageSkillsPool({ sourceRoot, destinationRoot, testRoot });
  const after = await harness.fingerprintTree(sourceRoot);

  assert.deepEqual(after, before);
  assert.deepEqual(result.sourceBefore, before);
  assert.deepEqual(result.sourceAfter, before);
  assert.equal(result.staged.hash, before.hash);
  assert.equal(
    await fs.readFile(join(destinationRoot, "valid-skill", "SKILL.md"), "utf8"),
    "# Valid skill\n",
  );

  const linkedPool = join(repositoryRoot, "linked-pool");
  const linkedDestination = join(testRoot, ".sandbox", "linked-skills");
  await fs.mkdir(join(linkedPool, "blocked"), { recursive: true });
  await fs.symlink(
    join(sourceRoot, "valid-skill", "SKILL.md"),
    join(linkedPool, "blocked", "SKILL.md"),
  );
  await assert.rejects(
    harness.stageSkillsPool({
      sourceRoot: linkedPool,
      destinationRoot: linkedDestination,
      testRoot,
    }),
    /symbolic link/,
  );
  await assert.rejects(fs.access(linkedDestination));

  const overlappingPool = join(testRoot, "overlapping-pool");
  await fs.mkdir(join(overlappingPool, "skill"), { recursive: true });
  await fs.writeFile(join(overlappingPool, "skill", "SKILL.md"), "# Overlap\n", "utf8");
  await assert.rejects(
    harness.stageSkillsPool({
      sourceRoot: overlappingPool,
      destinationRoot: overlappingPool,
      testRoot,
    }),
    /overlap/,
  );
  await assert.rejects(
    harness.stageSkillsPool({
      sourceRoot: overlappingPool,
      destinationRoot: join(overlappingPool, "nested-staging"),
      testRoot,
    }),
    /overlap/,
  );
  const layout = harness.createHarnessLayout(repositoryRoot);
  assert.equal(harness.assertIsolatedSourcePool(sourceRoot, layout), await fs.realpath(sourceRoot));
  assert.throws(
    () => harness.assertIsolatedSourcePool(join(testRoot, ".sandbox"), layout),
    /overlap/,
  );
});

test("cleanup removes only declared generated outputs", async (t) => {
  const harness = await import("./harness-boundaries.mjs");
  const repositoryRoot = await fs.mkdtemp(join(tmpdir(), "cellarer-harness-clean-"));
  t.after(() => fs.rm(repositoryRoot, { recursive: true, force: true }));
  await fs.mkdir(join(repositoryRoot, "test", "e2e"), { recursive: true });
  await fs.writeFile(join(repositoryRoot, "test", "e2e", "tracked.test.mjs"), "tracked\n");
  const outside = join(repositoryRoot, "outside.txt");
  await fs.writeFile(outside, "outside\n");
  const layout = harness.createHarnessLayout(repositoryRoot);
  await fs.writeFile(join(layout.testRoot, "CLAUDE.md"), "unknown\n");
  await assert.rejects(harness.cleanHarnessOutputs(layout), /refusing to clean unknown/);
  assert.equal(await fs.readFile(join(layout.testRoot, "CLAUDE.md"), "utf8"), "unknown\n");
  await fs.rm(join(layout.testRoot, "CLAUDE.md"));

  await harness.cleanHarnessOutputs(layout);
  assert.equal(await fs.readFile(layout.ownerMarkerPath, "utf8"), "cellarer-resource-e2e-v1\n");
  const generatedFiles = new Set([
    join(layout.testRoot, "CLAUDE.md"),
    join(layout.testRoot, "AGENTS.md"),
    join(layout.testRoot, ".mcp.json"),
    join(layout.testRoot, ".gitignore"),
  ]);
  for (const path of layout.cleanupPaths) {
    if (path === layout.sandboxRoot) continue;
    await fs.mkdir(generatedFiles.has(path) ? join(path, "..") : path, { recursive: true });
    if (generatedFiles.has(path)) await fs.writeFile(path, "generated\n");
  }

  await harness.cleanHarnessOutputs(layout);

  assert.equal(
    await fs.readFile(join(repositoryRoot, "test", "e2e", "tracked.test.mjs"), "utf8"),
    "tracked\n",
  );
  assert.equal(await fs.readFile(outside, "utf8"), "outside\n");
  assert.equal(await fs.readFile(layout.ownerMarkerPath, "utf8"), "cellarer-resource-e2e-v1\n");
  for (const path of layout.cleanupPaths) {
    if (path !== layout.sandboxRoot) await assert.rejects(fs.access(path));
  }
});

test("resource fixtures declare deterministic rules, MCP, skills, and test-only adapters", async () => {
  const fixtureRoot = join(repositoryRoot, "test", "fixtures");
  const rules = await fs.readFile(join(fixtureRoot, "source", "RULES.md"), "utf8");
  const mcp = JSON.parse(await fs.readFile(join(fixtureRoot, "source", "mcp.json"), "utf8"));
  const validSkill = await fs.readFile(
    join(fixtureRoot, "skills-pool", "valid-skill", "SKILL.md"),
    "utf8",
  );
  const blockedSkill = await fs.readdir(join(fixtureRoot, "skills-pool", "blocked-skill"));
  const sourceAdapter = JSON.parse(
    await fs.readFile(join(fixtureRoot, "adapters", "pool-source.json"), "utf8"),
  );
  const codebuddyAdapter = JSON.parse(
    await fs.readFile(join(fixtureRoot, "adapters", "codebuddy-e2e.json"), "utf8"),
  );

  assert.match(rules, /CELLARER_RESOURCE_E2E_RULE/);
  assert.deepEqual(mcp, {
    mcpServers: {
      "fixture-stdio": {
        command: "node",
        args: ["--version"],
      },
    },
  });
  assert.match(validSkill, /^---\nname: valid-skill\ndescription: /);
  assert.equal(blockedSkill.includes("SKILL.md"), false);
  assert.deepEqual(sourceAdapter.capabilities, {
    rules: ["project"],
    mcp: ["project"],
    skills: ["project"],
  });
  assert.equal(sourceAdapter.rules.project, "{dir}/.sandbox/source/RULES.md");
  assert.equal(sourceAdapter.mcp.project, "{dir}/.sandbox/source/mcp.json");
  assert.equal(sourceAdapter.skills.project, "{dir}/.sandbox/source/skills");
  assert.equal(codebuddyAdapter.displayName, "CodeBuddy (E2E fixture only)");
  assert.equal(codebuddyAdapter.rules.project, "{dir}/.codebuddy/RULES.md");
  assert.equal(codebuddyAdapter.mcp.project, "{dir}/.codebuddy/mcp.json");
  assert.equal(codebuddyAdapter.skills.project, "{dir}/.codebuddy/skills");
});
