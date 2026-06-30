import { apply, type Capability, type LinkMethod } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";

interface ApplyOpts {
  global?: boolean;
  agent?: string;
  dir?: string;
  channel?: string;
  rules?: boolean;
  copy?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

// 下发(distribute):库房 → agent。M1 支持 rules。
export function applyCommand(): Command {
  return new Command("apply")
    .description("下发库房制品到 agent")
    .option("--global", "下发到各 agent 家目录")
    .option("--agent <ids>", "指定 agent(逗号分隔)")
    .option("--dir <path>", "下发到指定工程目录")
    .option("--channel <channel>", "按通道过滤")
    .option("--rules", "仅下发 rules")
    .option("--copy", "强制 copy(不软链)")
    .option("--dry-run", "仅预览,不落地")
    .option("--yes", "非交互确认")
    .action(async (opts: ApplyOpts) => {
      const ctx = resolveContext(opts);
      if (ctx.agents.length === 0) {
        console.error("需指定 --agent <ids>(逗号分隔),例:--agent claude-code,codex");
        process.exitCode = 1;
        return;
      }
      const method: LinkMethod | undefined = opts.copy ? "copy" : undefined;
      // M1 仅 rules;--rules 显式或默认都按 rules 处理。
      const capabilities: Capability[] = ["rules"];

      const result = await apply(ctx.env, {
        storeRoot: ctx.storeRoot,
        scope: ctx.scope,
        dir: ctx.dir,
        agents: ctx.agents,
        channels: ctx.channels,
        capabilities,
        method,
        dryRun: opts.dryRun,
      });

      for (const w of result.plan.warnings) console.warn(`⚠ ${w}`);

      if (opts.dryRun) {
        console.log("dry-run 预览:");
        for (const a of result.plan.actions) {
          if (a.op === "skip") {
            console.log(`  [skip] ${a.agent} ${a.capability}/${a.scope} — ${a.reason}`);
            continue;
          }
          const existed = a.preview?.before !== undefined ? "(覆盖既有)" : "(新建)";
          console.log(`  [${a.op}] ${a.agent} → ${a.target} ${existed}`);
        }
        return;
      }

      for (const e of result.entries) {
        console.log(`✓ ${e.agent} ${e.capability}/${e.scope} → ${e.target} (${e.method})`);
      }
      if (result.entries.length === 0) {
        console.log("无可下发的制品(检查通道过滤与 agent 能力)。");
      }
    });
}
