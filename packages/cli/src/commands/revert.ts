import { revert } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { printMutation } from "../mutation-output.js";
import { safeConsole as console } from "../output.js";
import { readProtectedPassphraseInput } from "./secret.js";

interface RevertOpts {
  agent?: string;
  dir?: string;
  keepBackups?: boolean;
  dryRun?: boolean;
  all?: boolean;
  acknowledge?: string;
  snapshotPassphraseFd?: string;
  json?: boolean;
}

// 依据台账回滚下发。
export function revertCommand(): Command {
  return new Command("revert")
    .description("依据台账回滚下发")
    .option("-a, --agent <ids>", "指定 agent")
    .option("--dir <path>", "指定工程目录")
    .option("--all", "回滚台账中的全部条目(无 --agent/--dir 时必须显式确认)")
    .option("--keep-backups", "保留 .bak 备份")
    .option("--acknowledge <tokens>", "确认 dry-run 返回的精确漂移 token(逗号分隔)")
    .option("--snapshot-passphrase-fd <number>", "从继承的文件描述符读取 snapshot 口令")
    .option("--dry-run", "仅预览,不落地")
    .option("--json", "输出完整 Core revert plan/result")
    .action(async (opts: RevertOpts) => {
      const ctx = await resolveContext(opts, "required");
      // 防误删:无 --agent/--dir 选择器时,必须 --all 才回滚全部(对齐 apply 要求 --agent)。
      const hasSelector = ctx.agents.length > 0 || ctx.dir !== undefined;
      if (!hasSelector && !opts.all && !opts.dryRun) {
        console.error("revert 会回滚台账全部条目;请用 --agent/--dir 缩小范围,或显式 --all。");
        process.exitCode = 1;
        return;
      }
      const snapshotPassphrase =
        !opts.dryRun && (opts.acknowledge || opts.snapshotPassphraseFd)
          ? await readProtectedPassphraseInput(opts.snapshotPassphraseFd)
          : undefined;
      const result = await revert(ctx.env, {
        storeRoot: ctx.storeRoot,
        // 未指定 --dir 时回滚全部作用域(scopeFilter 为 undefined)。
        scope: ctx.scopeFilter,
        dir: ctx.dir,
        agents: ctx.agents.length > 0 ? ctx.agents : undefined,
        acknowledgements: parseTokens(opts.acknowledge),
        snapshotPassphrase,
        keepBackups: opts.keepBackups,
        dryRun: opts.dryRun,
      });
      const failed =
        !opts.dryRun &&
        (result.plan.targets.some((target) => target.blocked) ||
          result.failures.length > 0 ||
          result.mutation.result?.ok === false);
      if (failed) process.exitCode = 1;
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printMutation(result.mutation);
      for (const w of result.warnings) console.warn(`⚠ ${w}`);
      for (const target of result.plan.targets) {
        if (!target.blocked) continue;
        console.error(`⛔ ${target.target} — ${target.blockReason ?? "revert blocked"}`);
        if (target.acknowledgement) {
          console.error(`   acknowledgement: ${target.acknowledgement.token}`);
        }
      }
      for (const failure of result.failures) {
        console.error(`⛔ ${failure.target} — ${failure.message}`);
      }
      if (result.plan.targets.length === 0) {
        console.log("台账中无匹配条目可回滚。");
        return;
      }
      if (opts.dryRun) {
        for (const target of result.plan.targets) {
          const verb = target.blocked ? "已阻止" : "将回滚";
          console.log(`↩ ${verb} ${target.proposedAction} → ${target.target}`);
        }
        return;
      }
      for (const entry of result.reverted) {
        console.log(`↩ 已回滚 ${entry.agent} ${entry.capability}/${entry.scope} → ${entry.target}`);
      }
    });
}

function parseTokens(spec: string | undefined): string[] | undefined {
  if (!spec) return undefined;
  const tokens = spec
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.length > 0 ? tokens : undefined;
}
