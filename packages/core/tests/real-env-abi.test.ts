import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyWindowsSnapshotIdentity,
  createRealEnv,
  SNAPSHOT_WORKER_BUDGET,
  type SnapshotWorkerRunner,
  snapshotRuntimeSupport,
} from "../src/real-env.js";

describe("dependency-free snapshot runtime allowlist", () => {
  it.each([
    ["darwin", "x64"],
    ["darwin", "arm64"],
    ["linux", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
    ["win32", "arm64"],
  ] as const)("supports the Node runtime primitive on %s/%s", (platform, arch) => {
    expect(snapshotRuntimeSupport(platform, arch)).toEqual({ platform, arch });
  });

  it.each([
    ["freebsd", "x64"],
    ["openbsd", "x64"],
    ["linux", "ia32"],
    ["linux", "loong64"],
    ["linux", "riscv64"],
    ["solaris", "mips64"],
  ] as const)("fails closed for unsupported %s/%s before FFI is loaded", (platform, arch) => {
    expect(() => snapshotRuntimeSupport(platform, arch)).toThrow(
      expect.objectContaining({ code: "CELLARER_SNAPSHOT_UNSUPPORTED" }),
    );
  });
});

describe("bounded snapshot worker", () => {
  it("budgets a roughly 192 MiB file above the old output threshold with bounded IPC", () => {
    const reviewerFileBytes = 192 * 1024 * 1024;

    expect(SNAPSHOT_WORKER_BUDGET.maxSingleFileBytes).toBeGreaterThanOrEqual(reviewerFileBytes);
    expect(SNAPSHOT_WORKER_BUDGET.maxTotalFileBytes).toBeGreaterThanOrEqual(reviewerFileBytes);
    expect(SNAPSHOT_WORKER_BUDGET.maxOutputBytes).toBeGreaterThan(256 * 1024 * 1024);
    expect(SNAPSHOT_WORKER_BUDGET.maxNodes).toBeGreaterThan(0);
    expect(SNAPSHOT_WORKER_BUDGET.timeoutMs).toBeGreaterThan(0);
  });

  it("captures a sparse 192 MiB file whose base64 JSON exceeds the old 256 MiB worker buffer", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-worker-large-file-")));
    try {
      const anchor = join(root, "anchor");
      const target = join(anchor, "store", "rules", "large.md");
      const reviewerFileBytes = 192 * 1024 * 1024;
      await fs.mkdir(join(anchor, "store", "rules"), { recursive: true });
      await fs.writeFile(target, "");
      await fs.truncate(target, reviewerFileBytes);
      const candidate = Reflect.get(createRealEnv().fs, "snapshotPathNoFollow");
      if (typeof candidate !== "function") throw new Error("missing snapshotPathNoFollow");

      const snapshot = (await candidate(anchor, target)) as {
        nodes: readonly { data?: Uint8Array }[];
      };
      expect(snapshot.nodes).toHaveLength(1);
      expect(snapshot.nodes[0]?.data?.byteLength).toBe(reviewerFileBytes);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects an over-budget sparse file before the worker reads its bytes", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-worker-over-budget-")));
    try {
      const anchor = join(root, "anchor");
      const target = join(anchor, "store", "rules", "too-large.md");
      await fs.mkdir(join(anchor, "store", "rules"), { recursive: true });
      await fs.writeFile(target, "");
      await fs.truncate(target, SNAPSHOT_WORKER_BUDGET.maxSingleFileBytes + 1);
      const candidate = Reflect.get(createRealEnv().fs, "snapshotPathNoFollow");
      if (typeof candidate !== "function") throw new Error("missing snapshotPathNoFollow");

      await expect(candidate(anchor, target)).rejects.toMatchObject({
        code: "CELLARER_SNAPSHOT_BUDGET_EXCEEDED",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes paths only through bounded JSON input and exposes timeout/output limits to the runner", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-worker-runner-")));
    try {
      const anchor = join(root, "anchor-canary");
      const target = join(anchor, "store", "rules");
      await fs.mkdir(target, { recursive: true });
      const calls: Parameters<SnapshotWorkerRunner>[0][] = [];
      const runner: SnapshotWorkerRunner = (request) => {
        calls.push(request);
        return JSON.stringify({
          ok: true,
          exists: true,
          nodes: [
            {
              relativePath: "",
              kind: "directory",
              mode: 0o700,
              identity: "test-directory-identity",
            },
          ],
        });
      };
      const candidate = Reflect.get(
        createRealEnv({ snapshotWorkerRunner: runner }).fs,
        "snapshotPathNoFollow",
      );
      if (typeof candidate !== "function") throw new Error("missing snapshotPathNoFollow");

      await expect(candidate(anchor, target)).resolves.toMatchObject({
        nodes: [expect.objectContaining({ relativePath: "" })],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.source).not.toContain(anchor);
      expect(calls[0]?.source).not.toContain(target);
      expect(calls[0]?.input).toContain("anchor-canary");
      expect(calls[0]?.timeoutMs).toBe(SNAPSHOT_WORKER_BUDGET.timeoutMs);
      expect(calls[0]?.maxOutputBytes).toBe(SNAPSHOT_WORKER_BUDGET.maxOutputBytes);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["timeout", Object.assign(new Error("hung worker"), { code: "ETIMEDOUT", killed: true })],
    ["output budget", Object.assign(new Error("maxBuffer exceeded"), { code: "ENOBUFS" })],
  ] as const)("maps injected worker %s failures to a typed fail-closed result", async (_case, failure) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-worker-failure-")));
    try {
      const anchor = join(root, "anchor");
      const target = join(anchor, "store", "rules");
      await fs.mkdir(target, { recursive: true });
      const runner: SnapshotWorkerRunner = () => {
        throw failure;
      };
      const candidate = Reflect.get(
        createRealEnv({ snapshotWorkerRunner: runner }).fs,
        "snapshotPathNoFollow",
      );
      if (typeof candidate !== "function") throw new Error("missing snapshotPathNoFollow");

      await expect(candidate(anchor, target)).rejects.toMatchObject({
        code:
          _case === "timeout" ? "CELLARER_SNAPSHOT_TIMEOUT" : "CELLARER_SNAPSHOT_BUDGET_EXCEEDED",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Win32 snapshot identity classifier", () => {
  it.each([
    ["ordinary path", false, "same", "same", "c:\\store\\rules", "c:\\store\\rules", null],
    [
      "junction visible to Node",
      true,
      "same",
      "same",
      "c:\\store\\rules",
      "c:\\outside",
      "CELLARER_SNAPSHOT_SYMLINK",
    ],
    [
      "reparse-like realpath mismatch",
      false,
      "same",
      "same",
      "c:\\store\\rules",
      "c:\\outside",
      "CELLARER_SNAPSHOT_SYMLINK",
    ],
    [
      "identity mismatch",
      false,
      "before",
      "after",
      "c:\\store\\rules",
      "c:\\store\\rules",
      "CELLARER_SNAPSHOT_STALE",
    ],
  ] as const)("classifies %s without claiming an unavailable real Win32 runner", (_case, symbolic, linkedIdentity, expectedIdentity, lexicalPath, realPath, expected) => {
    expect(
      classifyWindowsSnapshotIdentity({
        symbolic,
        linkedIdentity,
        expectedIdentity,
        lexicalPath,
        realPath,
      }),
    ).toBe(expected);
  });
});

describe("anchored no-follow Store snapshots", () => {
  it("captures present and missing descendants relative to one stable anchor", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-anchored-snapshot-")));
    try {
      const anchor = join(root, "store-root");
      const capabilityRoot = join(anchor, "store", "rules");
      await fs.mkdir(capabilityRoot, { recursive: true });
      await fs.writeFile(join(capabilityRoot, "style.md"), "# style");
      const candidate = Reflect.get(createRealEnv().fs, "snapshotPathNoFollow");
      expect(candidate).toBeTypeOf("function");
      if (typeof candidate !== "function") return;

      const capture = candidate.bind(createRealEnv().fs) as (
        anchorRoot: string,
        path: string,
      ) => Promise<{ nodes: readonly { relativePath: string }[] } | null>;
      await expect(capture(anchor, capabilityRoot)).resolves.toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({ relativePath: "" }),
          expect.objectContaining({ relativePath: "style.md" }),
        ]),
      });
      await expect(capture(anchor, join(anchor, "store", "mcp"))).resolves.toBeNull();
      const absentAnchor = join(root, "not-created");
      await expect(capture(absentAnchor, join(absentAnchor, "store", "rules"))).resolves.toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an ancestor symlink before reading descendant bytes", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-anchored-symlink-")));
    try {
      const actual = join(root, "actual");
      const alias = join(root, "alias");
      await fs.mkdir(join(actual, "store", "rules"), { recursive: true });
      await fs.writeFile(join(actual, "store", "rules", "outside.md"), "outside sentinel");
      await fs.symlink(actual, alias, "dir");
      const candidate = Reflect.get(createRealEnv().fs, "snapshotPathNoFollow");
      expect(candidate).toBeTypeOf("function");
      if (typeof candidate !== "function") return;
      const capture = candidate.bind(createRealEnv().fs) as (
        anchorRoot: string,
        path: string,
      ) => Promise<unknown>;

      await expect(capture(alias, join(alias, "store", "rules"))).rejects.toMatchObject({
        code: expect.stringMatching(/SYMLINK|STALE/),
      });
      await expect(fs.readFile(join(actual, "store", "rules", "outside.md"), "utf8")).resolves.toBe(
        "outside sentinel",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
