import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, promises as fs, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cellarer-profile-e2e-")));
const home = join(root, "home");
const project = join(root, "project");
const store = join(root, "store");
const consumer = join(root, "consumer");
let calls = 0;
try {
  for (const directory of [home, project, consumer]) await fs.mkdir(directory, { recursive: true });
  // Execute copied distribution artifacts outside the checkout. Only third-party runtime
  // dependencies are linked from the existing installation; no source module is loaded.
  for (const name of ["core", "web", "cli"]) {
    const source = join(repository, "packages", name);
    const target = join(consumer, name);
    await fs.mkdir(target, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(join(source, "package.json"), "utf8"));
    await fs.copyFile(join(source, "package.json"), join(target, "package.json"));
    for (const path of manifest.files)
      await fs.cp(join(source, path), join(target, path), { recursive: true });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const link = join(target, "node_modules", dependency);
      await fs.mkdir(dirname(link), { recursive: true });
      const resolved = dependency.startsWith("@cellarer/")
        ? join(consumer, dependency.slice(10))
        : await fs.realpath(join(source, "node_modules", dependency));
      await fs.symlink(resolved, link);
    }
  }
  const passphrase = join(root, "snapshot-passphrase");
  await fs.writeFile(passphrase, "isolated-fixture-passphrase\n", { mode: 0o600 });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CELLARER_HOME: store,
    CELLARER_MUTATION_AUTHORITY: `v1:1:${Buffer.alloc(32, 0x39).toString("base64url")}`,
  };
  const invoke = (args, snapshot = false) => {
    const fd = snapshot ? openSync(passphrase, "r") : undefined;
    try {
      const result = spawnSync(
        process.execPath,
        [
          join(consumer, "cli/dist/bin.js"),
          "--output",
          "json",
          "--non-interactive",
          ...args,
          ...(snapshot ? ["--snapshot-passphrase-fd", "3"] : []),
        ],
        {
          cwd: project,
          env,
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe", ...(fd === undefined ? [] : [fd])],
        },
      );
      calls++;
      assert.equal(
        result.status,
        0,
        `${args.slice(0, 2).join(" ")}: ${result.stdout}\n${result.stderr}`,
      );
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.status, "success");
      return envelope.data;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  invoke(["init"]);
  for (const name of ["a", "b"]) {
    await fs.writeFile(
      join(store, "store/mcp", `${name}.json`),
      JSON.stringify({ command: `fixture-${name}-never-executed` }),
    );
    await fs.mkdir(join(store, "store/skills", name), { recursive: true });
    await fs.writeFile(join(store, "store/skills", name, "SKILL.md"), `# ${name}\n`);
  }
  const desired = {
    agentIds: ["claude-code"],
    scope: "project",
    resourceIds: ["mcp/a", "mcp/b"],
    collectionIds: [],
    capabilities: ["mcp"],
    method: "copy",
    mergePolicy: "merge",
  };
  const native = join(project, ".mcp.json");
  await fs.writeFile(
    native,
    JSON.stringify({
      mcpServers: { c: { command: "user-c-never-executed" } },
      userField: "preserved",
    }),
  );
  const unowned = join(project, "untouched.txt");
  await fs.writeFile(unowned, "do not change\n");
  invoke(["profile", "create", "mcp", "--desired", JSON.stringify(desired)]);
  const blocked = invoke(["sync", "plan", "mcp", "--workspace-root", project]);
  const token = blocked.plan.conflicts[0].acknowledgement.token;
  const initial = invoke(
    ["sync", "plan", "mcp", "--workspace-root", project, "--replace-unowned", token],
    true,
  );
  assert.equal(initial.mutationPlan.operation, "sync-reconcile");
  invoke(
    [
      "sync",
      "apply",
      "mcp",
      "--workspace-root",
      project,
      "--replace-unowned",
      token,
      "--plan",
      JSON.stringify(initial.mutationPlan),
    ],
    true,
  );
  const originalBytes = await fs.readFile(native, "utf8");
  invoke([
    "profile",
    "update",
    "mcp",
    "--desired",
    JSON.stringify({ ...desired, resourceIds: ["mcp/a"] }),
  ]);
  assert.equal(await fs.readFile(native, "utf8"), originalBytes);
  const next = invoke(["sync", "plan", "mcp", "--workspace-root", project]);
  assert(
    next.mutationPlan.normalizedInputs.reconciliation.changes.some(
      (item) => item.selector === "b" && item.outcome === "remove",
    ),
  );
  invoke([
    "sync",
    "apply",
    "mcp",
    "--workspace-root",
    project,
    "--plan",
    JSON.stringify(next.mutationPlan),
  ]);
  const nativeAfter = JSON.parse(await fs.readFile(native, "utf8"));
  assert.deepEqual(Object.keys(nativeAfter.mcpServers).sort(), ["a", "c"]);
  assert.equal(nativeAfter.userField, "preserved");
  const beforeNoOp = (await fs.stat(native)).mtimeMs;
  const repeat = invoke(["sync", "plan", "mcp", "--workspace-root", project]);
  invoke([
    "sync",
    "apply",
    "mcp",
    "--workspace-root",
    project,
    "--plan",
    JSON.stringify(repeat.mutationPlan),
  ]);
  assert.equal((await fs.stat(native)).mtimeMs, beforeNoOp);
  invoke(["sync", "verify", "mcp", "--workspace-root", project]);
  const skills = {
    ...desired,
    agentIds: ["codex", "agents-md"],
    resourceIds: ["skills/a", "skills/b"],
    capabilities: ["skills"],
    method: "symlink",
  };
  invoke(["profile", "create", "skills", "--desired", JSON.stringify(skills)]);
  const applyProfile = (id) => {
    const planned = invoke(["sync", "plan", id, "--workspace-root", project]);
    invoke([
      "sync",
      "apply",
      id,
      "--workspace-root",
      project,
      "--plan",
      JSON.stringify(planned.mutationPlan),
    ]);
  };
  applyProfile("skills");
  invoke([
    "profile",
    "update",
    "skills",
    "--desired",
    JSON.stringify({ ...skills, agentIds: ["codex"], resourceIds: ["skills/a"] }),
  ]);
  applyProfile("skills");
  const state = JSON.parse(await fs.readFile(join(store, "state.json"), "utf8"));
  const skillRecords = state.deployments.filter((item) => item.capability === "skills");
  assert.equal(skillRecords.length, 1);
  assert.deepEqual(
    skillRecords[0].consumers.map((item) => item.agent),
    ["codex"],
  );
  assert.equal(await fs.readFile(join(store, "store/skills/b/SKILL.md"), "utf8"), "# b\n");
  assert.equal(await fs.readFile(unowned, "utf8"), "do not change\n");
  console.log(
    JSON.stringify({
      status: "passed",
      artifactRoot: consumer,
      calls,
      journeys: [
        "MCP A+B to A with unmanaged C",
        "Store-only edit",
        "zero-write repeat",
        "Skill removal and shared Agent exit",
        "unmanaged file and source preserved",
      ],
    }),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
