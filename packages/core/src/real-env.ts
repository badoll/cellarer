// createRealEnv:Env 的真实实现 —— 全 core 内唯一允许 import node:fs/os/process 的地方。
// 其余 core 模块只依赖 env.ts 的接口类型,保证可测性与跨平台。
import { constants as fsConstants, promises as nodeFs } from "node:fs";
import * as os from "node:os";
import * as nodeProcess from "node:process";
import type { Env, FileStat, FsLike, Platform, SymlinkType } from "./env.js";

function toFsLike(): FsLike {
  return {
    readFile: (path) => nodeFs.readFile(path, "utf8"),
    writeFile: (path, data) => nodeFs.writeFile(path, data, "utf8"),
    appendFile: (path, data) => nodeFs.appendFile(path, data, "utf8"),
    access: (path, mode) =>
      nodeFs.access(path, mode === "read" ? fsConstants.R_OK : fsConstants.W_OK),
    mkdir: async (path, opts) => {
      await nodeFs.mkdir(path, { recursive: opts?.recursive ?? false });
    },
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

export function createRealEnv(): Env {
  return {
    fs: toFsLike(),
    homedir: () => os.homedir(),
    cwd: () => nodeProcess.cwd(),
    platform: nodeProcess.platform as Platform,
    now: () => new Date(),
    env: nodeProcess.env,
  };
}
