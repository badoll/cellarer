// 测试基座:基于 mkdtemp 临时目录的真实 Env + 可注入覆盖(platform / now / env)。
// 测试可直接 import node:fs/os(不变量 2 只约束 core/src);
// fs 原语(symlink/junction/copy)语义无法忠实 fake,故用真实临时目录。
import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env, Platform, ProcessLiveness } from "../../src/env.js";
import { createRealEnv } from "../../src/real-env.js";

export interface TmpEnv {
  env: Env;
  // 临时目录绝对路径(已 realpath 解析,macOS 下 /var → /private/var)。
  root: string;
  // 临时目录内拼路径。
  path(...segs: string[]): string;
  // 清理临时目录。
  cleanup(): Promise<void>;
}

export interface TmpEnvOptions {
  platform?: Platform;
  now?: Date;
  env?: Record<string, string | undefined>;
  // 覆盖 homedir / cwd(默认指向临时目录下的 home / cwd 子目录)。
  homedir?: string;
  cwd?: string;
  processId?: number;
  hostname?: string;
  probeProcessLiveness?: (processId: number) => Promise<ProcessLiveness>;
  randomId?: () => string;
}

// 固定时间戳,便于断言台账可重现。
export const FIXED_NOW = new Date("2026-06-30T08:00:00.000Z");

export function makeTmpEnv(opts: TmpEnvOptions = {}): TmpEnv {
  // realpath 解析:macOS 临时目录是 /var/... 软链到 /private/var/...,
  // 不解析会让 realpath 比较与 safety 校验出现误判。
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-test-")));

  const real = createRealEnv();
  const homedir = opts.homedir ?? join(root, "home");
  const cwd = opts.cwd ?? join(root, "cwd");
  const processId = opts.processId ?? real.processId();

  const env: Env = {
    fs: real.fs,
    homedir: () => homedir,
    cwd: () => cwd,
    platform: opts.platform ?? "darwin",
    processId: () => processId,
    hostname: () => opts.hostname ?? "cellarer-test",
    probeProcessLiveness:
      opts.probeProcessLiveness ??
      (async (candidate) => (candidate === processId ? "alive" : "unknown")),
    randomId: opts.randomId ?? real.randomId,
    now: () => opts.now ?? FIXED_NOW,
    env: opts.env ?? {},
  };

  return {
    env,
    root,
    path: (...segs) => join(root, ...segs),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

// 在临时 Env 下预建 home/cwd 目录(多数测试需要)。
export async function ensureBaseDirs(t: TmpEnv): Promise<void> {
  await t.env.fs.mkdir(t.env.homedir(), { recursive: true });
  await t.env.fs.mkdir(t.env.cwd(), { recursive: true });
}
