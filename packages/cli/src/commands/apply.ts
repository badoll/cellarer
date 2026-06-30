import { apply, type Capability, type LinkMethod } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";

interface ApplyOpts {
  agent?: string;
  dir?: string;
  channel?: string;
  rules?: boolean;
  copy?: boolean;
  dryRun?: boolean;
}

// 下发(distribute):库房 → agent。M1 支持 rules。
// 注:--global / --yes 等留待后续里程碑(分别需要「全局铺所有 agent」与交互确认),
//    M1 不暴露空壳 flag,避免用户以为生效。作用域由有无 --dir 决定。
export function applyCommand(): Command {
  return new Command("apply")
    .description("下发库房制品到 agent(默认全局;指定 --dir 则下发到该工程)")
    .option("--agent <ids>", "指定 agent(逗号分隔)")
    .option("--dir <path>", "下发到指定工程目录(否则下发到 agent 家目录)")
    .option("--channel <channel>", "按通道过滤")
    .option("--rules", "仅下发 rules(M1 默认即 rules)")
    .option("--copy", "强制 copy(不软链)")
    .option("--dry-run", "仅预览,不落地")
    .action(async (opts: ApplyOpts) => {
      const ctx = resolveContext(opts);
      if (ctx.agents.length === 0) {
        console.error("需指定 --agent <ids>(逗号分隔),例:--agent claude-code,codex");
        process.exitCode = 1;
        return;
      }
      const method: LinkMethod | undefined = opts.copy ? "copy" : undefined;
      // M1 仅 rules 能力;--rules 是显式同义(为 M2 多能力选择预留)。
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
