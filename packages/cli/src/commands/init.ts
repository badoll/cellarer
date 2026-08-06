import { initializeStore, listControlPlaneAgents } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { safeConsole as console } from "../output.js";
import { commandSuccess, executeCliCommand, publicOperationResult } from "../protocol/execution.js";
import { CliInputError } from "../protocol/input.js";

interface InitOpts {
  readonly global?: boolean;
  readonly agent?: string;
}

// 初始化库房:委托给 core 并发安全 initializer(不变量 1:CLI 不写 fs 业务逻辑)。
export function initCommand(): Command {
  return new Command("init")
    .description("初始化库房(全局)")
    .option("--global", "初始化全局库房(默认)")
    .option("-a, --agent <ids>", "明确启用的 agent targets，逗号分隔")
    .action(async (opts: InitOpts, command: Command) => {
      await executeCliCommand(
        command,
        async ({ invocation }) => {
          const preview = await resolveContext({}, "none");
          const inventory = await listControlPlaneAgents(preview.env, {
            storeRoot: preview.storeRoot,
            scope: "global",
          });
          const agentTargets = parseAgentTargets(opts.agent);
          if (agentTargets.length === 0) {
            throw new CliInputError(
              "INPUT_REQUIRED",
              "init requires explicit agent targets",
              { fields: ["agents"], inventory },
              invocation,
            );
          }
          const knownAgentIds = new Set(inventory.agents.map((agent) => agent.id));
          const unknown = agentTargets.filter((agentId) => !knownAgentIds.has(agentId));
          if (unknown.length > 0) {
            throw new CliInputError(
              "INVALID_INPUT",
              "init agent targets must identify supported agents exactly",
              { fields: ["agents"], agentIds: unknown, inventory },
              invocation,
            );
          }
          const { env, storeRoot } = await resolveContext({}, "provision");
          const result = await initializeStore(env, storeRoot, { agentTargets });
          const configuredInventory = await listControlPlaneAgents(env, {
            storeRoot,
            scope: "global",
          });
          return commandSuccess({
            storeRoot: result.storeRoot,
            createdConfig: result.createdConfig,
            operation: publicOperationResult(result.operation),
            inventory: configuredInventory,
          });
        },
        (outcome) => {
          if (!outcome.ok) return;
          const note = outcome.data.createdConfig ? "" : " (config.json 已存在,保留)";
          if (!outcome.data.operation.ok) return;
          console.log(
            `库房已初始化:${outcome.data.storeRoot}${note} (operation ${outcome.data.operation.receipt.operationId}, revision ${outcome.data.operation.receipt.resultingRevision})`,
          );
          for (const agent of outcome.data.inventory.agents) {
            console.log(
              `  ${agent.id}: detected=${agent.detected ? "yes" : "no"}, configured=${agent.configured ? "yes" : "no"}, enabled=${agent.enabled ? "yes" : "no"}`,
            );
          }
        },
      );
    });
}

function parseAgentTargets(value: string | undefined): string[] {
  if (value === undefined) return [];
  const targets = value
    .split(",")
    .map((agentId) => agentId.trim())
    .filter(Boolean);
  return [...new Set(targets)];
}
