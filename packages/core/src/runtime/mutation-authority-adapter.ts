import { createHash } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import * as nodeProcess from "node:process";
import type { HeadlessLifetimeLease, HeadlessLifetimeOwner } from "../env.js";

const HEADLESS_OWNER_SOCKET_PROBE_TIMEOUT_MS = 1_000;

interface UnixSocketIdentity {
  readonly device: number;
  readonly inode: number;
}

interface HeadlessKernelOwnerRecord {
  readonly server: Server;
  readonly endpoint: string;
  readonly unixSocketIdentity?: UnixSocketIdentity;
  readonly lease: HeadlessLifetimeLease;
}

const headlessKernelOwners = new Map<string, HeadlessKernelOwnerRecord>();
const pendingHeadlessKernelOwners = new Map<string, Promise<HeadlessLifetimeLease>>();

export function headlessLifetimeOwnerEndpoint(normalizedStoreRoot: string): string {
  const digest = createHash("sha256")
    .update("cellarer-headless-lifetime-owner-v2\0")
    .update(normalizedStoreRoot)
    .digest("hex");
  if (nodeProcess.platform === "win32") {
    return `\\\\.\\pipe\\cellarer-headless-owner-v2-${digest}`;
  }
  return join("/tmp", `.cellarer-ho-${headlessOwnerUserId()}`, digest);
}

function headlessOwnerUnavailable(): Error {
  return new Error("headless lifetime owner kernel resource is active or unavailable");
}

function headlessOwnerUserId(): number {
  const getuid = nodeProcess.getuid;
  if (!getuid) throw headlessOwnerUnavailable();
  return getuid();
}

async function ensureHeadlessSocketDirectory(endpoint: string): Promise<void> {
  const directory = dirname(endpoint);
  try {
    await nodeFs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw headlessOwnerUnavailable();
  }
  try {
    const stat = await nodeFs.lstat(directory);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.uid !== headlessOwnerUserId() ||
      (stat.mode & 0o077) !== 0
    ) {
      throw headlessOwnerUnavailable();
    }
  } catch {
    throw headlessOwnerUnavailable();
  }
}

async function readUnixSocketIdentity(endpoint: string): Promise<UnixSocketIdentity | undefined> {
  let stat: Awaited<ReturnType<typeof nodeFs.lstat>>;
  try {
    stat = await nodeFs.lstat(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw headlessOwnerUnavailable();
  }
  if (stat.isSymbolicLink() || !stat.isSocket()) throw headlessOwnerUnavailable();
  return { device: stat.dev, inode: stat.ino };
}

function sameUnixSocketIdentity(left: UnixSocketIdentity, right: UnixSocketIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

async function probeUnixSocket(endpoint: string): Promise<"active" | "stale"> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: endpoint });
    let settled = false;
    const finish = (result: "active" | "stale" | Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    socket.once("connect", () => finish("active"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish("stale");
      else finish(error);
    });
    socket.setTimeout(HEADLESS_OWNER_SOCKET_PROBE_TIMEOUT_MS, () =>
      finish(headlessOwnerUnavailable()),
    );
  });
}

async function prepareUnixSocketEndpoint(endpoint: string): Promise<void> {
  await ensureHeadlessSocketDirectory(endpoint);
  const previous = await readUnixSocketIdentity(endpoint);
  if (!previous) return;
  if ((await probeUnixSocket(endpoint)) === "active") throw headlessOwnerUnavailable();
  const confirmed = await readUnixSocketIdentity(endpoint);
  if (!confirmed || !sameUnixSocketIdentity(previous, confirmed)) {
    throw headlessOwnerUnavailable();
  }
  try {
    await nodeFs.unlink(endpoint);
  } catch {
    throw headlessOwnerUnavailable();
  }
}

async function listenHeadlessKernelOwner(server: Server, endpoint: string): Promise<void> {
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
    server.listen({ path: endpoint, exclusive: true, readableAll: false, writableAll: false });
  });
}

async function bindHeadlessKernelOwner(
  normalizedStoreRoot: string,
): Promise<HeadlessLifetimeLease> {
  const endpoint = headlessLifetimeOwnerEndpoint(normalizedStoreRoot);
  const server = createServer((socket) => socket.destroy());
  try {
    if (nodeProcess.platform !== "win32") await prepareUnixSocketEndpoint(endpoint);
    await listenHeadlessKernelOwner(server, endpoint);
  } catch {
    if (server.listening) server.close();
    throw headlessOwnerUnavailable();
  }

  server.unref();
  let healthy = true;
  let record: HeadlessKernelOwnerRecord;
  const lease = Object.freeze({
    isCurrent: async () => {
      if (
        !healthy ||
        !server.listening ||
        headlessKernelOwners.get(normalizedStoreRoot) !== record
      ) {
        return false;
      }
      if (!record.unixSocketIdentity) return true;
      try {
        const current = await readUnixSocketIdentity(record.endpoint);
        return Boolean(current && sameUnixSocketIdentity(record.unixSocketIdentity, current));
      } catch {
        return false;
      }
    },
  });
  let unixSocketIdentity: UnixSocketIdentity | undefined;
  if (nodeProcess.platform !== "win32") {
    try {
      unixSocketIdentity = await readUnixSocketIdentity(endpoint);
    } catch {
      server.close();
      throw headlessOwnerUnavailable();
    }
    if (!unixSocketIdentity) {
      server.close();
      throw headlessOwnerUnavailable();
    }
  }
  record = Object.freeze({
    server,
    endpoint,
    ...(unixSocketIdentity ? { unixSocketIdentity } : {}),
    lease,
  });
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

export const headlessLifetimeOwner: HeadlessLifetimeOwner = Object.freeze({
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

export function createRealMutationAuthorityAdapter(): {
  readonly headlessLifetimeOwner: HeadlessLifetimeOwner;
} {
  return { headlessLifetimeOwner };
}
