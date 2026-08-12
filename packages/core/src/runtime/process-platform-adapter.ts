import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as nodeProcess from "node:process";
import type { Env, Platform, ProcessLiveness } from "../env.js";

type ProcessPlatformEnv = Pick<
  Env,
  | "homedir"
  | "cwd"
  | "platform"
  | "processId"
  | "hostname"
  | "probeProcessLiveness"
  | "randomId"
  | "now"
  | "env"
>;

export function createRealProcessPlatformAdapter(): ProcessPlatformEnv {
  return {
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

async function probeProcessLiveness(processId: number): Promise<ProcessLiveness> {
  if (!Number.isSafeInteger(processId) || processId <= 0) return "unknown";
  try {
    nodeProcess.kill(processId, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}
