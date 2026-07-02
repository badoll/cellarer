import { Command } from "commander";
import { addCommand } from "./commands/add.js";
import { agentsCommand } from "./commands/agents.js";
import { applyCommand } from "./commands/apply.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { lsCommand } from "./commands/ls.js";
import { revertCommand } from "./commands/revert.js";
import { scanCommand } from "./commands/scan.js";
import { secretCommand } from "./commands/secret.js";
import { statusCommand } from "./commands/status.js";
import { uiCommand } from "./commands/ui.js";

// 程序构造与执行分离:buildProgram 便于测试(可注入 args)。
// CLI 是薄壳:每个子命令一文件,只解析参数并调用 @cellarer/core(不变量 1)。
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("cellarer")
    .description("多 AI agent 的 skills / mcp / rules 全局统一管理工具")
    .version("0.0.0");

  program.addCommand(initCommand());
  program.addCommand(addCommand());
  program.addCommand(agentsCommand());
  program.addCommand(lsCommand());
  program.addCommand(applyCommand());
  program.addCommand(scanCommand());
  program.addCommand(revertCommand());
  program.addCommand(statusCommand());
  program.addCommand(secretCommand());
  program.addCommand(doctorCommand());
  program.addCommand(uiCommand());

  return program;
}
