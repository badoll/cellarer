import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("inventory subprocess client API exists", async () => {
  const client = await import("./cellarer-client.mjs").catch(() => null);
  assert.notEqual(client, null, "cellarer subprocess client module must exist");
  assert.equal(typeof client.createCellarerClient, "function");
});

test("inventory and store import journey API exists", async () => {
  const journey = await import("./resource-journey.mjs").catch(() => null);
  assert.notEqual(journey, null, "resource journey module must exist");
  assert.equal(typeof journey.runResourceJourney, "function");
});

test("inventory and store import complete through replacement CLI processes", {
  skip: process.env.CELLARER_E2E_BIN ? false : "installed command is supplied by e2e:resources",
}, async () => {
  const { runResourceJourney } = await import("./resource-journey.mjs");
  const result = await runResourceJourney({
    command: process.env.CELLARER_E2E_BIN,
    consumerRoot: process.env.CELLARER_E2E_CONSUMER_ROOT,
    repositoryRoot,
    baseEnvironment: process.env,
    mode: process.env.CELLARER_E2E_MODE ?? "fixture",
    skillsPool: process.env.CELLARER_E2E_SKILLS_POOL,
  });

  assert.equal(result.status, "passed");
  assert.equal(result.inventory.readyKinds.join(","), "mcp,rules,skills");
  assert.equal(result.import.targetCount, 0);
});

test("inventory subprocess client accepts only an installed command and records closed evidence", async (t) => {
  const { createCellarerClient } = await import("./cellarer-client.mjs");
  const root = await fs.mkdtemp(join(tmpdir(), "cellarer-client-e2e-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const consumerRoot = join(root, "consumer");
  const command = join(consumerRoot, "node_modules", ".bin", "cellarer");
  const workingRoot = join(root, "test-root");
  await fs.mkdir(dirname(command), { recursive: true });
  await fs.mkdir(workingRoot);
  await fs.writeFile(
    command,
    `#!${process.execPath}\n` +
      `const args = process.argv.slice(2);\n` +
      `const start = args.indexOf("--non-interactive") + 1;\n` +
      `const rest = args.slice(start);\n` +
      `const identity = rest[0] === "inventory" ? rest.slice(0, rest[1] === "refresh" ? 2 : 3).join(".") : rest[0];\n` +
      `const rejected = rest.includes("missing-selection");\n` +
      `const envelope = rejected\n` +
      `  ? { protocolVersion: "1.0", command: identity, status: "error", error: { code: "INVALID_INPUT", message: "rejected" }, warnings: [] }\n` +
      `  : { protocolVersion: "1.0", command: identity, status: "success", data: { marker: "fixture" }, warnings: [] };\n` +
      `process.stdout.write(JSON.stringify(envelope) + "\\n");\n` +
      `process.exitCode = rejected ? 2 : 0;\n`,
    "utf8",
  );
  await fs.chmod(command, 0o755);

  const client = await createCellarerClient({
    command,
    consumerRoot,
    repositoryRoot,
    cwd: workingRoot,
    env: { ...process.env },
    testRoot: root,
  });
  const success = await client.invoke("inventory.refresh", ["inventory", "refresh"]);
  assert.equal(success.exitClass, "success");
  assert.deepEqual(success.envelope.data, { marker: "fixture" });
  assert.deepEqual(success.evidence, {
    command: "inventory.refresh",
    exitClass: "success",
    exitCode: 0,
    stdout: "protocol-json",
    stderr: "empty",
  });

  const rejected = await client.invoke("inventory.import.plan", [
    "inventory",
    "import",
    "plan",
    "missing-selection",
  ]);
  assert.equal(rejected.exitClass, "domain-error");
  assert.equal(rejected.envelope.error.code, "INVALID_INPUT");
  assert.equal(rejected.evidence.stderr, "empty");

  await assert.rejects(
    createCellarerClient({
      command: join(repositoryRoot, "packages", "cli", "dist", "bin.js"),
      consumerRoot: repositoryRoot,
      repositoryRoot,
      cwd: workingRoot,
      env: { ...process.env },
      testRoot: root,
    }),
    /workspace source/,
  );
});
