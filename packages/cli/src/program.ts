import { Command } from "commander";
import { authorityCommandRoot } from "./commands/authority.js";
import {
  createCliCommandCatalog,
  getDefaultCliCommandCatalog,
} from "./commands/command-catalog.js";
import { addCollectionMutationGroups } from "./commands/control-plane-mutations.js";
import {
  agentCommandRoot,
  collectionCommandRoot,
  configCommandRoot,
  discoveryCommandRoot,
  operationCommandRoot,
  resourceCommandRoot,
} from "./commands/control-plane-read.js";
import type { InitInventoryImportConfirmer } from "./commands/init.js";
import { inventoryCommandRoot } from "./commands/inventory.js";
import { profileCommandRoot, syncProfileCommandRoot } from "./commands/resource-lifecycle.js";
import { secretCommandRoot } from "./commands/secret.js";
import { type CommandCatalog, executeCommandContract } from "./protocol/command-contract.js";
import { type CliInputBoundaryIo, installCliInputBoundary } from "./protocol/input.js";
import { CLI_PACKAGE_VERSION } from "./version.js";

// 程序构造与执行分离:buildProgram 便于测试(可注入 args)。
// CLI 是薄壳:每个子命令一文件,只解析参数并调用 @cellarer/core(不变量 1)。
export function buildProgram(
  inputIo?: CliInputBoundaryIo,
  initInventoryImportConfirmer?: InitInventoryImportConfirmer,
): Command {
  const program = new Command();

  program
    .name("cellarer")
    .description("多 AI agent 的 skills / mcp / rules 全局统一管理工具")
    .version(CLI_PACKAGE_VERSION);

  const catalog = initInventoryImportConfirmer
    ? createCliCommandCatalog({ initInventoryImportConfirmer })
    : getDefaultCliCommandCatalog();
  installCliInputBoundary(program, inputIo, catalog);

  registerCommandTree(program, catalog);

  return program;
}

const commandContainerFactories: Readonly<Record<string, () => Command>> = {
  authority: authorityCommandRoot,
  secret: secretCommandRoot,
  resource: resourceCommandRoot,
  profile: profileCommandRoot,
  sync: syncProfileCommandRoot,
  agent: agentCommandRoot,
  collection: () => addCollectionMutationGroups(collectionCommandRoot()),
  config: configCommandRoot,
  discovery: discoveryCommandRoot,
  operation: operationCommandRoot,
  inventory: inventoryCommandRoot,
};

function registerCommandTree(program: Command, catalog: CommandCatalog): void {
  const registryRoots = [
    ...new Set(catalog.definitions.map(({ command }) => command.split(".", 1)[0] as string)),
  ];
  const unregisteredContainers = Object.keys(commandContainerFactories).filter(
    (command) => !registryRoots.includes(command),
  );
  if (unregisteredContainers.length > 0) {
    throw new Error(
      `command containers are absent from the catalog: ${unregisteredContainers.join(", ")}`,
    );
  }
  for (const root of registryRoots) {
    const createContainer = commandContainerFactories[root];
    if (createContainer) program.addCommand(createContainer());
  }
  catalog.registerCommander(program, (command, context) =>
    executeCommandContract(catalog, catalog.requireContract(command), context),
  );

  orderCommandTree(
    program,
    catalog.definitions.map(({ command }) => command),
  );
  const registeredLeaves = collectLeafCommands(program).sort();
  catalog.assertExecutableParity(registeredLeaves);
}

function orderCommandTree(command: Command, definitionPaths: readonly string[], prefix = ""): void {
  const rankByPath = new Map(definitionPaths.map((path, index) => [path, index]));
  const rank = (child: Command): number => {
    const identity = prefix ? `${prefix}.${child.name()}` : child.name();
    const leafRanks = definitionPaths
      .filter((path) => path === identity || path.startsWith(`${identity}.`))
      .map((path) => rankByPath.get(path) as number);
    return Math.min(...leafRanks);
  };
  (command.commands as Command[]).sort((left, right) => rank(left) - rank(right));
  for (const child of command.commands) {
    const identity = prefix ? `${prefix}.${child.name()}` : child.name();
    orderCommandTree(child, definitionPaths, identity);
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
