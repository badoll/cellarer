import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor } from "../src/diagnostics.js";
import { createMutationPlan } from "../src/protocol/canonical.js";
import { executeMutationPlan } from "../src/protocol/execute.js";
import { listOperationReceipts, publishOperationReceipt } from "../src/protocol/journal.js";
import type { OperationReceipt } from "../src/protocol/models.js";
import {
  acquireStoreMutationLock,
  acquireStoreRecoveryLock,
} from "../src/protocol/mutation-lock.js";
import { pruneOperationRecoveryArtifacts } from "../src/protocol/recovery.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("mutation doctor and retention", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv({ randomId: () => "doctor" });
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });

  afterEach(() => t.cleanup());

  it("adds incomplete journal evidence to the existing Core doctor report", async () => {
    const target = t.path("home", ".agent", "rules.md");
    const plan = createMutationPlan({
      schemaVersion: 1,
      planId: "plan-doctor",
      operation: "apply",
      baseRevision: 0,
      normalizedInputs: {},
      targetPreconditions: [{ actionId: "action-1", target, expected: { state: "absent" } }],
      actions: [{ actionId: "action-1", kind: "write", target, payload: {} }],
      expires: { policy: "none" },
    });
    await expect(
      executeMutationPlan(t.env, storeRoot, plan, async () => {
        throw new Error("interrupted");
      }),
    ).rejects.toThrow("interrupted");

    const report = await doctor(t.env, { storeRoot, scope: "global", agents: [] });

    expect(report.checks.find((check) => check.id === "mutation-recovery")).toMatchObject({
      status: "error",
      message: expect.stringContaining("operation-doctor"),
    });
  });

  it("retains receipts and snapshots when no-follow directory-bound deletion is unavailable", async () => {
    const snapshotsRoot = join(storeRoot, "snapshots");
    await t.env.fs.mkdir(snapshotsRoot, { recursive: true });
    const retainedSnapshot = join(snapshotsRoot, "retained.age");
    const unreachableSnapshot = join(snapshotsRoot, "unreachable.age");
    await t.env.fs.writeFile(retainedSnapshot, "retained");
    await t.env.fs.writeFile(unreachableSnapshot, "unreachable");
    await t.env.fs.publishFileAtomically(
      join(storeRoot, "state.json"),
      `${JSON.stringify(
        {
          version: 2,
          owners: [
            {
              agent: "codex",
              scope: "global",
              capability: "rules",
              target: t.path("home", ".codex", "AGENTS.md"),
              artifactIds: ["rules/style"],
              receipt: {
                method: "write",
                fingerprint: "sha256:owned",
                backup: retainedSnapshot,
                generated: true,
                appliedAt: "2026-07-28T01:00:00.000Z",
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    for (const [index, completedAt] of [
      "2026-07-28T01:00:00.000Z",
      "2026-07-28T02:00:00.000Z",
      "2026-07-28T03:00:00.000Z",
    ].entries()) {
      const receipt: OperationReceipt = {
        schemaVersion: 1,
        operationId: `operation-${index + 1}`,
        planId: `plan-${index + 1}`,
        planDigest: `sha256:${index + 1}`,
        operation: "apply",
        baseRevision: index,
        resultingRevision: index + 1,
        outcome: "committed",
        actionReceipts: [],
        startedAt: completedAt,
        completedAt,
      };
      await publishOperationReceipt(t.env, storeRoot, receipt);
    }

    const result = await pruneOperationRecoveryArtifacts(t.env, storeRoot, {
      retainReceipts: 2,
      pruneUnreferencedSnapshots: true,
    });

    expect(result.removedReceiptIds).toEqual([]);
    expect(result.removedSnapshotPaths).toEqual([]);
    expect(result.receiptPruning).toMatchObject({ status: "unsupported" });
    expect(result.snapshotPruning).toMatchObject({ status: "unsupported" });
    expect((await listOperationReceipts(t.env, storeRoot)).map((item) => item.operationId)).toEqual(
      ["operation-3", "operation-2", "operation-1"],
    );
    await expect(t.env.fs.readFile(retainedSnapshot)).resolves.toBe("retained");
    await expect(t.env.fs.readFile(unreachableSnapshot)).resolves.toBe("unreachable");
  });

  it("does not inspect or delete a symlinked snapshots root when pruning is unsupported", async () => {
    const snapshotsRoot = join(storeRoot, "snapshots");
    const outsideRoot = t.path("outside-snapshots");
    const outsideSnapshot = join(outsideRoot, "must-survive.age");
    await t.env.fs.rm(snapshotsRoot, { recursive: true, force: true });
    await t.env.fs.mkdir(outsideRoot, { recursive: true });
    await t.env.fs.writeFile(outsideSnapshot, "outside");
    await t.env.fs.symlink(outsideRoot, snapshotsRoot, "dir");

    await expect(
      pruneOperationRecoveryArtifacts(t.env, storeRoot, {
        retainReceipts: 0,
        pruneUnreferencedSnapshots: true,
      }),
    ).resolves.toMatchObject({ snapshotPruning: { status: "unsupported" } });
    await expect(t.env.fs.readFile(outsideSnapshot)).resolves.toBe("outside");
  });

  it("rejects retention while a mutation or recovery claim is held", async () => {
    const mutation = await acquireStoreMutationLock(t.env, storeRoot, {
      operationId: "operation-held",
      processId: 42,
      hostname: "test-host",
      acquiredAt: "2026-07-28T12:00:00.000Z",
    });
    if (!mutation.ok) throw new Error("expected mutation lock fixture");
    await expect(pruneOperationRecoveryArtifacts(t.env, storeRoot)).rejects.toMatchObject({
      code: "LOCK_CONFLICT",
    });
    await mutation.lock.release();

    const recovery = await acquireStoreRecoveryLock(t.env, storeRoot, {
      operationId: "recovery-held",
      processId: 43,
      hostname: "test-host",
      acquiredAt: "2026-07-28T12:01:00.000Z",
    });
    if (!recovery.ok) throw new Error("expected recovery lock fixture");
    try {
      await expect(pruneOperationRecoveryArtifacts(t.env, storeRoot)).rejects.toMatchObject({
        code: "LOCK_CONFLICT",
      });
    } finally {
      await recovery.lock.release();
    }
  });

  it("never calls rm for receipt paths through a malicious injected Env", async () => {
    const receipt: OperationReceipt = {
      schemaVersion: 1,
      operationId: "operation-survives",
      planId: "plan-survives",
      planDigest: "sha256:survives",
      operation: "apply",
      baseRevision: 0,
      resultingRevision: 1,
      outcome: "committed",
      actionReceipts: [],
      startedAt: "2026-07-28T01:00:00.000Z",
      completedAt: "2026-07-28T01:00:00.000Z",
    };
    await publishOperationReceipt(t.env, storeRoot, receipt);
    const originalRm = t.env.fs.rm;
    const receiptRmPaths: string[] = [];
    const maliciousEnv = {
      ...t.env,
      fs: {
        ...t.env.fs,
        rm: async (path: string, opts?: { recursive?: boolean; force?: boolean }) => {
          if (path.includes("/operations/receipts/")) receiptRmPaths.push(path);
          return originalRm(path, opts);
        },
      },
    };

    await expect(
      pruneOperationRecoveryArtifacts(maliciousEnv, storeRoot, { retainReceipts: 0 }),
    ).resolves.toMatchObject({
      removedReceiptIds: [],
      receiptPruning: { status: "unsupported" },
    });
    expect(receiptRmPaths).toEqual([]);
    await expect(listOperationReceipts(t.env, storeRoot)).resolves.toHaveLength(1);
  });
});
