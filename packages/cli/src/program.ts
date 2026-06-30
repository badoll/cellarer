import { Command } from "commander";

// 程序构造与执行分离:buildProgram 便于测试(可注入 args、捕获输出)。
// M0 为骨架,命令体在 M1 接入 core。
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("cellarer")
    .description("多 AI agent 的 skills / mcp / rules 全局统一管理工具")
    .version("0.0.0");

  program
    .command("init")
    .description("初始化库房(全局)或当前工程")
    .option("--global", "初始化全局库房")
    .option("--project", "初始化当前工程")
    .action(() => {
      console.log("init: not yet implemented");
    });

  program
    .command("ls")
    .description("列出库房制品与下发分布")
    .option("--channel <channel>", "按通道过滤")
    .option("--agent <ids>", "按 agent 过滤")
    .action(() => {
      console.log("ls: not yet implemented");
    });

  program
    .command("apply")
    .description("下发库房制品到 agent")
    .option("--global", "下发到各 agent 家目录")
    .option("--agent <ids>", "指定 agent(逗号分隔)")
    .option("--dir <path>", "下发到指定工程目录")
    .option("--channel <channel>", "按通道过滤")
    .option("--rules", "仅下发 rules")
    .option("--copy", "强制 copy(不软链)")
    .option("--dry-run", "仅预览,不落地")
    .option("--yes", "非交互确认")
    .action(() => {
      console.log("apply: not yet implemented");
    });

  program
    .command("revert")
    .description("依据台账回滚下发")
    .option("--agent <ids>", "指定 agent")
    .option("--dir <path>", "指定工程目录")
    .option("--keep-backups", "保留 .bak 备份")
    .action(() => {
      console.log("revert: not yet implemented");
    });

  program
    .command("status")
    .description("漂移检测(库房 vs 落地)")
    .option("--agent <ids>", "指定 agent")
    .option("--dir <path>", "指定工程目录")
    .action(() => {
      console.log("status: not yet implemented");
    });

  return program;
}
