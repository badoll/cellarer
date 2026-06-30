import { revert } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";

interface RevertOpts {
  agent?: string;
  dir?: string;
  keepBackups?: boolean;
  dryRun?: boolean;
}

// 依据台账回滚下发。
export function revertCommand(): Command {
  return new Command("revert")
    .description("依据台账回滚下发")
    .option("--agent <ids>", "指定 agent")
    .option("--dir <path>", "指定工程目录")
    .option("--keep-backups", "保留 .bak 备份")
    .option("--dry-run", "仅预览,不落地")
    .action(async (opts: RevertOpts) => {
      const ctx = resolveContext(opts);
      const result = await revert(ctx.env, {
        storeRoot: ctx.storeRoot,
        // 未指定 --dir 时回滚全部作用域(scopeFilter 为 undefined)。
        scope: ctx.scopeFilter,
        dir: ctx.dir,
        agents: ctx.agents.length > 0 ? ctx.agents : undefined,
        keepBackups: opts.keepBackups,
        dryRun: opts.dryRun,
      });
      if (result.reverted.length === 0) {
        console.log("台账中无匹配条目可回滚。");
        return;
      }
      const verb = opts.dryRun ? "将回滚" : "已回滚";
      for (const e of result.reverted) {
        console.log(`↩ ${verb} ${e.agent} ${e.capability}/${e.scope} → ${e.target}`);
      }
    });
}
