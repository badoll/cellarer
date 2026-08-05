import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendActivity } from "../src/activity.js";
import { activityPath, applyMutationPlan, listActivity, planApplyMutation } from "../src/index.js";
import { initStore, writeRuleArtifact } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("activity store", () => {
  let t: TmpEnv;
  let storeRoot: string;
  const REAL = "ghp_0123456789abcdefghijklmnopqrstuvwx";

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });
  afterEach(() => t.cleanup());

  it("appends, lists latest first, filters, and limits activity events", async () => {
    await appendActivity(t.env, storeRoot, {
      action: "apply",
      scope: "global",
      agents: ["codex"],
      capabilities: ["rules"],
      affectedCount: 1,
      summary: "Applied one target",
    });
    await appendActivity(t.env, storeRoot, {
      action: "revert",
      scope: "global",
      agents: ["codex"],
      capabilities: ["rules"],
      affectedCount: 1,
      summary: "Reverted one target",
    });

    const all = await listActivity(t.env, storeRoot, { limit: 1 });
    expect(all.events).toHaveLength(1);
    expect(all.events[0]?.action).toBe("revert");

    const filtered = await listActivity(t.env, storeRoot, { actions: ["apply"] });
    expect(filtered.events.map((event) => event.action)).toEqual(["apply"]);
  });

  it("skips corrupt JSONL lines with a warning", async () => {
    await appendActivity(t.env, storeRoot, {
      action: "apply",
      affectedCount: 0,
      summary: "No-op apply",
    });
    await t.env.fs.appendFile(activityPath(storeRoot), "not json\n");

    const listed = await listActivity(t.env, storeRoot);

    expect(listed.events).toHaveLength(1);
    expect(listed.warnings[0]).toContain("line 2 skipped");
  });

  it("redacts secret-like text before writing activity", async () => {
    await appendActivity(t.env, storeRoot, {
      action: "scan-import",
      affectedCount: 1,
      summary: `Imported ${REAL}`,
    });

    const text = await t.env.fs.readFile(activityPath(storeRoot));
    expect(text).not.toContain(REAL);
    expect(text).toContain("[REDACTED]");
  });

  it("keeps non-secret resource links while redacting plaintext secretRefs", async () => {
    const event = await appendActivity(t.env, storeRoot, {
      action: "apply",
      affectedCount: 1,
      summary: "Linked resource metadata",
      resources: { artifactIds: ["mcp/context"], ledgerEntryKeys: ["owner-key"] },
      secretRefs: ["tiny", "${ENV_VAR}"],
    });

    expect(event.resources).toEqual({
      artifactIds: ["mcp/context"],
      ledgerEntryKeys: ["owner-key"],
    });
    expect(event.secretRefs).toEqual(["[REDACTED]", "${ENV_VAR}"]);
    const text = await t.env.fs.readFile(activityPath(storeRoot));
    expect(text).not.toContain("tiny");
    expect(text).toContain("mcp/context");
  });

  it("redacts secret-like text from events loaded from disk", async () => {
    await t.env.fs.appendFile(
      activityPath(storeRoot),
      `${JSON.stringify({
        version: 1,
        id: "manual",
        time: "2026-06-30T08:00:00.000Z",
        actor: "you",
        action: "apply",
        affectedCount: 1,
        summary: `Manual ${REAL}`,
      })}\n`,
    );

    const listed = await listActivity(t.env, storeRoot);

    expect(JSON.stringify(listed)).not.toContain(REAL);
    expect(listed.events[0]?.summary).toBe("[REDACTED]");
  });

  it("does not fail apply when activity append fails", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "# style");
    const err = Object.assign(new Error("mock append failure"), { code: "EIO" });
    const env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        appendFile: () => Promise.reject(err),
      },
    };

    const options = {
      storeRoot,
      scope: "global" as const,
      agents: ["claude-code"],
      capabilities: ["rules" as const],
    };
    const prepared = await planApplyMutation(t.env, options);
    const signedDisplayPlan = prepared.mutationPlan.normalizedInputs.distributePlan as {
      warnings: readonly string[];
    };
    const originalDigest = prepared.mutationPlan.digest;
    expect(Object.isFrozen(signedDisplayPlan)).toBe(true);

    const result = await applyMutationPlan(env, prepared.mutationPlan, { storeRoot, options });

    expect(result.entries).toHaveLength(1);
    expect(result.plan.warnings.some((warning) => warning.includes("activity log failed"))).toBe(
      true,
    );
    expect(prepared.mutationPlan.digest).toBe(originalDigest);
    expect(Object.isFrozen(prepared.mutationPlan)).toBe(true);
    expect(signedDisplayPlan.warnings).toEqual([]);
  });
});
