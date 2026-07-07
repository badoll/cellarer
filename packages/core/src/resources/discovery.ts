import { loadRegistry } from "../adapters/registry.js";
import type { AgentAdapter } from "../adapters/types.js";
import type { Env } from "../env.js";
import { lstatOrNull, readdirOrEmpty, readFileOrNull } from "../fs/probe.js";
import type { Capability, Scope } from "../model/index.js";
import { loadConfig } from "../store/config.js";
import type { Destination } from "./catalog.js";

export interface DiscoverySummaryOptions {
  storeRoot: string;
  agents?: string[];
  destination: Destination;
  dir?: string;
}

export interface AgentDiscoverySummary {
  agent: string;
  displayName: string;
  detected: boolean;
  root?: string;
  counts: Record<Capability, number>;
  warnings: string[];
}

export interface DiscoverySummaryResult {
  generatedAt: string;
  destination: Destination;
  dir?: string;
  totals: Record<Capability, number>;
  agents: AgentDiscoverySummary[];
  warnings: string[];
}

const CAPABILITIES: Capability[] = ["rules", "mcp", "skills"];

export async function discoverySummary(
  env: Env,
  opts: DiscoverySummaryOptions,
): Promise<DiscoverySummaryResult> {
  const scope: Scope = opts.destination === "project" ? "project" : "global";
  const [config, registry] = await Promise.all([
    loadConfig(env, opts.storeRoot),
    loadRegistry(env, opts.storeRoot),
  ]);

  const enabledAgentIds = registry
    .list()
    .filter((agent) => config.agents[agent.id]?.enabled !== false)
    .map((agent) => agent.id);
  const selectedAgentIds = opts.agents && opts.agents.length > 0 ? opts.agents : enabledAgentIds;

  const totals = zeroCounts();
  const agents: AgentDiscoverySummary[] = [];
  const warnings = [...registry.warnings];

  for (const agentId of selectedAgentIds) {
    const adapter = registry.get(agentId);
    if (!adapter) {
      warnings.push(`unknown agent "${agentId}"`);
      continue;
    }
    const summary = await summarizeAgent(env, adapter, scope, opts.dir);
    agents.push(summary);
    for (const capability of CAPABILITIES) totals[capability] += summary.counts[capability];
  }

  return {
    generatedAt: env.now().toISOString(),
    destination: opts.destination,
    dir: opts.dir,
    totals,
    agents,
    warnings,
  };
}

async function summarizeAgent(
  env: Env,
  adapter: AgentAdapter,
  scope: Scope,
  dir: string | undefined,
): Promise<AgentDiscoverySummary> {
  const warnings: string[] = [];
  let detected = false;
  let root: string | undefined;

  try {
    const result = await adapter.detect(env, scope, dir);
    detected = result.installed;
    root = result.root;
  } catch (err) {
    warnings.push(`detect failed: ${errorMessage(err)}`);
  }

  let paths;
  try {
    paths = adapter.paths(env, scope, dir);
  } catch (err) {
    warnings.push(`paths failed: ${errorMessage(err)}`);
    return {
      agent: adapter.id,
      displayName: adapter.displayName,
      detected,
      root,
      counts: zeroCounts(),
      warnings,
    };
  }

  const counts = zeroCounts();

  if (paths.rules) {
    try {
      const content = await readFileOrNull(env, paths.rules);
      if (content !== null && content.trim().length > 0) counts.rules = 1;
    } catch (err) {
      warnings.push(`rules read failed at ${paths.rules}: ${errorMessage(err)}`);
    }
  }

  if (paths.mcp && adapter.mcp) {
    try {
      const content = await readFileOrNull(env, paths.mcp);
      if (content !== null && content.trim().length > 0) {
        const decoded = adapter.mcp.codec.decode(content, adapter.mcp.serversKey);
        counts.mcp = Object.keys(decoded.servers).length;
      }
    } catch (err) {
      warnings.push(`mcp parse failed at ${paths.mcp}: ${errorMessage(err)}`);
    }
  }

  if (paths.skillsDir) {
    try {
      let total = 0;
      for (const name of await readdirOrEmpty(env, paths.skillsDir)) {
        const stat = await lstatOrNull(env, `${paths.skillsDir}/${name}`);
        if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
        total += 1;
      }
      counts.skills = total;
    } catch (err) {
      warnings.push(`skills read failed at ${paths.skillsDir}: ${errorMessage(err)}`);
    }
  }

  return {
    agent: adapter.id,
    displayName: adapter.displayName,
    detected,
    root,
    counts,
    warnings,
  };
}

function zeroCounts(): Record<Capability, number> {
  return { rules: 0, mcp: 0, skills: 0 };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
