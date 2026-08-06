import { Command } from "commander";
import { addCommand } from "./commands/add.js";
import { agentsCommand } from "./commands/agents.js";
import { applyCommand } from "./commands/apply.js";
import { authorityCommand } from "./commands/authority.js";
import {
  addAgentMutationCommands,
  addCollectionMutationCommands,
  addConfigMutationCommands,
} from "./commands/control-plane-mutations.js";
import {
  agentCommand,
  collectionCommand,
  configCommand,
  diffCommand,
  discoverySummaryCommand,
  operationCommand,
  planCommand,
  resourceCommand,
  summaryCommand,
  verifyCommand,
} from "./commands/control-plane-read.js";
import { capabilitiesCommand, schemaCommand } from "./commands/discovery.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { lsCommand } from "./commands/ls.js";
import {
  addResourceLifecycleCommands,
  profileCommand,
  syncProfileCommand,
} from "./commands/resource-lifecycle.js";
import { revertCommand } from "./commands/revert.js";
import { scanCommand } from "./commands/scan.js";
import { secretCommand } from "./commands/secret.js";
import { statusCommand } from "./commands/status.js";
import { uiCommand } from "./commands/ui.js";
import { commandRegistry } from "./protocol/command-registry.js";
import { type CliInputBoundaryIo, installCliInputBoundary } from "./protocol/input.js";
import { CLI_PACKAGE_VERSION } from "./version.js";

// 程序构造与执行分离:buildProgram 便于测试(可注入 args)。
// CLI 是薄壳:每个子命令一文件,只解析参数并调用 @cellarer/core(不变量 1)。
export function buildProgram(inputIo?: CliInputBoundaryIo): Command {
  const program = new Command();

  program
    .name("cellarer")
    .description("多 AI agent 的 skills / mcp / rules 全局统一管理工具")
    .version(CLI_PACKAGE_VERSION);

  installCliInputBoundary(program, inputIo);

  registerCommandTree(program);

  return program;
}

const commandFactories: Readonly<Record<string, () => Command>> = {
  init: initCommand,
  add: addCommand,
  agents: agentsCommand,
  ls: lsCommand,
  apply: applyCommand,
  authority: authorityCommand,
  scan: scanCommand,
  revert: revertCommand,
  status: statusCommand,
  secret: secretCommand,
  doctor: doctorCommand,
  ui: uiCommand,
  capabilities: capabilitiesCommand,
  schema: schemaCommand,
  resource: () => addResourceLifecycleCommands(resourceCommand()),
  profile: profileCommand,
  sync: syncProfileCommand,
  agent: () => addAgentMutationCommands(agentCommand()),
  collection: () => addCollectionMutationCommands(collectionCommand()),
  config: () => addConfigMutationCommands(configCommand()),
  diff: diffCommand,
  verify: verifyCommand,
  summary: summaryCommand,
  plan: planCommand,
  discovery: discoverySummaryCommand,
  operation: operationCommand,
};

function registerCommandTree(program: Command): void {
  const registryRoots = [
    ...new Set(commandRegistry.map(({ command }) => command.split(".", 1)[0] as string)),
  ];
  const unregisteredFactories = Object.keys(commandFactories).filter(
    (command) => !registryRoots.includes(command),
  );
  if (unregisteredFactories.length > 0) {
    throw new Error(
      `command factories are absent from the registry: ${unregisteredFactories.join(", ")}`,
    );
  }
  for (const root of registryRoots) {
    const factory = commandFactories[root];
    if (!factory) throw new Error(`registered command ${root} has no command factory`);
    program.addCommand(factory());
  }

  const registeredLeaves = collectLeafCommands(program).sort();
  const protocolLeaves = commandRegistry.map(({ command }) => command).sort();
  if (registeredLeaves.join("\0") !== protocolLeaves.join("\0")) {
    throw new Error("Commander command tree does not match the public command registry");
  }
}

function collectLeafCommands(command: Command, prefix = ""): string[] {
  const leaves: string[] = [];
  for (const child of command.commands) {
    const identity = prefix ? `${prefix}.${child.name()}` : child.name();
    if (child.commands.length === 0) leaves.push(identity);
    else leaves.push(...collectLeafCommands(child, identity));
  }
  return leaves;
}
