import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { createCellarerClient } from "./cellarer-client.mjs";
import {
  assertInside,
  assertIsolatedSourcePool,
  cleanHarnessOutputs,
  createHarnessLayout,
  createIsolatedEnvironment,
  fingerprintTree,
  stageSkillsPool,
  writeClosedReport,
} from "./harness-boundaries.mjs";

const mutationAuthority = `v1:1:${Buffer.alloc(32, 0x37).toString("base64url")}`;
const secretCanary = "CELLARER_RESOURCE_E2E_SECRET_CANARY_DO_NOT_DISCLOSE";

export async function runResourceJourney({
  command,
  consumerRoot,
  repositoryRoot,
  baseEnvironment = process.env,
  mode = "fixture",
  skillsPool,
  inspectSidecar,
}) {
  if (!command || !consumerRoot)
    throw new Error("installed command and consumer root are required");
  if (!["fixture", "real-pool"].includes(mode)) throw new Error(`unsupported E2E mode: ${mode}`);
  const layout = createHarnessLayout(repositoryRoot);
  const fixtureRoot = join(layout.testRoot, "fixtures");
  const sourcePool = assertIsolatedSourcePool(
    mode === "fixture" ? join(fixtureRoot, "skills-pool") : requireAbsolutePool(skillsPool),
    layout,
  );
  const [fixtureBefore, sourceBeforeCleanup] = await Promise.all([
    fingerprintTree(fixtureRoot),
    fingerprintTree(sourcePool),
  ]);
  await cleanHarnessOutputs(layout);
  const evidence = [];
  const assertions = [];
  const skips = [];

  try {
    await fs.mkdir(layout.sourceRoot, { recursive: true });
    await fs.mkdir(layout.homeRoot, { recursive: true });
    await fs.mkdir(layout.tempRoot, { recursive: true });
    await fs.copyFile(join(fixtureRoot, "source", "RULES.md"), join(layout.sourceRoot, "RULES.md"));
    await fs.copyFile(join(fixtureRoot, "source", "mcp.json"), join(layout.sourceRoot, "mcp.json"));
    const stagedPool = await stageSkillsPool({
      sourceRoot: sourcePool,
      destinationRoot: layout.stagedSkillsRoot,
      testRoot: layout.testRoot,
    });
    assert.equal(stagedPool.sourceBefore.hash, sourceBeforeCleanup.hash);
    evidence.push({
      id: "source-staging",
      status: "passed",
      sourceFingerprint: stagedPool.sourceBefore.hash,
      stagedFingerprint: stagedPool.staged.hash,
    });
    assertions.push({ id: "skills-source-unchanged-after-staging", passed: true });
    const env = createIsolatedEnvironment(baseEnvironment, layout, mutationAuthority);
    const client = await createCellarerClient({
      command,
      consumerRoot,
      repositoryRoot: layout.repositoryRoot,
      cwd: layout.testRoot,
      env,
      testRoot: layout.testRoot,
    });

    const dryRun = requireSuccess(
      await client.invoke("init", ["init", "--dry-run"]),
      "init dry-run",
    );
    assert.equal(dryRun.data.dryRun, true);
    assert.equal(await exists(layout.storeRoot), false, "init dry-run created Store state");
    evidence.push({ id: "init-dry-run", status: "passed" });

    const initialized = requireSuccess(await client.invoke("init", ["init"]), "machine init");
    assert.equal(initialized.data.confirmation.status, "not-offered");
    assert.equal(initialized.data.confirmation.reason, "non-interactive");
    assert.equal(initialized.data.import.status, "not-started");
    assert.equal(await exists(layout.storeRoot), true);
    evidence.push({ id: "machine-init", status: "passed" });

    const sourceAdapter = await readJson(join(fixtureRoot, "adapters", "pool-source.json"));
    const codebuddyAdapter = await readJson(join(fixtureRoot, "adapters", "codebuddy-e2e.json"));
    const sourceAdded = requireSuccess(
      await client.invoke("agent.add", [
        "agent",
        "add",
        "pool-source",
        "--adapter",
        JSON.stringify(sourceAdapter),
      ]),
      "source adapter creation",
    );
    assert.equal(sourceAdded.data.postCommitInventoryRefresh.agentId, "pool-source");
    assert.equal(sourceAdded.data.postCommitInventoryRefresh.status, "complete");
    requireSuccess(
      await client.invoke("agent.add", [
        "agent",
        "add",
        "codebuddy-e2e",
        "--adapter",
        JSON.stringify(codebuddyAdapter),
      ]),
      "CodeBuddy fixture adapter creation",
    );
    evidence.push({ id: "typed-adapters", status: "passed" });

    const refresh = requireSuccess(
      await client.invoke("inventory.refresh", [
        "inventory",
        "refresh",
        "--agent",
        "pool-source",
        "--dir",
        layout.testRoot,
      ]),
      "targeted inventory refresh",
    );
    assert.equal(refresh.data.completeness, "complete");
    const candidates = refresh.data.candidates;
    const ready = candidates.filter((candidate) => candidate.state === "ready");
    const blocked = candidates.filter((candidate) => candidate.state === "needs-attention");
    const readyKinds = [...new Set(ready.map((candidate) => candidate.kind))].sort();
    assert.deepEqual(readyKinds, ["mcp", "rules", "skills"]);
    if (mode === "fixture") {
      assert.equal(ready.length, 3, "fixture Inventory must expose exactly three ready candidates");
      assert.equal(blocked.length, 1, "fixture Inventory must expose one blocked candidate");
      assert.equal(blocked[0].kind, "skills");
      assert.equal(blocked[0].name, "blocked-skill");
      assert.equal(
        blocked[0].findings.some(({ code }) => code === "INVALID_STRUCTURE"),
        true,
      );
    } else {
      if (blocked.length > 0) {
        evidence.push({
          id: "targeted-inventory",
          status: "failed",
          completeness: refresh.data.completeness,
          blockedCandidates: blocked.map(({ id, kind, state, findings }) => ({
            id,
            kind,
            state,
            findingCodes: findings.map(({ code }) => code).sort(),
          })),
        });
      }
      assert.equal(
        blocked.length,
        0,
        `real-pool strict mode rejected ${blocked.length} non-ready candidate(s)`,
      );
    }
    evidence.push({
      id: "targeted-inventory",
      status: "passed",
      completeness: refresh.data.completeness,
      readyCandidateIds: ready.map(({ id }) => id).sort(),
      blockedCandidateIds: blocked.map(({ id }) => id).sort(),
    });

    const targetPaths = generatedTargetPaths(layout);
    const targetsBefore = await snapshotPaths(targetPaths);
    assert.equal(countPresent(targetsBefore), 0, "Agent targets existed before import planning");
    const revisionBeforeNegatives = await readOptional(join(layout.storeRoot, "revision.json"));

    if (blocked.length > 0) {
      const blockedPlan = await client.invoke("inventory.import.plan", [
        "inventory",
        "import",
        "plan",
        "--candidate",
        blocked[0].id,
        "--agent",
        "pool-source",
        "--dir",
        layout.testRoot,
      ]);
      assert.equal(blockedPlan.exitClass, "domain-error");
      await assertUnchanged(layout, revisionBeforeNegatives, targetsBefore, "blocked selection");
    }

    const missingSelection = await client.invoke("inventory.import.plan", [
      "inventory",
      "import",
      "plan",
      "--agent",
      "pool-source",
      "--dir",
      layout.testRoot,
    ]);
    assert.equal(missingSelection.exitClass, "domain-error");
    await assertUnchanged(layout, revisionBeforeNegatives, targetsBefore, "missing selection");

    const candidateIds = ready.map(({ id }) => id).sort();
    const planned = requireSuccess(
      await client.invoke("inventory.import.plan", [
        "inventory",
        "import",
        "plan",
        "--candidate",
        ...candidateIds,
        "--agent",
        "pool-source",
        "--dir",
        layout.testRoot,
        "--into-collection",
        "default",
      ]),
      "exact Store import plan",
    );
    assert.deepEqual([...planned.data.candidateIds].sort(), candidateIds);
    const negativePlanBytes = JSON.stringify(planned.data.mutationPlan);

    const alteredPlan = JSON.parse(negativePlanBytes);
    alteredPlan.baseRevision += 1;
    const altered = await client.invoke("inventory.import.apply", [
      "inventory",
      "import",
      "apply",
      "--plan",
      JSON.stringify(alteredPlan),
    ]);
    assert.equal(altered.exitClass, "domain-error");
    await assertUnchanged(layout, revisionBeforeNegatives, targetsBefore, "altered plan");

    const rulePath = join(layout.sourceRoot, "RULES.md");
    const originalRule = await fs.readFile(rulePath, "utf8");
    try {
      await fs.writeFile(rulePath, `${originalRule}\nSOURCE_DRIFT\n`, "utf8");
      const drifted = await client.invoke("inventory.import.apply", [
        "inventory",
        "import",
        "apply",
        "--plan",
        negativePlanBytes,
      ]);
      assert.equal(drifted.exitClass, "domain-error");
      await assertUnchanged(layout, revisionBeforeNegatives, targetsBefore, "source drift");
    } finally {
      await fs.writeFile(rulePath, originalRule, "utf8");
    }

    const replanned = requireSuccess(
      await client.invoke("inventory.import.plan", [
        "inventory",
        "import",
        "plan",
        "--candidate",
        ...candidateIds,
        "--agent",
        "pool-source",
        "--dir",
        layout.testRoot,
        "--into-collection",
        "default",
      ]),
      "Store import replan after restored source identity",
    );
    assert.deepEqual([...replanned.data.candidateIds].sort(), candidateIds);
    const planBytes = JSON.stringify(replanned.data.mutationPlan);
    const evidenceRoot = join(layout.sandboxRoot, "evidence");
    await fs.mkdir(evidenceRoot, { recursive: true });
    const planPath = join(evidenceRoot, "inventory-import-plan.json");
    await fs.writeFile(planPath, planBytes, "utf8");
    const persistedPlanBytes = await fs.readFile(planPath, "utf8");
    assert.equal(persistedPlanBytes, planBytes);

    const imported = requireSuccess(
      await client.invoke("inventory.import.apply", [
        "inventory",
        "import",
        "apply",
        "--plan",
        persistedPlanBytes,
      ]),
      "unchanged Store import apply",
    );
    assert.equal(imported.data.operation.receipt.outcome, "committed");
    assert.deepEqual(
      [...imported.data.resourceIds].sort(),
      ready.map(({ kind, name }) => `${kind}/${name}`).sort(),
    );
    assert.equal(imported.data.resourceIds.length, candidateIds.length);
    const targetsAfterImport = await snapshotPaths(targetPaths);
    assert.equal(countPresent(targetsAfterImport), 0, "Store import wrote Agent targets");
    assert.notEqual(
      await readOptional(join(layout.storeRoot, "revision.json")),
      revisionBeforeNegatives,
      "Store import did not advance the revision",
    );
    const sourceAfterJourney = await fingerprintTree(sourcePool);
    assert.equal(
      sourceAfterJourney.hash,
      stagedPool.sourceBefore.hash,
      "caller skill pool changed",
    );
    evidence.push({
      id: "inventory-store-import",
      status: "passed",
      candidateIds,
      resourceIds: [...imported.data.resourceIds].sort(),
      resultingRevision: imported.data.operation.receipt.resultingRevision,
    });
    assertions.push(
      { id: "exact-candidate-selection", passed: true },
      { id: "unchanged-cross-process-plan", passed: true },
      { id: "store-import-zero-agent-targets", passed: true },
      { id: "negative-imports-preserve-state", passed: true },
    );

    const distributionAgents = ["claude-code", "codex", "agents-md", "codebuddy-e2e"];
    const distributionSelection = [
      "--scope",
      "project",
      "--dir",
      layout.testRoot,
      "--agent",
      distributionAgents.join(","),
      "--collection",
      "default",
      "--rules",
      "--mcp",
      "--skills",
      "--method",
      "copy",
    ];
    const distributionPlanned = requireSuccess(
      await client.invoke("plan", ["plan", ...distributionSelection]),
      "multi-Agent distribution plan",
    );
    const preview = distributionPlanned.data.preview;
    assert.equal(preview.conflicts.length, 0, "positive distribution plan contained conflicts");
    assert.deepEqual([...new Set(preview.actions.map(({ capability }) => capability))].sort(), [
      "mcp",
      "rules",
      "skills",
    ]);
    const physicalWrites = preview.actions.filter(({ op }) => op !== "skip");
    for (const action of physicalWrites) {
      assertInside(layout.testRoot, action.target, "planned Agent target");
    }
    assert.equal(
      new Set(physicalWrites.map(({ target }) => target)).size,
      physicalWrites.length,
      "distribution plan contained duplicate physical writes",
    );
    assert.equal(
      preview.actions.some(
        ({ agent, capability, op }) =>
          agent === "agents-md" && capability === "mcp" && op === "skip",
      ),
      true,
      "agents-md MCP incompatibility was not represented as a typed skip",
    );
    const distributionPlanBytes = JSON.stringify(distributionPlanned.data.plan);
    const distributionPlanPath = join(evidenceRoot, "distribution-plan.json");
    await fs.writeFile(distributionPlanPath, distributionPlanBytes, "utf8");
    assert.equal(await fs.readFile(distributionPlanPath, "utf8"), distributionPlanBytes);
    const distributed = requireSuccess(
      await client.invoke("apply", ["apply", "--plan", distributionPlanBytes]),
      "unchanged multi-Agent distribution apply",
    );
    assert.equal(distributed.data.failures.length, 0);
    assert.equal(distributed.data.entries.length > 0, true);
    await assertPositiveTargets(layout);
    const physicalTargetEvidence = await Promise.all(
      [...new Set(physicalWrites.map(({ target }) => target))].sort().map(async (target) => {
        const snapshot = await snapshotPath(target);
        return {
          path: relative(layout.testRoot, target).split(/[/\\]/).join("/"),
          state: snapshot.state,
          ...(snapshot.kind ? { kind: snapshot.kind } : {}),
          ...(snapshot.hash ? { sha256: snapshot.hash } : {}),
        };
      }),
    );
    evidence.push({
      id: "multi-agent-distribution",
      status: "passed",
      agents: distributionAgents,
      targets: physicalTargetEvidence,
    });
    assertions.push(
      { id: "contained-agent-targets", passed: true },
      { id: "typed-unsupported-capability", passed: true },
      { id: "deconflicted-physical-writes", passed: true },
      { id: "copied-skill-fingerprints", passed: true },
    );

    const targetsAfterDistribution = await snapshotPaths(targetPaths);
    const ownershipPath = join(layout.storeRoot, "state.json");
    const ownershipAfterDistribution = await readOptional(ownershipPath);
    const repeatPlanned = requireSuccess(
      await client.invoke("plan", ["plan", ...distributionSelection]),
      "converged distribution replan",
    );
    const repeated = requireSuccess(
      await client.invoke("apply", ["apply", "--plan", JSON.stringify(repeatPlanned.data.plan)]),
      "converged distribution reapply",
    );
    assert.equal(repeated.data.failures.length, 0);
    assert.deepEqual(await snapshotPaths(targetPaths), targetsAfterDistribution);
    assert.equal(await readOptional(ownershipPath), ownershipAfterDistribution);

    const status = requireSuccess(
      await client.invoke("status", [
        "status",
        "--dir",
        layout.testRoot,
        "--agent",
        distributionAgents.join(","),
      ]),
      "healthy target status",
    );
    assert.equal(
      status.data.items.every(({ status: state }) => state === "ok"),
      true,
    );
    const fullVerification = await client.invoke("verify", ["verify", ...distributionSelection]);
    assert.equal(fullVerification.exitClass, "domain-error");
    assert.equal(fullVerification.envelope.data.configuration, "incomplete");
    assert.equal(fullVerification.envelope.data.healthy, false);
    assert.deepEqual(
      fullVerification.envelope.data.coverage.items
        .filter(({ outcome }) => outcome !== "covered")
        .map(({ agent, capability, outcome }) => ({ agent, capability, outcome })),
      [
        { agent: "agents-md", capability: "rules", outcome: "blocked" },
        { agent: "agents-md", capability: "mcp", outcome: "unsupported" },
        { agent: "agents-md", capability: "skills", outcome: "blocked" },
      ],
    );
    const verificationAgents = [...new Set(distributed.data.entries.map(({ agent }) => agent))];
    const ownerSelection = [...distributionSelection];
    ownerSelection[ownerSelection.indexOf("--agent") + 1] = verificationAgents.join(",");
    const verification = requireSuccess(
      await client.invoke("verify", ["verify", ...ownerSelection]),
      "healthy actual-owner verification",
    );
    assertions.push({ id: "unsupported-and-unowned-requests-remain-incomplete", passed: true });
    assert.equal(verification.data.healthy, true);
    assert.equal(verification.data.desiredVsApplied.status, "converged");
    assert.equal(verification.data.appliedVsDisk.status, "converged");
    evidence.push({
      id: "convergence-and-verification",
      status: "passed",
      storeRevision: verification.data.storeRevision,
      desiredVsApplied: verification.data.desiredVsApplied.status,
      appliedVsDisk: verification.data.appliedVsDisk.status,
      recovery: verification.data.recovery.status,
    });
    assertions.push({ id: "repeat-apply-preserves-bytes-and-ownership", passed: true });

    if (typeof inspectSidecar === "function") {
      await inspectSidecar({
        layout,
        environment: env,
        expected: {
          inventoryCandidateIds: candidates.map(({ id }) => id).sort(),
          resourceIds: [...imported.data.resourceIds].sort(),
          distributionAgents,
          statusItems: status.data.items,
          verification: fullVerification.envelope.data,
        },
      });
      evidence.push({ id: "installed-sidecar-parity", status: "passed" });
      assertions.push({ id: "sidecar-read-model-parity", passed: true });
    }

    await runTargetConflictScenarios({ layout, client });
    evidence.push({ id: "target-conflicts", status: "passed" });
    assertions.push(
      { id: "unowned-target-preserved", passed: true },
      { id: "owned-drift-preserved", passed: true },
    );

    await runReferenceCanaryScenario({
      layout,
      clientOptions: { command, consumerRoot, repositoryRoot: layout.repositoryRoot },
      env,
    });
    evidence.push({ id: "reference-canary", status: "passed" });
    assertions.push({ id: "reference-only-secret-non-disclosure", passed: true });

    const ownedTargets = distributionPlanned.data.plan.actions.map(({ target }) => target);
    await runPositiveRevert({
      layout,
      client,
      distributionAgents,
      ownedTargets,
      evidenceRoot,
      sourcePool,
      sourceFingerprint: stagedPool.sourceBefore.hash,
      fixtureBefore,
    });
    evidence.push({ id: "revert", status: "passed" });
    assertions.push({ id: "revert-preserves-non-target-state", passed: true });

    await runRecoveryBlockedScenario({ layout, client, skips });
    evidence.push({ id: "recovery-blocked", status: "passed" });
    assertions.push({ id: "recovery-state-blocks-continuation", passed: true });

    assert.equal((await fingerprintTree(sourcePool)).hash, stagedPool.sourceBefore.hash);
    assert.equal((await fingerprintTree(fixtureRoot)).hash, fixtureBefore.hash);
    await assertTreeExcludesValue(layout.sandboxRoot, secretCanary);
    await writeClosedReport({
      layout,
      name: "resource-e2e.json",
      report: { mode, status: "passed", phases: evidence, assertions, skips },
      secretCanaries: [secretCanary],
    });

    return {
      status: "passed",
      mode,
      layout,
      client,
      evidence,
      assertions,
      inventory: { candidates, readyKinds, candidateIds, blockedCount: blocked.length },
      import: {
        resourceIds: imported.data.resourceIds,
        targetCount: countPresent(targetsAfterImport),
      },
      distribution: {
        agents: distributionAgents,
        entryCount: distributed.data.entries.length,
        targetCount: countPresent(targetsAfterDistribution),
      },
      sourceFingerprint: stagedPool.sourceBefore.hash,
      targetPaths,
    };
  } catch (error) {
    evidence.push({
      id: "harness-failure",
      status: "failed",
      code: closedHarnessFailureCode(error),
    });
    await retainFailureReport(layout, mode, evidence, assertions, skips);
    throw error;
  }
}

function closedHarnessFailureCode(error) {
  if (error?.code === "ERR_ASSERTION") return "ASSERTION_FAILED";
  if (error instanceof SyntaxError) return "INVALID_JSON";
  if (error instanceof TypeError) return "INVALID_INPUT";
  return "HARNESS_FAILURE";
}

function requireAbsolutePool(skillsPool) {
  if (typeof skillsPool !== "string" || !isAbsolute(skillsPool)) {
    throw new Error("real-pool mode requires absolute CELLARER_E2E_SKILLS_POOL");
  }
  return skillsPool;
}

function requireSuccess(result, label) {
  const errorCode = result.envelope?.error?.code;
  const errorMessage = result.envelope?.error?.message;
  const failure = [errorCode, errorMessage].filter((value) => typeof value === "string").join(": ");
  assert.equal(
    result.exitClass,
    "success",
    `${label} returned ${result.exitClass}${failure.length > 0 ? ` (${failure})` : ""}`,
  );
  assert.equal(result.envelope.status, "success", `${label} protocol status was not success`);
  return result.envelope;
}

function generatedTargetPaths(layout) {
  return layout.cleanupPaths.filter(
    (path) => path !== layout.sandboxRoot && path !== layout.reportsRoot,
  );
}

async function snapshotPaths(paths) {
  return Object.fromEntries(
    await Promise.all(paths.map(async (path) => [path, await snapshotPath(path)])),
  );
}

async function snapshotPath(path) {
  let stat;
  try {
    stat = await fs.lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return { state: "absent" };
    throw error;
  }
  if (stat.isSymbolicLink())
    return { state: "present", kind: "symlink", target: await fs.readlink(path) };
  if (stat.isDirectory()) {
    const fingerprint = await fingerprintTree(path);
    return { state: "present", kind: "directory", hash: fingerprint.hash };
  }
  if (stat.isFile()) {
    const bytes = await fs.readFile(path);
    return {
      state: "present",
      kind: "file",
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  return { state: "present", kind: "unsupported" };
}

function countPresent(snapshot) {
  return Object.values(snapshot).filter(({ state }) => state === "present").length;
}

async function assertUnchanged(layout, revision, targets, label) {
  assert.equal(
    await readOptional(join(layout.storeRoot, "revision.json")),
    revision,
    `${label} changed Store revision`,
  );
  assert.deepEqual(
    await snapshotPaths(Object.keys(targets)),
    targets,
    `${label} changed Agent targets`,
  );
}

async function assertPositiveTargets(layout) {
  const expectedTextTargets = [
    join(layout.testRoot, "CLAUDE.md"),
    join(layout.testRoot, "AGENTS.md"),
    join(layout.testRoot, ".mcp.json"),
    join(layout.testRoot, ".codex", "config.toml"),
    join(layout.testRoot, ".codebuddy", "RULES.md"),
    join(layout.testRoot, ".codebuddy", "mcp.json"),
  ];
  for (const path of expectedTextTargets) {
    const stat = await fs.lstat(path);
    assert.equal(stat.isFile(), true, `expected regular Agent target: ${path}`);
    assert.equal(stat.isSymbolicLink(), false, `Agent target is a symbolic link: ${path}`);
  }
  for (const path of [
    join(layout.testRoot, "CLAUDE.md"),
    join(layout.testRoot, "AGENTS.md"),
    join(layout.testRoot, ".codebuddy", "RULES.md"),
  ]) {
    assert.match(await fs.readFile(path, "utf8"), /CELLARER_RESOURCE_E2E_RULE/);
  }
  const claudeMcp = await readJson(join(layout.testRoot, ".mcp.json"));
  const codebuddyMcp = await readJson(join(layout.testRoot, ".codebuddy", "mcp.json"));
  assert.equal(typeof claudeMcp.mcpServers?.["fixture-stdio"], "object");
  assert.equal(typeof codebuddyMcp.mcpServers?.["fixture-stdio"], "object");
  assert.match(
    await fs.readFile(join(layout.testRoot, ".codex", "config.toml"), "utf8"),
    /fixture-stdio/,
  );

  const storeSkill = await fingerprintTree(
    join(layout.storeRoot, "store", "skills", "valid-skill"),
  );
  for (const target of [
    join(layout.testRoot, ".claude", "skills", "valid-skill"),
    join(layout.testRoot, ".agents", "skills", "valid-skill"),
    join(layout.testRoot, ".codebuddy", "skills", "valid-skill"),
  ]) {
    assert.deepEqual((await fingerprintTree(target)).entries, storeSkill.entries);
  }
}

async function runTargetConflictScenarios({ layout, client }) {
  const scenarioRoot = assertInside(
    layout.testRoot,
    join(layout.sandboxRoot, "scenarios", "target-conflicts"),
    "target-conflict scenario",
  );
  const target = join(scenarioRoot, ".codebuddy", "RULES.md");
  await fs.mkdir(join(target, ".."), { recursive: true });
  const unownedBytes = "UNOWNED_RESOURCE_E2E_SENTINEL\n";
  await fs.writeFile(target, unownedBytes, "utf8");
  const selection = [
    "--scope",
    "project",
    "--dir",
    scenarioRoot,
    "--agent",
    "codebuddy-e2e",
    "--collection",
    "default",
    "--rules",
    "--method",
    "copy",
  ];

  const unownedPlan = requireSuccess(
    await client.invoke("plan", ["plan", ...selection]),
    "unowned-target plan",
  );
  assert.equal(unownedPlan.data.preview.conflicts[0]?.code, "UNOWNED_TARGET");
  requireDomainError(
    await client.invoke("apply", ["apply", "--plan", JSON.stringify(unownedPlan.data.plan)]),
    "unowned-target apply",
    ["TARGET_CONFLICT"],
  );
  assert.equal(await fs.readFile(target, "utf8"), unownedBytes);

  await fs.rm(target, { force: true });
  const ownedPlan = requireSuccess(
    await client.invoke("plan", ["plan", ...selection]),
    "owned-target setup plan",
  );
  requireSuccess(
    await client.invoke("apply", ["apply", "--plan", JSON.stringify(ownedPlan.data.plan)]),
    "owned-target setup apply",
  );
  const managedBytes = await fs.readFile(target, "utf8");
  const driftedBytes = `${managedBytes}\nOWNED_RESOURCE_E2E_DRIFT\n`;
  await fs.writeFile(target, driftedBytes, "utf8");

  const driftPlan = requireSuccess(
    await client.invoke("plan", ["plan", ...selection]),
    "owned-drift plan",
  );
  assert.equal(driftPlan.data.preview.conflicts[0]?.code, "OWNED_TARGET_DRIFTED");
  requireDomainError(
    await client.invoke("apply", ["apply", "--plan", JSON.stringify(driftPlan.data.plan)]),
    "owned-drift apply",
    ["TARGET_CONFLICT"],
  );
  assert.equal(await fs.readFile(target, "utf8"), driftedBytes);

  const revertArgs = ["revert", "--agent", "codebuddy-e2e", "--dir", scenarioRoot];
  const blockedRevert = requireDomainError(
    await client.invoke("revert", [...revertArgs, "--dry-run"]),
    "owned-drift revert",
    ["TARGET_CONFLICT"],
  );
  assert.equal(blockedRevert.data.plan.conflicts[0]?.code, "REVERT_TARGET_DRIFTED");
  assert.equal(await fs.readFile(target, "utf8"), driftedBytes);

  await fs.writeFile(target, managedBytes, "utf8");
  requireSuccess(await client.invoke("revert", revertArgs), "owned-target scenario cleanup");
  assert.equal(await exists(target), false);
}

async function runReferenceCanaryScenario({ layout, clientOptions, env }) {
  const sourcePath = join(layout.sourceRoot, "secret-mcp.json");
  const referenceToken = "$" + "{CELLARER_E2E_TOKEN}";
  await fs.writeFile(
    sourcePath,
    `${JSON.stringify(
      {
        mcpServers: {
          "local-stdio": {
            command: "node",
            args: ["--version"],
            env: { TOKEN: referenceToken },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const adapter = {
    displayName: "Reference source (E2E fixture only)",
    mcp: {
      project: "{dir}/.sandbox/source/secret-mcp.json",
      format: "json",
      serversKey: "mcpServers",
      supportedSecretReferences: ["environment"],
    },
    capabilities: { rules: [], mcp: ["project"], skills: [] },
  };
  const plainClient = await createInvocation(clientOptions, env, layout);
  requireSuccess(
    await plainClient.invoke("agent.add", [
      "agent",
      "add",
      "secret-source-e2e",
      "--adapter",
      JSON.stringify(adapter),
    ]),
    "reference source adapter creation",
  );
  const secretEnv = { ...env, CELLARER_E2E_TOKEN: secretCanary };
  const client = await createInvocation(clientOptions, secretEnv, layout, [secretCanary]);
  requireSuccess(
    await client.invoke("collection.create", [
      "collection",
      "create",
      "secret-e2e",
      "--resource",
      "",
    ]),
    "reference collection creation",
  );
  const inventory = requireSuccess(
    await client.invoke("inventory.refresh", [
      "inventory",
      "refresh",
      "--agent",
      "secret-source-e2e",
      "--dir",
      layout.testRoot,
    ]),
    "reference Inventory refresh",
  );
  const candidate = inventory.data.candidates.find(
    ({ kind, name, state }) => kind === "mcp" && name === "local-stdio" && state === "ready",
  );
  assert.ok(candidate, "reference MCP candidate was not ready");
  const importPlan = requireSuccess(
    await client.invoke("inventory.import.plan", [
      "inventory",
      "import",
      "plan",
      "--candidate",
      candidate.id,
      "--agent",
      "secret-source-e2e",
      "--dir",
      layout.testRoot,
      "--into-collection",
      "secret-e2e",
    ]),
    "reference Store import plan",
  );
  requireSuccess(
    await client.invoke("inventory.import.apply", [
      "inventory",
      "import",
      "apply",
      "--plan",
      JSON.stringify(importPlan.data.mutationPlan),
    ]),
    "reference Store import apply",
  );

  const scenarioRoot = assertInside(
    layout.testRoot,
    join(layout.sandboxRoot, "scenarios", "reference-canary"),
    "reference scenario",
  );
  await fs.mkdir(scenarioRoot, { recursive: true });
  const selection = [
    "--scope",
    "project",
    "--dir",
    scenarioRoot,
    "--agent",
    "claude-code,codebuddy-e2e",
    "--collection",
    "secret-e2e",
    "--mcp",
    "--method",
    "copy",
  ];
  const plan = requireSuccess(
    await client.invoke("plan", ["plan", ...selection]),
    "reference distribution plan",
  );
  assert.equal(
    plan.data.preview.actions.every(({ op }) => op !== "skip"),
    true,
  );
  requireSuccess(
    await client.invoke("apply", ["apply", "--plan", JSON.stringify(plan.data.plan)]),
    "reference distribution apply",
  );
  for (const target of [
    join(scenarioRoot, ".mcp.json"),
    join(scenarioRoot, ".codebuddy", "mcp.json"),
  ]) {
    const content = await fs.readFile(target, "utf8");
    assert.match(content, /\$\{CELLARER_E2E_TOKEN\}/);
    assert.equal(content.includes(secretCanary), false);
  }

  const incompatible = requireSuccess(
    await client.invoke("plan", [
      "plan",
      "--scope",
      "project",
      "--dir",
      scenarioRoot,
      "--agent",
      "codex",
      "--collection",
      "secret-e2e",
      "--mcp",
      "--method",
      "copy",
    ]),
    "incompatible reference plan",
  );
  assert.equal(
    incompatible.data.preview.actions.some(
      ({ agent, capability, op, reason }) =>
        agent === "codex" &&
        capability === "mcp" &&
        op === "skip" &&
        /incompatible.*plaintext materialization/i.test(reason),
    ),
    true,
  );
  requireSuccess(
    await client.invoke("revert", [
      "revert",
      "--agent",
      "claude-code,codebuddy-e2e",
      "--dir",
      scenarioRoot,
    ]),
    "reference target cleanup",
  );
  await assertTreeExcludesValue(layout.sandboxRoot, secretCanary);
}

async function runPositiveRevert({
  layout,
  client,
  distributionAgents,
  ownedTargets,
  evidenceRoot,
  sourcePool,
  sourceFingerprint,
  fixtureBefore,
}) {
  const unrelatedPath = join(layout.sandboxRoot, "unrelated-sentinel.txt");
  const unrelatedBytes = "CELLARER_RESOURCE_E2E_UNRELATED\n";
  await fs.writeFile(unrelatedPath, unrelatedBytes, "utf8");
  const storeBefore = await fingerprintTree(join(layout.storeRoot, "store"));
  const stagingBefore = await fingerprintTree(layout.sourceRoot);
  const revertArgs = ["revert", "--agent", distributionAgents.join(","), "--dir", layout.testRoot];
  const preview = requireSuccess(
    await client.invoke("revert", [...revertArgs, "--dry-run"]),
    "positive revert preview",
  );
  assert.equal(preview.data.plan.conflicts.length, 0);
  const previewPath = join(evidenceRoot, "revert-preview.json");
  await fs.writeFile(previewPath, JSON.stringify(preview.data.plan), "utf8");
  requireSuccess(await client.invoke("revert", revertArgs), "positive revert apply");

  for (const target of [...new Set(ownedTargets)]) {
    assertInside(layout.testRoot, target, "reverted target");
    assert.equal(await exists(target), false, `revert left managed target: ${target}`);
  }
  assert.deepEqual(await fingerprintTree(join(layout.storeRoot, "store")), storeBefore);
  assert.deepEqual(await fingerprintTree(layout.sourceRoot), stagingBefore);
  assert.equal((await fingerprintTree(sourcePool)).hash, sourceFingerprint);
  assert.deepEqual(await fingerprintTree(join(layout.testRoot, "fixtures")), fixtureBefore);
  assert.equal(await fs.readFile(unrelatedPath, "utf8"), unrelatedBytes);
}

async function runRecoveryBlockedScenario({ layout, client, skips }) {
  if (process.platform === "win32") {
    skips.push({ id: "recovery-permission-fault", reason: "requires POSIX directory modes" });
    return;
  }
  const scenarioRoot = assertInside(
    layout.testRoot,
    join(layout.sandboxRoot, "scenarios", "recovery-blocked"),
    "recovery scenario",
  );
  const lockedRoot = join(scenarioRoot, "locked");
  await fs.mkdir(lockedRoot, { recursive: true });
  const adapter = {
    displayName: "Recovery fault (E2E fixture only)",
    rules: { project: "{dir}/RULES.md", format: "markdown" },
    mcp: {
      project: "{dir}/locked/mcp.json",
      format: "json",
      serversKey: "mcpServers",
      supportedSecretReferences: ["environment"],
    },
    capabilities: { rules: ["project"], mcp: ["project"], skills: [] },
  };
  requireSuccess(
    await client.invoke("agent.add", [
      "agent",
      "add",
      "recovery-e2e",
      "--adapter",
      JSON.stringify(adapter),
    ]),
    "recovery adapter creation",
  );
  const selection = [
    "--scope",
    "project",
    "--dir",
    scenarioRoot,
    "--agent",
    "recovery-e2e",
    "--collection",
    "default",
    "--rules",
    "--mcp",
    "--method",
    "copy",
  ];
  const plan = requireSuccess(
    await client.invoke("plan", ["plan", ...selection]),
    "recovery fault plan",
  );
  let failed;
  await fs.chmod(lockedRoot, 0o500);
  try {
    failed = await client.invoke("apply", ["apply", "--plan", JSON.stringify(plan.data.plan)]);
  } finally {
    await fs.chmod(lockedRoot, 0o700);
  }
  requireDomainError(failed, "recovery fault apply", ["PARTIAL_FAILURE"]);
  const journal = await readJson(join(layout.storeRoot, "operations", "active.json"));
  assert.equal(journal.status, "recovery-required");
  requireDomainError(
    await client.invoke("apply", ["apply", "--plan", JSON.stringify(plan.data.plan)]),
    "recovery-blocked continuation",
    ["RECOVERY_REQUIRED"],
  );
}

async function createInvocation(options, env, layout, secretCanaries = []) {
  return createCellarerClient({
    ...options,
    cwd: layout.testRoot,
    env,
    testRoot: layout.testRoot,
    secretCanaries,
  });
}

function requireDomainError(result, label, expectedCodes) {
  assert.equal(result.exitClass, "domain-error", `${label} unexpectedly succeeded`);
  assert.equal(result.envelope.status, "error", `${label} protocol status was not error`);
  assert.equal(
    expectedCodes.includes(result.envelope.error?.code),
    true,
    `${label} returned unexpected error code ${String(result.envelope.error?.code)}`,
  );
  return result.envelope;
}

async function assertTreeExcludesValue(root, value) {
  if (!(await exists(root))) return;
  const stat = await fs.lstat(root);
  assert.equal(stat.isSymbolicLink(), false, "canary scan encountered a symbolic link");
  if (stat.isFile()) {
    assert.equal((await fs.readFile(root)).includes(Buffer.from(value)), false);
    return;
  }
  assert.equal(stat.isDirectory(), true, "canary scan encountered an unsupported node");
  const names = await fs.readdir(root);
  names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const name of names) await assertTreeExcludesValue(join(root, name), value);
}

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

async function readOptional(path) {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function exists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function retainFailureReport(layout, mode, phases, assertions, skips) {
  await fs.rm(join(layout.reportsRoot, "resource-e2e.json"), { force: true });
  await writeClosedReport({
    layout,
    name: "resource-e2e.json",
    report: {
      mode,
      status: "failed",
      phases,
      assertions,
      skips,
    },
    secretCanaries: [secretCanary],
  });
}
