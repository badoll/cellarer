// createRealEnv:Env 的真实实现 —— 全 core 内唯一允许 import node:fs/os/process 的地方。
// 其余 core 模块只依赖 env.ts 的接口类型,保证可测性与跨平台。

import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as nodeFs } from "node:fs";
import * as os from "node:os";
import { basename, dirname, join } from "node:path";
import * as nodeProcess from "node:process";
import type { Env, FileStat, FsLike, Platform, ProcessLiveness, SymlinkType } from "./env.js";

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

function toFsLike(): FsLike {
  return {
    readFile: (path) => nodeFs.readFile(path, "utf8"),
    readFileBytes: (path) => nodeFs.readFile(path),
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
  };
}
