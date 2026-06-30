import { inChannels, listRuleArtifacts, loadConfig } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";

// 列出库房 rules 制品及其通道标签。
export function lsCommand(): Command {
  return new Command("ls")
    .description("列出库房制品与下发分布")
    .option("--channel <channel>", "按通道过滤")
    .option("--agent <ids>", "按 agent 过滤")
    .action(async (opts: { channel?: string }) => {
      const ctx = resolveContext(opts);
      const [config, arts] = await Promise.all([
        loadConfig(ctx.env, ctx.storeRoot),
        listRuleArtifacts(ctx.env, ctx.storeRoot),
      ]);
      if (arts.length === 0) {
        console.log("库房暂无 rules 制品(先 cellarer init 并在 store/rules 放置 .md)。");
        return;
      }
      console.log("rules 制品:");
      for (const a of arts) {
        const channels = config.artifacts[a.id]?.channels ?? [];
        // 通道匹配规则与 plan 一致(复用 core 的 inChannels,不在 CLI 重写)。
        if (opts.channel && !inChannels(channels, [opts.channel])) continue;
        const tag = channels.length > 0 ? ` [${channels.join(", ")}]` : "";
        console.log(`  ${a.id}${tag}`);
      }
    });
}
