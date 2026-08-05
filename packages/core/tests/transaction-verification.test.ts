import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply } from "../src/engine/apply.js";
import { verify } from "../src/engine/verification.js";
import { createAuthorizedMutationPlan } from "../src/protocol/canonical.js";
import { executeMutationPlan } from "../src/protocol/execute.js";
import { readOperationJournal } from "../src/protocol/journal.js";
import { sha256 } from "../src/store/checksum.js";
import { loadLedger, saveLedger } from "../src/store/ledger.js";
import {
  importSkillArtifact,
  initStore,
  writeMcpArtifact,
  writeRuleArtifact,
} from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("transaction verification axes", () => {
  let t: TmpEnv;
  let storeRoot: string;
  const options = () => ({
    storeRoot,
    scope: "global" as const,
    agents: ["claude-code"],
    capabilities: ["rules" as const],
  });

  beforeEach(async () => {
    t = makeTmpEnv({ randomId: () => "verification" });
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
    await writeRuleArtifact(t.env, storeRoot, "style", "original");
  });

  afterEach(() => t.cleanup());

  it("reports desired-versus-applied divergence without target drift", async () => {
    await apply(t.env, options());
    await writeRuleArtifact(t.env, storeRoot, "new-selection", "new desired rule");

    const report = await verify(t.env, options());

    expect(report.desiredVsApplied).toMatchObject({
      status: "diverged",
      items: [
        {
          status: "selection-mismatch",
          desiredArtifactIds: ["rules/new-selection", "rules/style"],
          appliedArtifactIds: ["rules/style"],
        },
      ],
    });
    expect(report.appliedVsDisk).toMatchObject({ status: "converged" });
    expect(report.recovery).toMatchObject({ status: "clean" });
    expect(report.healthy).toBe(false);
  });

  it("reports rendered content changes for the same artifact selection", async () => {
    await apply(t.env, options());
    await writeRuleArtifact(t.env, storeRoot, "style", "updated desired content");

    const report = await verify(t.env, options());

    expect(report.desiredVsApplied).toMatchObject({
      status: "diverged",
      items: [
        {
          status: "content-mismatch",
          desiredArtifactIds: ["rules/style"],
          appliedArtifactIds: ["rules/style"],
          comparisons: {
            selection: "matched",
            content: "mismatched",
            method: "matched",
          },
        },
      ],
    });
    expect(report.appliedVsDisk).toMatchObject({ status: "converged" });
    expect(JSON.stringify(report)).not.toContain("updated desired content");
    expect(report.healthy).toBe(false);
  });

  it("compares rendered MCP fingerprints without exposing rendered content", async () => {
    await writeMcpArtifact(t.env, storeRoot, "context", {
      kind: "stdio",
      command: "original-command",
    });
    const mcpOptions = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["mcp" as const],
      mcpStrategy: "overwrite" as const,
    };
    await apply(t.env, mcpOptions);
    await writeMcpArtifact(t.env, storeRoot, "context", {
      kind: "stdio",
      command: "updated-command",
    });

    const report = await verify(t.env, mcpOptions);

    expect(report.desiredVsApplied).toMatchObject({
      status: "diverged",
      items: [
        {
          status: "content-mismatch",
          comparisons: { selection: "matched", content: "mismatched", method: "matched" },
        },
      ],
    });
    expect(report.appliedVsDisk).toMatchObject({ status: "converged" });
    expect(JSON.stringify(report)).not.toContain("updated-command");
  });

  it("does not derive desired MCP evidence from unrelated target content", async () => {
    await writeMcpArtifact(t.env, storeRoot, "context", {
      kind: "stdio",
      command: "stable-command",
    });
    const mcpOptions = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["mcp" as const],
    };
    await apply(t.env, mcpOptions);
    const target = t.path("home", ".claude", "mcp.json");
    const changed = JSON.parse(await t.env.fs.readFile(target));
    changed.unrelatedUserSetting = true;
    await t.env.fs.writeFile(target, `${JSON.stringify(changed, null, 2)}\n`);

    const report = await verify(t.env, mcpOptions);

    expect(report.desiredVsApplied).toMatchObject({
      status: "converged",
      items: [
        {
          status: "in-sync",
          comparisons: { selection: "matched", content: "matched", method: "matched" },
        },
      ],
    });
    expect(report.appliedVsDisk).toMatchObject({
      status: "diverged",
      items: [{ target, status: "drifted" }],
    });
  });

  it("reports a placement method change even when skill selection and source are unchanged", async () => {
    const source = t.path("source", "demo");
    await t.env.fs.mkdir(source, { recursive: true });
    await t.env.fs.writeFile(t.path("source", "demo", "SKILL.md"), "# demo");
    await importSkillArtifact(t.env, storeRoot, "demo", source);
    const skillOptions = {
      storeRoot,
      scope: "global" as const,
      agents: ["codex"],
      capabilities: ["skills" as const],
    };
    await apply(t.env, { ...skillOptions, method: "copy" });

    const report = await verify(t.env, { ...skillOptions, method: "symlink" });

    expect(report.desiredVsApplied).toMatchObject({
      status: "diverged",
      items: [
        {
          status: "method-mismatch",
          comparisons: {
            selection: "matched",
            content: "matched",
            method: "mismatched",
          },
          desiredMethod: "symlink",
          appliedMethod: "copy",
        },
      ],
    });
    expect(report.appliedVsDisk).toMatchObject({ status: "converged" });
    expect(report.healthy).toBe(false);
  });

  it("does not treat a project owner from a different persisted root as applied", async () => {
    const project = t.path("cwd", "project");
    const otherProject = t.path("cwd", "other-project");
    await t.env.fs.mkdir(project, { recursive: true });
    await t.env.fs.mkdir(otherProject, { recursive: true });
    const projectOptions = {
      storeRoot,
      scope: "project" as const,
      dir: project,
      agents: ["claude-code"],
      capabilities: ["rules" as const],
    };
    await apply(t.env, projectOptions);
    const ledger = await loadLedger(t.env, storeRoot);
    await saveLedger(t.env, storeRoot, {
      ...ledger,
      owners: ledger.owners.map((owner) => ({ ...owner, projectRoot: otherProject })),
    });

    const report = await verify(t.env, projectOptions);

    expect(report.desiredVsApplied).toMatchObject({
      status: "diverged",
      items: [{ status: "missing-applied" }],
    });
    expect(report.healthy).toBe(false);
  });

  it("fails closed when an applied Skill receipt lacks source evidence", async () => {
    const source = t.path("source", "legacy");
    await t.env.fs.mkdir(source, { recursive: true });
    await t.env.fs.writeFile(t.path("source", "legacy", "SKILL.md"), "# legacy");
    await importSkillArtifact(t.env, storeRoot, "legacy", source);
    const skillOptions = {
      storeRoot,
      scope: "global" as const,
      agents: ["codex"],
      capabilities: ["skills" as const],
      method: "copy" as const,
    };
    await apply(t.env, skillOptions);
    const ledger = await loadLedger(t.env, storeRoot);
    await saveLedger(t.env, storeRoot, {
      ...ledger,
      owners: ledger.owners.map((owner) => {
        const { sourceFingerprint: _sourceFingerprint, ...receipt } = owner.receipt;
        return { ...owner, receipt };
      }),
    });

    const report = await verify(t.env, skillOptions);

    expect(report.desiredVsApplied).toMatchObject({
      status: "diverged",
      items: [
        {
          status: "unverifiable",
          comparisons: { selection: "matched", content: "unverifiable", method: "matched" },
        },
      ],
    });
    expect(report.appliedVsDisk).toMatchObject({ status: "converged" });
    expect(report.healthy).toBe(false);
  });

  it("reports applied-versus-disk drift without desired-state divergence", async () => {
    await apply(t.env, options());
    const target = t.path("home", ".claude", "CLAUDE.md");
    await t.env.fs.writeFile(target, "edited outside cellarer");

    const report = await verify(t.env, options());

    expect(report.desiredVsApplied).toMatchObject({
      status: "converged",
      items: [{ status: "in-sync" }],
    });
    expect(report.appliedVsDisk).toMatchObject({
      status: "diverged",
      items: [{ target, status: "drifted" }],
    });
    expect(report.healthy).toBe(false);
  });

  it("includes an unprovable store-import journal as a typed manual recovery failure", async () => {
    const target = t.path("home", ".cellarer", "store", "rules", "interrupted.md");
    const content = "interrupted fixture";
    const actionId = sha256(JSON.stringify({ kind: "rules", name: "interrupted", target }));
    const mutationPlan = createAuthorizedMutationPlan(t.env, storeRoot, {
      schemaVersion: 1,
      planId: "plan-incomplete",
      operation: "store-import",
      baseRevision: 0,
      normalizedInputs: { mutationKind: "add" },
      targetPreconditions: [{ actionId, target, expected: { state: "absent" } }],
      actions: [
        {
          actionId,
          kind: "add-rules",
          target,
          payload: { contentDigest: sha256(content) },
          postcondition: { state: "present", fingerprint: sha256(content) },
        },
      ],
      expires: { policy: "none" },
    });
    await expect(
      executeMutationPlan(t.env, storeRoot, mutationPlan, async () => {
        throw new Error("interrupt verification fixture");
      }),
    ).rejects.toThrow("interrupt verification fixture");
    const journal = await readOperationJournal(t.env, storeRoot);
    if (!journal) throw new Error("missing interrupted test journal");

    const report = await verify(t.env, options());

    expect(report.recovery).toMatchObject({
      status: "manual-recovery-required",
      operationId: "operation-verification",
      planId: "plan-incomplete",
      baseRevision: 0,
      error: {
        code: "MANUAL_RECOVERY_REQUIRED",
        operationId: "operation-verification",
      },
    });
    expect(JSON.stringify(report.recovery)).not.toContain("statePublications");
    expect(JSON.stringify(report.recovery)).not.toContain("plaintext-secret-journal-payload");
    expect(report.healthy).toBe(false);
  });
});
