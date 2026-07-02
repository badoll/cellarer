import { revert } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";

interface RevertOpts {
  agent?: string;
  dir?: string;
  keepBackups?: boolean;
  dryRun?: boolean;
  all?: boolean;
}

// 依据台账回滚下发。
export function revertCommand(): Command {
  return new Command("revert")
    .description("依据台账回滚下发")
    .option("-a, --agent <ids>", "指定 agent")
    .option("--dir <path>", "指定工程目录")
    .option("--all", "回滚台账中的全部条目(无 --agent/--dir 时必须显式确认)")
    .option("--keep-backups", "保留 .bak 备份")
    .option("--dry-run", "仅预览,不落地")
    .action(async (opts: RevertOpts) => {
      const ctx = resolveContext(opts);
      // 防误删:无 --agent/--dir 选择器时,必须 --all 才回滚全部(对齐 apply 要求 --agent)。
      const hasSelector = ctx.agents.length > 0 || ctx.dir !== undefined;
      if (!hasSelector && !opts.all && !opts.dryRun) {
        console.error("revert 会回滚台账全部条目;请用 --agent/--dir 缩小范围,或显式 --all。");
        process.exitCode = 1;
        return;
      }
      const result = await revert(ctx.env, {
        storeRoot: ctx.storeRoot,
        // 未指定 --dir 时回滚全部作用域(scopeFilter 为 undefined)。
        scope: ctx.scopeFilter,
        dir: ctx.dir,
        agents: ctx.agents.length > 0 ? ctx.agents : undefined,
        keepBackups: opts.keepBackups,
        dryRun: opts.dryRun,
      });
      for (const w of result.warnings) console.warn(`⚠ ${w}`);
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
