import { describe, expect, it } from "vitest";
import { dedupeCollisions } from "../src/engine/plan/collision.js";
import { applySecretScanGuard } from "../src/engine/plan/secret-guard.js";
import type { PlanAction, TargetConflict } from "../src/model/index.js";

// 抽出的两个 plan pass 的单元测试(纯函数,不需 Env / 库房)。
function writeAction(over: Partial<PlanAction>): PlanAction {
  return {
    artifact: "rules/*",
    agent: "a",
    scope: "global",
    capability: "rules",
    target: "/home/x/CLAUDE.md",
    method: "symlink",
    op: "write",
    desiredEvidence: { method: "write", contentFingerprint: "same" },
    ...over,
  };
}

describe("engine/plan collision dedupe", () => {
  it("coalesces identical materializations and retains both consumers", () => {
    const actions = [
      writeAction({ agent: "codex", target: "/proj/AGENTS.md" }),
      writeAction({ agent: "agents-md", target: "/proj/AGENTS.md" }),
    ];
    const conflicts: TargetConflict[] = [];
    dedupeCollisions(actions, conflicts);
    expect(actions[0]?.op).toBe("write");
    expect(actions).toHaveLength(1);
    expect(actions[0]?.consumerAgents).toEqual(["codex", "agents-md"]);
    expect(conflicts).toEqual([]);
  });

  it("blocks a physical collision across different capabilities", () => {
    const actions = [
      writeAction({ capability: "rules", target: "/proj/X" }),
      writeAction({ capability: "mcp", target: "/proj/X", op: "merge" }),
    ];
    const conflicts: TargetConflict[] = [];
    dedupeCollisions(actions, conflicts);
    expect(conflicts[0]?.code).toBe("SHARED_TARGET_CONFLICT");
    expect(actions[0]?.op).toBe("write");
    expect(actions[1]?.op).toBe("merge");
  });

  it("ignores skip actions and empty targets", () => {
    const actions = [writeAction({ op: "skip", target: "" }), writeAction({ target: "/proj/Y" })];
    dedupeCollisions(actions, []);
    expect(actions[1]?.op).toBe("write");
  });
});

describe("engine/plan secret-scan guard", () => {
  it("blocks a plaintext secret in preview.after and clears it", () => {
    const actions = [
      writeAction({
        preview: { before: "old", after: "token = ghp_0123456789abcdefghijklmnopqrstuvwx" },
      }),
    ];
    applySecretScanGuard(actions, "global");
    expect(actions[0]?.op).toBe("skip");
    expect(actions[0]?.reason).toMatch(/secret-scan/);
    // 真值预览被清空(不经返回的 plan 外泄)。
    expect(actions[0]?.preview?.after).toBeUndefined();
    expect(actions[0]?.preview?.before).toBe("old");
  });

  it("blocks accidentalPlaintext unconditionally (no escape hatch)", () => {
    const actions = [writeAction({ accidentalPlaintext: true, preview: { after: "anything" } })];
    applySecretScanGuard(actions, "global");
    expect(actions[0]?.op).toBe("skip");
    expect(actions[0]?.reason).toMatch(/store contains a plaintext secret/);
  });

  it("blocks plaintext in every scope with no global escape hatch", () => {
    const secret = "token = ghp_0123456789abcdefghijklmnopqrstuvwx";
    const global = [writeAction({ preview: { after: secret } })];
    applySecretScanGuard(global, "global");
    expect(global[0]?.op).toBe("skip");

    const project = [writeAction({ scope: "project", preview: { after: secret } })];
    applySecretScanGuard(project, "project");
    expect(project[0]?.op).toBe("skip");
  });
});
