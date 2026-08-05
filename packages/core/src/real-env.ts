// createRealEnv:Env 的真实实现 —— 全 core 内唯一允许 import node:fs/os/process 的地方。
// 其余 core 模块只依赖 env.ts 的接口类型,保证可测性与跨平台。

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  promises as nodeFs,
  openSync,
  readFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import * as os from "node:os";
import { basename, dirname, join } from "node:path";
import * as nodeProcess from "node:process";
import type {
  Env,
  FileStat,
  FileTreeSnapshot,
  FileTreeSnapshotNode,
  FsLike,
  HeadlessLifetimeLease,
  HeadlessLifetimeOwner,
  Platform,
  ProcessLiveness,
  SymlinkType,
} from "./env.js";

const HEADLESS_OWNER_HOST = "127.0.0.1";
const HEADLESS_OWNER_PORT_MIN = 49_152;
const HEADLESS_OWNER_PORT_COUNT = 16_384;

interface HeadlessKernelOwnerRecord {
  readonly server: Server;
  readonly lease: HeadlessLifetimeLease;
}

const headlessKernelOwners = new Map<string, HeadlessKernelOwnerRecord>();
const pendingHeadlessKernelOwners = new Map<string, Promise<HeadlessLifetimeLease>>();

export function headlessLifetimeOwnerPort(normalizedStoreRoot: string): number {
  const digest = createHash("sha256")
    .update("cellarer-headless-lifetime-owner-v1\0")
    .update(normalizedStoreRoot)
    .digest();
  return HEADLESS_OWNER_PORT_MIN + (digest.readUInt16BE(0) % HEADLESS_OWNER_PORT_COUNT);
}

async function bindHeadlessKernelOwner(
  normalizedStoreRoot: string,
): Promise<HeadlessLifetimeLease> {
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({
        host: HEADLESS_OWNER_HOST,
        port: headlessLifetimeOwnerPort(normalizedStoreRoot),
        exclusive: true,
      });
    });
  } catch {
    if (server.listening) server.close();
    throw new Error("headless lifetime owner kernel resource is active or unavailable");
  }

  server.unref();
  let healthy = true;
  let record: HeadlessKernelOwnerRecord;
  const lease = Object.freeze({
    isCurrent: async () =>
      healthy && server.listening && headlessKernelOwners.get(normalizedStoreRoot) === record,
  });
  record = Object.freeze({ server, lease });
  headlessKernelOwners.set(normalizedStoreRoot, record);
  server.on("error", () => {
    healthy = false;
    if (headlessKernelOwners.get(normalizedStoreRoot) === record) {
      headlessKernelOwners.delete(normalizedStoreRoot);
    }
    if (server.listening) server.close();
  });
  server.once("close", () => {
    healthy = false;
    if (headlessKernelOwners.get(normalizedStoreRoot) === record) {
      headlessKernelOwners.delete(normalizedStoreRoot);
    }
  });
  return lease;
}

const headlessLifetimeOwner: HeadlessLifetimeOwner = Object.freeze({
  acquire: async (normalizedStoreRoot: string): Promise<HeadlessLifetimeLease> => {
    const current = headlessKernelOwners.get(normalizedStoreRoot);
    if (current && (await current.lease.isCurrent())) return current.lease;
    if (current) headlessKernelOwners.delete(normalizedStoreRoot);

    const pending = pendingHeadlessKernelOwners.get(normalizedStoreRoot);
    if (pending) return pending;
    const acquisition = bindHeadlessKernelOwner(normalizedStoreRoot);
    pendingHeadlessKernelOwners.set(normalizedStoreRoot, acquisition);
    try {
      return await acquisition;
    } finally {
      if (pendingHeadlessKernelOwners.get(normalizedStoreRoot) === acquisition) {
        pendingHeadlessKernelOwners.delete(normalizedStoreRoot);
      }
    }
  },
});

function publicationTempPath(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.${nodeProcess.pid}.${randomUUID()}.cellarer-publish`,
  );
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof nodeFs.open>> | undefined;
  try {
    handle = await nodeFs.open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows does not consistently permit opening directories for FlushFileBuffers.
    if (nodeProcess.platform !== "win32" || (code !== "EPERM" && code !== "EISDIR")) throw error;
  } finally {
    await handle?.close();
  }
}

async function writeDurableTemp(path: string, data: string, mode?: number): Promise<void> {
  const handle = await nodeFs.open(path, "wx", mode);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function snapshotFailure(
  code:
    | "CELLARER_SNAPSHOT_SYMLINK"
    | "CELLARER_SNAPSHOT_NON_REGULAR"
    | "CELLARER_SNAPSHOT_STALE"
    | "CELLARER_SNAPSHOT_UNSUPPORTED",
  path: string,
): Error & { code: string; path: string } {
  return Object.assign(new Error(`safe source snapshot failed at ${path}`), { code, path });
}

function statIdentity(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
  ].join(":");
}

function sameNode(left: BigIntStats, right: BigIntStats): boolean {
  return statIdentity(left) === statIdentity(right);
}

export interface SnapshotRuntimeSupport {
  readonly platform: "darwin" | "linux";
  readonly arch: "x64" | "arm64";
}

export function snapshotRuntimeSupport(
  platform: string,
  arch: string,
  path = "<snapshot>",
): SnapshotRuntimeSupport {
  if ((platform !== "darwin" && platform !== "linux") || (arch !== "x64" && arch !== "arm64")) {
    throw snapshotFailure("CELLARER_SNAPSHOT_UNSUPPORTED", path);
  }
  return Object.freeze({ platform, arch });
}

function requiredSnapshotOpenFlags(path: string): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number" || typeof fsConstants.O_NONBLOCK !== "number") {
    throw snapshotFailure("CELLARER_SNAPSHOT_UNSUPPORTED", path);
  }
  // Node does not expose O_CLOEXEC on every supported POSIX build. These values are stable ABI
  // constants on Darwin and Linux; unknown platforms fail closed instead of guessing.
  const closeOnExecConstant = (fsConstants as typeof fsConstants & { O_CLOEXEC?: number })
    .O_CLOEXEC;
  const closeOnExec =
    typeof closeOnExecConstant === "number"
      ? closeOnExecConstant
      : nodeProcess.platform === "darwin"
        ? 0x01000000
        : nodeProcess.platform === "linux"
          ? 0x00080000
          : undefined;
  if (closeOnExec === undefined) throw snapshotFailure("CELLARER_SNAPSHOT_UNSUPPORTED", path);
  return fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | closeOnExec | fsConstants.O_NONBLOCK;
}

interface SnapshotWorkerNode {
  readonly relativePath: string;
  readonly kind: "file" | "directory";
  readonly mode: number;
  readonly identity: string;
  readonly data?: string;
}

interface SnapshotWorkerResult {
  readonly ok: boolean;
  readonly nodes?: readonly SnapshotWorkerNode[];
  readonly code?: string;
  readonly path?: string;
}

async function snapshotWorkerMain(): Promise<void> {
  const getBuiltinModule = (
    process as typeof process & {
      getBuiltinModule?: (name: string) => unknown;
    }
  ).getBuiltinModule;
  if (!getBuiltinModule) throw new Error("snapshot runtime is unsupported");
  const { constants, closeSync, fstatSync, openSync, readFileSync, readdirSync, statSync } =
    getBuiltinModule("node:fs") as typeof import("node:fs");
  const input = JSON.parse(readFileSync(0, "utf8")) as {
    expectedRoot: string;
    includeData: boolean;
  };
  const nodes: SnapshotWorkerNode[] = [];
  const identity = (stat: BigIntStats): string =>
    [
      stat.dev,
      stat.ino,
      stat.mode,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
      stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
    ].join(":");
  const fail = (code: string, path: string): never => {
    throw Object.assign(new Error("snapshot failed"), { code, path });
  };
  const flags = (() => {
    if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
      return fail("CELLARER_SNAPSHOT_UNSUPPORTED", "");
    }
    const exposed = (constants as typeof constants & { O_CLOEXEC?: number }).O_CLOEXEC;
    const closeOnExec =
      typeof exposed === "number"
        ? exposed
        : process.platform === "darwin"
          ? 0x01000000
          : process.platform === "linux"
            ? 0x00080000
            : undefined;
    if (closeOnExec === undefined) return fail("CELLARER_SNAPSHOT_UNSUPPORTED", "");
    return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec;
  })();

  const visitDirectory = (relativePath: string, expectedIdentity: string): void => {
    const before = statSync(".", { bigint: true });
    if (!before.isDirectory() || identity(before) !== expectedIdentity) {
      fail("CELLARER_SNAPSHOT_STALE", relativePath);
    }
    for (const name of readdirSync(".").sort((left, right) => left.localeCompare(right))) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
        fail("CELLARER_SNAPSHOT_STALE", relativePath);
      }
      const childPath = relativePath ? `${relativePath}/${name}` : name;
      const fd = (() => {
        try {
          return openSync(name, flags);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          return fail(
            code === "ELOOP" ? "CELLARER_SNAPSHOT_SYMLINK" : "CELLARER_SNAPSHOT_STALE",
            childPath,
          );
        }
      })();
      try {
        const opened = fstatSync(fd, { bigint: true });
        const openedIdentity = identity(opened);
        if (opened.isFile()) {
          const data = input.includeData ? readFileSync(fd).toString("base64") : undefined;
          const after = fstatSync(fd, { bigint: true });
          if (identity(after) !== openedIdentity) fail("CELLARER_SNAPSHOT_STALE", childPath);
          nodes.push({
            relativePath: childPath,
            kind: "file",
            mode: Number(after.mode & 0o7777n),
            identity: identity(after),
            ...(data === undefined ? {} : { data }),
          });
        } else if (opened.isDirectory()) {
          process.chdir(name);
          if (identity(statSync(".", { bigint: true })) !== openedIdentity) {
            fail("CELLARER_SNAPSHOT_STALE", childPath);
          }
          visitDirectory(childPath, openedIdentity);
          process.chdir("..");
          if (identity(statSync(".", { bigint: true })) !== identity(before)) {
            fail("CELLARER_SNAPSHOT_STALE", relativePath);
          }
          if (identity(fstatSync(fd, { bigint: true })) !== openedIdentity) {
            fail("CELLARER_SNAPSHOT_STALE", childPath);
          }
        } else {
          fail("CELLARER_SNAPSHOT_NON_REGULAR", childPath);
        }
      } finally {
        closeSync(fd);
      }
    }
    const after = statSync(".", { bigint: true });
    if (identity(after) !== identity(before)) fail("CELLARER_SNAPSHOT_STALE", relativePath);
    nodes.push({
      relativePath,
      kind: "directory",
      mode: Number(after.mode & 0o7777n),
      identity: identity(after),
    });
  };

  try {
    visitDirectory("", input.expectedRoot);
    process.stdout.write(JSON.stringify({ ok: true, nodes }));
  } catch (error) {
    const detail = error as { code?: unknown; path?: unknown };
    process.stdout.write(
      JSON.stringify({
        ok: false,
        code: typeof detail.code === "string" ? detail.code : "CELLARER_SNAPSHOT_STALE",
        path: typeof detail.path === "string" ? detail.path : "",
      }),
    );
  }
}

const SNAPSHOT_WORKER_SOURCE = `(${snapshotWorkerMain.toString()})()`;

function runSnapshotWorker(
  rootPath: string,
  expectedRoot: string,
  includeData: boolean,
): FileTreeSnapshotNode[] {
  let output: string;
  try {
    output = execFileSync(
      nodeProcess.execPath,
      ["--input-type=module", "--eval", SNAPSHOT_WORKER_SOURCE],
      {
        cwd: rootPath,
        input: JSON.stringify({ expectedRoot, includeData }),
        encoding: "utf8",
        env: {},
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch {
    throw snapshotFailure("CELLARER_SNAPSHOT_STALE", rootPath);
  }
  let result: SnapshotWorkerResult;
  try {
    result = JSON.parse(output) as SnapshotWorkerResult;
  } catch {
    throw snapshotFailure("CELLARER_SNAPSHOT_STALE", rootPath);
  }
  if (!result.ok || !Array.isArray(result.nodes)) {
    const relativePath = typeof result.path === "string" ? result.path : "";
    const path = relativePath ? join(rootPath, ...relativePath.split("/")) : rootPath;
    const code =
      result.code === "CELLARER_SNAPSHOT_SYMLINK" ||
      result.code === "CELLARER_SNAPSHOT_NON_REGULAR" ||
      result.code === "CELLARER_SNAPSHOT_UNSUPPORTED"
        ? result.code
        : "CELLARER_SNAPSHOT_STALE";
    throw snapshotFailure(code, path);
  }
  return result.nodes.map((node) => {
    if (
      (node.kind !== "file" && node.kind !== "directory") ||
      typeof node.relativePath !== "string" ||
      typeof node.mode !== "number" ||
      typeof node.identity !== "string" ||
      (includeData && node.kind === "file" && typeof node.data !== "string")
    ) {
      throw snapshotFailure("CELLARER_SNAPSHOT_STALE", rootPath);
    }
    const data = node.data === undefined ? undefined : Buffer.from(node.data, "base64");
    if (node.data !== undefined && data?.toString("base64") !== node.data) {
      throw snapshotFailure("CELLARER_SNAPSHOT_STALE", rootPath);
    }
    return Object.freeze({
      relativePath: node.relativePath,
      kind: node.kind,
      mode: node.mode,
      identity: node.identity,
      ...(data === undefined ? {} : { data: new Uint8Array(data) }),
    });
  });
}

function snapshotFileNoFollowSync(rootPath: string, includeData: boolean): FileTreeSnapshot {
  const before = lstatSync(rootPath, { bigint: true });
  if (before.isSymbolicLink()) {
    throw snapshotFailure("CELLARER_SNAPSHOT_SYMLINK", rootPath);
  }
  if (!before.isFile()) {
    throw snapshotFailure("CELLARER_SNAPSHOT_NON_REGULAR", rootPath);
  }
  const optionalNoFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const optionalNonBlock = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
  const closeOnExec = (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC;
  const optionalCloseOnExec = typeof closeOnExec === "number" ? closeOnExec : 0;
  const fd = (() => {
    try {
      return openSync(
        rootPath,
        fsConstants.O_RDONLY | optionalNoFollow | optionalNonBlock | optionalCloseOnExec,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw snapshotFailure("CELLARER_SNAPSHOT_SYMLINK", rootPath);
      }
      throw error;
    }
  })();
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameNode(before, opened)) {
      throw snapshotFailure("CELLARER_SNAPSHOT_STALE", rootPath);
    }
    const data = includeData ? new Uint8Array(readFileSync(fd)) : undefined;
    const after = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(rootPath, { bigint: true });
    if (!sameNode(opened, after) || !sameNode(after, afterPath)) {
      throw snapshotFailure("CELLARER_SNAPSHOT_STALE", rootPath);
    }
    return Object.freeze({
      rootPath,
      nodes: Object.freeze([
        Object.freeze({
          relativePath: "",
          kind: "file" as const,
          mode: Number(after.mode & 0o7777n),
          identity: statIdentity(after),
          ...(data === undefined ? {} : { data }),
        }),
      ]),
    });
  } finally {
    closeSync(fd);
  }
}

function snapshotTreeNoFollowSync(rootPath: string, includeData: boolean): FileTreeSnapshot {
  snapshotRuntimeSupport(nodeProcess.platform, nodeProcess.arch, rootPath);
  const before = lstatSync(rootPath, { bigint: true });
  if (before.isSymbolicLink()) {
    throw snapshotFailure("CELLARER_SNAPSHOT_SYMLINK", rootPath);
  }
  if (!before.isDirectory()) {
    throw snapshotFailure("CELLARER_SNAPSHOT_NON_REGULAR", rootPath);
  }
  const fd = openSync(rootPath, requiredSnapshotOpenFlags(rootPath));
  let nodes: FileTreeSnapshotNode[];
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || !sameNode(before, opened)) {
      throw snapshotFailure("CELLARER_SNAPSHOT_STALE", rootPath);
    }
    nodes = runSnapshotWorker(rootPath, statIdentity(opened), includeData);
    const after = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(rootPath, { bigint: true });
    if (!sameNode(opened, after) || !sameNode(after, afterPath)) {
      throw snapshotFailure("CELLARER_SNAPSHOT_STALE", rootPath);
    }
  } finally {
    closeSync(fd);
  }
  return Object.freeze({
    rootPath,
    nodes: Object.freeze(
      nodes.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    ),
  });
}

async function snapshotFileNoFollow(rootPath: string): Promise<FileTreeSnapshot> {
  return snapshotFileNoFollowSync(rootPath, true);
}

async function snapshotTreeNoFollow(rootPath: string): Promise<FileTreeSnapshot> {
  return snapshotTreeNoFollowSync(rootPath, true);
}

async function verifyTreeSnapshot(snapshot: FileTreeSnapshot): Promise<boolean> {
  try {
    const current = snapshotTreeNoFollowSync(snapshot.rootPath, false);
    return (
      current.nodes.length === snapshot.nodes.length &&
      current.nodes.every((node, index) => {
        const expected = snapshot.nodes[index];
        return (
          expected !== undefined &&
          node.relativePath === expected.relativePath &&
          node.kind === expected.kind &&
          node.mode === expected.mode &&
          node.identity === expected.identity
        );
      })
    );
  } catch {
    return false;
  }
}

async function verifyFileSnapshot(snapshot: FileTreeSnapshot): Promise<boolean> {
  try {
    const current = snapshotFileNoFollowSync(snapshot.rootPath, false);
    const expected = snapshot.nodes[0];
    const actual = current.nodes[0];
    return (
      snapshot.nodes.length === 1 &&
      current.nodes.length === 1 &&
      expected !== undefined &&
      actual !== undefined &&
      expected.kind === "file" &&
      actual.kind === "file" &&
      expected.mode === actual.mode &&
      expected.identity === actual.identity
    );
  } catch {
    return false;
  }
}

function toFsLike(): FsLike {
  return {
    readFile: (path) => nodeFs.readFile(path, "utf8"),
    readFileBytes: (path) => nodeFs.readFile(path),
    snapshotFileNoFollow,
    verifyFileSnapshot,
    supportsSafeRecursiveSnapshots: () => {
      try {
        snapshotRuntimeSupport(nodeProcess.platform, nodeProcess.arch);
        return true;
      } catch {
        return false;
      }
    },
    snapshotTreeNoFollow,
    verifyTreeSnapshot,
    writeFile: (path, data, opts) =>
      nodeFs.writeFile(path, data, { encoding: "utf8", mode: opts?.mode }),
    writeFileBytes: (path, data, opts) => nodeFs.writeFile(path, data, { mode: opts?.mode }),
    writeFileExclusive: async (path, data, opts) => {
      const dir = dirname(path);
      const temporary = publicationTempPath(path);
      await nodeFs.mkdir(dir, { recursive: true });
      try {
        await writeDurableTemp(temporary, data, opts?.mode);
        try {
          await nodeFs.link(temporary, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw error;
        }
        return true;
      } finally {
        await nodeFs.rm(temporary, { force: true }).catch(() => {});
        await syncDirectory(dir);
      }
    },
    publishFileAtomically: async (path, data, opts) => {
      const dir = dirname(path);
      const temporary = publicationTempPath(path);
      await nodeFs.mkdir(dir, { recursive: true });
      try {
        await writeDurableTemp(temporary, data, opts?.mode);
        await nodeFs.rename(temporary, path);
        await syncDirectory(dir);
      } catch (error) {
        await nodeFs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    },
    appendFile: (path, data) => nodeFs.appendFile(path, data, "utf8"),
    access: (path, mode) =>
      nodeFs.access(path, mode === "read" ? fsConstants.R_OK : fsConstants.W_OK),
    mkdir: async (path, opts) => {
      await nodeFs.mkdir(path, { recursive: opts?.recursive ?? false, mode: opts?.mode });
    },
    chmod: (path, mode) => nodeFs.chmod(path, mode),
    rm: (path, opts) => nodeFs.rm(path, opts),
    readdir: (path) => nodeFs.readdir(path),
    lstat: async (path): Promise<FileStat> => nodeFs.lstat(path),
    stat: async (path): Promise<FileStat> => nodeFs.stat(path),
    readlink: (path) => nodeFs.readlink(path, "utf8"),
    symlink: async (target, path, type?: SymlinkType) => {
      await nodeFs.symlink(target, path, type);
    },
    copyFile: (src, dest) => nodeFs.copyFile(src, dest),
    cp: (src, dest, opts) => nodeFs.cp(src, dest, { recursive: opts?.recursive ?? false }),
    realpath: (path) => nodeFs.realpath(path),
    rename: (oldPath, newPath) => nodeFs.rename(oldPath, newPath),
  };
}

async function probeProcessLiveness(processId: number): Promise<ProcessLiveness> {
  if (!Number.isSafeInteger(processId) || processId <= 0) return "unknown";
  try {
    nodeProcess.kill(processId, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    // EPERM proves that the PID exists even though the caller cannot signal it.
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

export function createRealEnv(): Env {
  return {
    fs: toFsLike(),
    homedir: () => os.homedir(),
    cwd: () => nodeProcess.cwd(),
    platform: nodeProcess.platform as Platform,
    processId: () => nodeProcess.pid,
    hostname: () => os.hostname(),
    probeProcessLiveness,
    randomId: () => randomUUID(),
    now: () => new Date(),
    env: nodeProcess.env,
    headlessLifetimeOwner,
    currentUserOnlyPermissions: {
      supported: (platform) => platform !== "win32",
      set: (path) => nodeFs.chmod(path, 0o600),
      verify: async (path) => {
        const stat = await nodeFs.lstat(path);
        return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0;
      },
    },
  };
}
