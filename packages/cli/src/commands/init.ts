import { createInterface } from "node:readline/promises";
import {
  type ControlPlaneAgentListDto,
  InitialAgentSelectionConflictError,
  initializeStore,
  listControlPlaneAgents,
  validateInitializationAgentTargets,
} from "@cellarer/core";
import { Command, Option } from "commander";
import { resolveContext } from "../context.js";
import { safeConsole as console } from "../output.js";
import {
  type CommandContractMetadata,
  defineCommandContract,
} from "../protocol/command-contract.js";
import { commandSuccess, publicOperationResult } from "../protocol/execution.js";
import { CliInputError, type CliInvocation } from "../protocol/input.js";

interface InitOpts {
  readonly global?: boolean;
  readonly agent?: string;
  readonly noAgent?: boolean;
  readonly dryRun?: boolean;
}

export type InitAgentSelector = (inventory: ControlPlaneAgentListDto) => Promise<string>;

type InitCommandData =
  | {
      readonly dryRun: true;
      readonly storeRoot: string;
      readonly agentTargets: string[];
      readonly inventory: Awaited<ReturnType<typeof listControlPlaneAgents>>;
    }
  | {
      readonly storeRoot: string;
      readonly createdConfig: boolean;
      readonly operation: ReturnType<typeof publicOperationResult>;
      readonly inventory: Awaited<ReturnType<typeof listControlPlaneAgents>>;
    };

interface InitCommandInput {
  readonly opts: InitOpts;
  readonly command: Command;
}

// 初始化库房:委托给 core 并发安全 initializer(不变量 1:CLI 不写 fs 业务逻辑)。
export function createInitCommandContract(
  definition: CommandContractMetadata<"init">,
  selectAgents: InitAgentSelector = selectInitAgents,
) {
  return defineCommandContract<"init", InitCommandInput, InitCommandData>(definition, {
    createCommand: () =>
      new Command("init")
        .description("初始化库房(全局)")
        .option("--global", "初始化全局库房(默认)")
        .option("-a, --agent <ids>", "明确启用的 agent targets，逗号分隔")
        .addOption(explicitNoAgentOption())
        .option("--dry-run", "仅验证初始化目标，不创建或修改库房"),
    normalize: ({ command }) => ({ opts: command.opts<InitOpts>(), command }),
    execute: async ({ opts, command }, { invocation }) => {
      assertUnambiguousAgentIntent(opts, invocation);
      assertExplicitArgvAgentList(opts, command, invocation);
      const preview = await resolveContext({}, "none");
      const inventory = await listControlPlaneAgents(preview.env, {
        storeRoot: preview.storeRoot,
        scope: "global",
      });
      let selection: string | false | undefined = opts.noAgent ? false : opts.agent;
      if (selection === undefined && invocation.nonInteractive) {
        throw new CliInputError(
          "INPUT_REQUIRED",
          "init requires explicit agent target intent",
          { fields: ["agents"], inventory },
          invocation,
        );
      }
      selection ??= await selectAgents(inventory);
      const agentTargets = parseAgentTargets(selection);
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
      await validateAgentTargets(preview.env, preview.storeRoot, agentTargets, invocation);
      if (opts.dryRun) {
        return commandSuccess({
          dryRun: true as const,
          storeRoot: preview.storeRoot,
          agentTargets,
          inventory,
        });
      }
      const { env, storeRoot } = await resolveContext({}, "provision");
      let result: Awaited<ReturnType<typeof initializeStore>>;
      try {
        result = await initializeStore(env, storeRoot, { agentTargets });
      } catch (error) {
        throw mapSelectionConflict(error, invocation);
      }
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
    presentText: (outcome) => {
      if (!outcome.ok) return;
      if ("dryRun" in outcome.data) {
        console.log(`dry-run: would initialize ${outcome.data.storeRoot}`);
        return;
      }
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
    mapError: () => undefined,
  });
}

async function selectInitAgents(inventory: ControlPlaneAgentListDto): Promise<string> {
  console.log("Supported agents (detected status is evidence, not automatic activation):");
  for (const agent of inventory.agents) {
    console.log(`  ${agent.id}: detected=${agent.detected ? "yes" : "no"}`);
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readline.question(
      "Enable agents (comma-separated IDs; press Enter to enable none): ",
    );
  } finally {
    readline.close();
  }
}

async function validateAgentTargets(
  env: Parameters<typeof validateInitializationAgentTargets>[0],
  storeRoot: string,
  agentTargets: readonly string[],
  invocation: CliInvocation,
): Promise<void> {
  try {
    await validateInitializationAgentTargets(env, storeRoot, agentTargets);
  } catch (error) {
    throw mapSelectionConflict(error, invocation);
  }
}

function mapSelectionConflict(error: unknown, invocation: CliInvocation): unknown {
  if (!(error instanceof InitialAgentSelectionConflictError)) return error;
  return new CliInputError(
    "DOMAIN_VALIDATION_FAILED",
    error.message,
    {
      currentAgentTargets: error.currentAgentTargets,
      requestedAgentTargets: error.requestedAgentTargets,
      commands: ["cellarer agent enable <agent>", "cellarer agent disable <agent>"],
    },
    invocation,
  );
}

function explicitNoAgentOption(): Option {
  const option = new Option("--no-agent", "明确不启用任何 agent");
  // Commander treats --no-* as a negation of the positive option by default. Here it is an
  // independent explicit-empty intent so --agent and --no-agent remain distinguishable.
  option.negate = false;
  return option;
}

function assertUnambiguousAgentIntent(opts: InitOpts, invocation: CliInvocation): void {
  if (opts.agent === undefined || opts.noAgent !== true) return;
  throw new CliInputError(
    "INPUT_AMBIGUITY",
    "init accepts either --agent or --no-agent, not both",
    { fields: ["agents"] },
    invocation,
  );
}

function assertExplicitArgvAgentList(
  opts: InitOpts,
  command: Command,
  invocation: CliInvocation,
): void {
  if (
    opts.agent === undefined ||
    command.getOptionValueSource("agent") !== "cli" ||
    parseAgentTargets(opts.agent).length > 0
  ) {
    return;
  }
  throw new CliInputError(
    "INVALID_INPUT",
    "--agent requires at least one agent ID; use --no-agent to enable none",
    { fields: ["agents"] },
    invocation,
  );
}

function parseAgentTargets(value: string | false): string[] {
  if (value === false) return [];
  const targets = value
    .split(",")
    .map((agentId) => agentId.trim())
    .filter(Boolean);
  return [...new Set(targets)];
}
