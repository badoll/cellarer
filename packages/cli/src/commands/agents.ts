import { type AgentInspection, type Capability, inspectAgents } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { safeConsole as console } from "../output.js";
import { commandSuccess, commandWarnings, executeCliCommand } from "../protocol/execution.js";

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
    .action(async (opts: AgentsOpts, command: Command) => {
      await executeCliCommand(
        command,
        async () => {
          const ctx = await resolveContext(opts);
          const report = await inspectAgents(ctx.env, {
            storeRoot: ctx.storeRoot,
            scope: ctx.scope,
            dir: ctx.dir,
            agents: ctx.agents.length > 0 ? ctx.agents : undefined,
          });
          return commandSuccess(
            {
              storeRoot: report.storeRoot,
              scope: report.scope,
              ...(report.dir === undefined ? {} : { dir: report.dir }),
              agents: report.agents,
            },
            commandWarnings(report.warnings, "AGENT_WARNING"),
          );
        },
        (outcome) => {
          if (!outcome.ok) return;
          for (const warning of outcome.warnings) console.warn(`⚠ ${warning.message}`);
          if (outcome.data.agents.length === 0) {
            console.log("未找到匹配的 agent adapter。");
            return;
          }
          console.log(`agent adapters (${outcome.data.scope}):`);
          for (const agent of outcome.data.agents) printAgent(agent);
        },
      );
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
