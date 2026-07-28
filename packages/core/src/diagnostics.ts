import { dirname, join } from "node:path";
import type { Registry } from "./adapters/registry.js";
import { loadRegistry } from "./adapters/registry.js";
import type { AgentAdapter, AgentPaths } from "./adapters/types.js";
import type { Env, FileStat } from "./env.js";
import { readFileOrNull, statOrNull } from "./fs/probe.js";
import type { Capability, LinkMethod, Scope } from "./model/index.js";
import { operationJournalPath } from "./protocol/journal.js";
import {
  type MutationRecoveryPresentation,
  mutationRecoveryPresentation,
} from "./protocol/presentation.js";
import { diagnoseMutationRecovery } from "./protocol/recovery.js";
import { type CellarerConfig, CONFIG_FILENAME, loadConfig, parseConfig } from "./store/config.js";
import { loadLedger } from "./store/ledger.js";

const CAPABILITIES: Capability[] = ["rules", "mcp", "skills"];

export type DiagnosticStatus = "ok" | "warning" | "error";

export interface DiagnosticCheck {
  id: string;
  status: DiagnosticStatus;
  message: string;
  path?: string;
}

export interface AgentInspection {
  id: string;
  displayName: string;
  enabled: boolean;
  scope: Scope;
  detected: boolean;
  root?: string;
  supportedCapabilities: Capability[];
  capabilities: Record<Capability, Scope[]>;
  paths: AgentPaths;
  warnings: string[];
}

export interface InspectAgentsOptions {
  storeRoot: string;
  scope: Scope;
  dir?: string;
  agents?: string[];
}

export interface AgentInspectionReport {
  storeRoot: string;
  scope: Scope;
  dir?: string;
  agents: AgentInspection[];
  warnings: string[];
}

export interface AgentDoctorReport extends AgentInspection {
  checks: DiagnosticCheck[];
}

export interface DoctorReport {
  storeRoot: string;
  scope: Scope;
  dir?: string;
  defaultMethod?: LinkMethod;
  checks: DiagnosticCheck[];
  mutationRecovery: MutationRecoveryPresentation;
  agents: AgentDoctorReport[];
  warnings: string[];
}

export async function inspectAgents(
  env: Env,
  opts: InspectAgentsOptions,
): Promise<AgentInspectionReport> {
  const [config, registry] = await Promise.all([
    loadConfig(env, opts.storeRoot),
    loadRegistry(env, opts.storeRoot),
  ]);
  return {
    storeRoot: opts.storeRoot,
    scope: opts.scope,
    dir: opts.dir,
    agents: await inspectRegisteredAgents(env, opts, registry, config),
    warnings: registryWarnings(opts, registry),
  };
}

export async function doctor(env: Env, opts: InspectAgentsOptions): Promise<DoctorReport> {
  const checks = await storeChecks(env, opts.storeRoot);
  let config: CellarerConfig | undefined;
  let registry: Registry | undefined;
  let mutationRecovery: MutationRecoveryPresentation;
  const warnings: string[] = [];

  try {
    const mutation = await diagnoseMutationRecovery(env, opts.storeRoot);
    mutationRecovery = mutationRecoveryPresentation(mutation);
    const operation =
      mutation.journal?.operationId ??
      mutation.recoveryLockOwner?.operationId ??
      mutation.lockOwner?.operationId;
    checks.push({
      id: "mutation-recovery",
      status:
        mutation.status === "clean"
          ? "ok"
          : mutation.status === "completed-pending-cleanup"
            ? "warning"
            : "error",
      message: operation ? `${mutation.message}: ${operation}` : mutation.message,
      ...(mutation.journal ? { path: operationJournalPath(opts.storeRoot) } : {}),
    });
  } catch (error) {
    const message = `mutation recovery evidence is unreadable: ${errorMessage(error)}`;
    mutationRecovery = {
      status: "manual-recovery-required",
      operationId: "unknown",
      error: {
        code: "MANUAL_RECOVERY_REQUIRED",
        message: "manual recovery is required",
        operationId: "unknown",
        targets: [],
        guidance: message,
      },
    };
    checks.push({
      id: "mutation-recovery",
      status: "error",
      message,
      path: operationJournalPath(opts.storeRoot),
    });
  }

  try {
    config = await loadConfig(env, opts.storeRoot);
  } catch (err) {
    warnings.push(`config load failed: ${errorMessage(err)}`);
  }

  try {
    registry = await loadRegistry(env, opts.storeRoot);
    warnings.push(...registryWarnings(opts, registry));
  } catch (err) {
    checks.push({
      id: "registry",
      status: "error",
      message: `adapter registry failed to load: ${errorMessage(err)}`,
    });
  }

  let defaultMethod: LinkMethod | undefined;
  if (config) {
    defaultMethod = defaultLinkMethod(env, config);
    checks.push(linkMethodCheck(env, defaultMethod));
  }

  const inspections =
    registry && config ? await inspectRegisteredAgents(env, opts, registry, config) : [];
  const agents = await Promise.all(inspections.map((agent) => doctorAgent(env, agent)));

  return {
    storeRoot: opts.storeRoot,
    scope: opts.scope,
    dir: opts.dir,
    defaultMethod,
    checks,
    mutationRecovery,
    agents,
    warnings,
  };
}

function registryWarnings(opts: InspectAgentsOptions, registry: Registry): string[] {
  const warnings = [...registry.warnings];
  for (const id of opts.agents ?? []) {
    if (!registry.get(id)) warnings.push(`unknown agent "${id}"`);
  }
  return warnings;
}

async function inspectRegisteredAgents(
  env: Env,
  opts: InspectAgentsOptions,
  registry: Registry,
  config: CellarerConfig,
): Promise<AgentInspection[]> {
  const adapters =
    opts.agents && opts.agents.length > 0
      ? opts.agents.map((id) => registry.get(id)).filter((a): a is AgentAdapter => a !== undefined)
      : registry.list();
  return Promise.all(adapters.map((adapter) => inspectAdapter(env, opts, config, adapter)));
}

async function inspectAdapter(
  env: Env,
  opts: InspectAgentsOptions,
  config: CellarerConfig,
  adapter: AgentAdapter,
): Promise<AgentInspection> {
  const warnings: string[] = [];
  let detected = false;
  let root: string | undefined;
  let paths: AgentPaths = {};

  try {
    const result = await adapter.detect(env, opts.scope, opts.dir);
    detected = result.installed;
    root = result.root;
  } catch (err) {
    warnings.push(`detect failed: ${errorMessage(err)}`);
  }

  try {
    paths = adapter.paths(env, opts.scope, opts.dir);
  } catch (err) {
    warnings.push(`path expansion failed: ${errorMessage(err)}`);
  }

  return {
    id: adapter.id,
    displayName: adapter.displayName,
    enabled: config.agents[adapter.id]?.enabled !== false,
    scope: opts.scope,
    detected,
    root,
    supportedCapabilities: CAPABILITIES.filter((cap) =>
      (adapter.capabilities[cap] ?? []).includes(opts.scope),
    ),
    capabilities: adapter.capabilities,
    paths,
    warnings,
  };
}

async function storeChecks(env: Env, storeRoot: string): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  const rootStat = await safeStat(env, storeRoot);
  checks.push({
    id: "store-root",
    status: rootStat.stat?.isDirectory() ? "ok" : "error",
    path: storeRoot,
    message: rootStat.error
      ? `store root could not be inspected: ${rootStat.error}`
      : rootStat.stat?.isDirectory()
        ? "store root exists"
        : "store root is missing; run cellarer init",
  });

  const configPath = join(storeRoot, CONFIG_FILENAME);
  const configText = await safeReadFile(env, configPath);
  if (configText.error) {
    checks.push({
      id: "config",
      status: "error",
      path: configPath,
      message: `config.json is not readable: ${configText.error}`,
    });
  } else if (configText.text === null) {
    checks.push({
      id: "config",
      status: "error",
      path: configPath,
      message: "config.json is missing; run cellarer init",
    });
  } else {
    try {
      parseConfig(configText.text);
      checks.push({
        id: "config",
        status: "ok",
        path: configPath,
        message: "config.json is readable and valid",
      });
    } catch (err) {
      checks.push({
        id: "config",
        status: "error",
        path: configPath,
        message: `config.json is invalid: ${errorMessage(err)}`,
      });
    }
  }

  for (const kind of CAPABILITIES) {
    const path = join(storeRoot, "store", kind);
    const stat = await safeStat(env, path);
    checks.push({
      id: `store-${kind}`,
      status: stat.stat?.isDirectory() ? "ok" : "error",
      path,
      message: stat.error
        ? `${kind} store directory could not be inspected: ${stat.error}`
        : stat.stat?.isDirectory()
          ? `${kind} store directory exists`
          : `${kind} store directory is missing`,
    });
  }

  checks.push(await ownershipStateCheck(env, storeRoot));

  return checks;
}

async function ownershipStateCheck(env: Env, storeRoot: string): Promise<DiagnosticCheck> {
  const path = join(storeRoot, "state.json");
  try {
    const ledger = await loadLedger(env, storeRoot);
    return {
      id: "ownership-state",
      status: "ok",
      path,
      message: `target ownership state is valid (version ${ledger.version})`,
    };
  } catch (err) {
    return {
      id: "ownership-state",
      status: "error",
      path,
      message: errorMessage(err),
    };
  }
}

async function safeStat(
  env: Env,
  path: string,
): Promise<{ stat: FileStat | null; error?: string }> {
  try {
    return { stat: await statOrNull(env, path) };
  } catch (err) {
    return { stat: null, error: errorMessage(err) };
  }
}

async function safeReadFile(
  env: Env,
  path: string,
): Promise<{ text: string | null; error?: string }> {
  try {
    return { text: await readFileOrNull(env, path) };
  } catch (err) {
    return { text: null, error: errorMessage(err) };
  }
}

function defaultLinkMethod(env: Env, config: CellarerConfig): LinkMethod {
  const osMethod = config.defaults.os?.[env.platform as "win32" | "darwin" | "linux"]?.method;
  return osMethod ?? config.defaults.method;
}

function linkMethodCheck(env: Env, method: LinkMethod): DiagnosticCheck {
  if (env.platform === "win32" && method === "symlink") {
    return {
      id: "link-method",
      status: "warning",
      message: "default method is symlink on Windows; copy fallback may be needed",
    };
  }
  return {
    id: "link-method",
    status: "ok",
    message: `default link method is ${method}`,
  };
}

async function doctorAgent(env: Env, agent: AgentInspection): Promise<AgentDoctorReport> {
  const checks: DiagnosticCheck[] = [
    {
      id: `${agent.id}.detect`,
      status: agent.detected ? "ok" : "warning",
      path: agent.root,
      message: agent.detected ? "agent root detected" : "agent root was not detected",
    },
  ];

  for (const warning of agent.warnings) {
    checks.push({
      id: `${agent.id}.inspection`,
      status: "error",
      message: warning,
    });
  }

  for (const target of targetPaths(agent.paths)) {
    if (!agent.supportedCapabilities.includes(target.capability)) continue;
    checks.push(await writableTargetCheck(env, agent.id, target.capability, target.path));
  }

  return { ...agent, checks };
}

function targetPaths(paths: AgentPaths): { capability: Capability; path: string }[] {
  const targets: { capability: Capability; path: string }[] = [];
  if (paths.rules) targets.push({ capability: "rules", path: paths.rules });
  if (paths.mcp) targets.push({ capability: "mcp", path: paths.mcp });
  if (paths.skillsDir) targets.push({ capability: "skills", path: paths.skillsDir });
  return targets;
}

async function writableTargetCheck(
  env: Env,
  agentId: string,
  capability: Capability,
  target: string,
): Promise<DiagnosticCheck> {
  const probe = await writableProbePath(env, target);
  if (probe.error) {
    return {
      id: `${agentId}.${capability}.writable`,
      status: "error",
      path: target,
      message: probe.error,
    };
  }

  if (probe.atTarget && probe.stat) {
    const shapeError = targetShapeError(capability, probe.stat);
    if (shapeError) {
      return {
        id: `${agentId}.${capability}.writable`,
        status: "error",
        path: target,
        message: shapeError,
      };
    }
  }

  try {
    await env.fs.access(probe.path, "write");
    return {
      id: `${agentId}.${capability}.writable`,
      status: "ok",
      path: target,
      message:
        probe.path === target
          ? `${capability} target is writable`
          : `${capability} target can be created under ${probe.path}`,
    };
  } catch (err) {
    return {
      id: `${agentId}.${capability}.writable`,
      status: "error",
      path: target,
      message: `${capability} target is not writable via ${probe.path}: ${errorMessage(err)}`,
    };
  }
}

async function writableProbePath(
  env: Env,
  target: string,
): Promise<{ path: string; atTarget: boolean; stat?: FileStat; error?: string }> {
  let current = target;
  let atTarget = true;
  while (true) {
    try {
      const stat = await statOrNull(env, current);
      if (stat) {
        if (atTarget || stat.isDirectory()) return { path: current, atTarget, stat };
        return {
          path: current,
          atTarget,
          error: `parent path is not a directory: ${current}`,
        };
      }
    } catch (err) {
      return {
        path: current,
        atTarget,
        error: `could not inspect ${current}: ${errorMessage(err)}`,
      };
    }

    const parent = dirname(current);
    if (parent === current) {
      return {
        path: current,
        atTarget,
        error: `no existing parent found for ${target}`,
      };
    }
    current = parent;
    atTarget = false;
  }
}

function targetShapeError(capability: Capability, stat: FileStat): string | undefined {
  if (capability === "skills") {
    return stat.isDirectory() ? undefined : "skills target exists but is not a directory";
  }
  return stat.isDirectory() ? `${capability} target exists but is a directory` : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
