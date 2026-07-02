import { type AgentInspection, type Capability, inspectAgents } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";

interface AgentsOpts {
  agent?: string;
  dir?: string;
  json?: boolean;
}

export function agentsCommand(): Command {
  return new Command("agents")
    .description("列出已注册 agent adapter、探测结果、能力与目标路径")
    .option("-a, --agent <ids>", "只显示指定 agent(逗号分隔)")
    .option("--dir <path>", "按 project scope 展示目标路径")
    .option("--json", "JSON 输出")
    .action(async (opts: AgentsOpts) => {
      const ctx = resolveContext(opts);
      const report = await inspectAgents(ctx.env, {
        storeRoot: ctx.storeRoot,
        scope: ctx.scope,
        dir: ctx.dir,
        agents: ctx.agents.length > 0 ? ctx.agents : undefined,
      });

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      for (const w of report.warnings) console.warn(`⚠ ${w}`);
      if (report.agents.length === 0) {
        console.log("未找到匹配的 agent adapter。");
        return;
      }

      console.log(`agent adapters (${report.scope}):`);
      for (const agent of report.agents) printAgent(agent);
    });
}

function printAgent(agent: AgentInspection): void {
  const mark = agent.detected ? "✓" : "∅";
  const enabled = agent.enabled ? "" : " [disabled]";
  console.log(`${mark} ${agent.id} — ${agent.displayName}${enabled}`);
  if (agent.root) console.log(`  root: ${agent.root}`);
  console.log(`  capabilities: ${formatCapabilities(agent.supportedCapabilities)}`);
  printPath("rules", agent.paths.rules);
  printPath("mcp", agent.paths.mcp);
  printPath("skills", agent.paths.skillsDir);
  for (const w of agent.warnings) console.warn(`  ⚠ ${w}`);
}

function formatCapabilities(capabilities: Capability[]): string {
  return capabilities.length > 0 ? capabilities.join(", ") : "-";
}

function printPath(label: string, path: string | undefined): void {
  if (path) console.log(`  ${label}: ${path}`);
}
