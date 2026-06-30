import {
  type Artifact,
  inChannels,
  listMcpArtifacts,
  listRuleArtifacts,
  listSkillArtifacts,
  loadConfig,
} from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";

// 列出库房制品(rules / mcp / skills)及其通道标签。
export function lsCommand(): Command {
  return new Command("ls")
    .description("列出库房制品(rules / mcp / skills)及其通道标签")
    .option("--channel <channel>", "按通道过滤")
    .action(async (opts: { channel?: string }) => {
      const ctx = resolveContext(opts);
      const [config, rules, mcp, skills] = await Promise.all([
        loadConfig(ctx.env, ctx.storeRoot),
        listRuleArtifacts(ctx.env, ctx.storeRoot),
        listMcpArtifacts(ctx.env, ctx.storeRoot),
        listSkillArtifacts(ctx.env, ctx.storeRoot),
      ]);
      const all = [...rules, ...mcp, ...skills];
      if (all.length === 0) {
        console.log("库房暂无制品(先 cellarer init 并在 store/{rules,mcp,skills} 放置内容)。");
        return;
      }
      printGroup("rules", rules, config, opts.channel);
      printGroup("mcp", mcp, config, opts.channel);
      printGroup("skills", skills, config, opts.channel);
    });
}

function printGroup(
  label: string,
  arts: Artifact[],
  config: { artifacts: Record<string, { channels: string[] }> },
  channel?: string,
): void {
  // 通道匹配规则与 plan 一致(复用 core 的 inChannels,不在 CLI 重写)。
  const visible = arts.filter((a) => {
    const channels = config.artifacts[a.id]?.channels ?? [];
    return !channel || inChannels(channels, [channel]);
  });
  if (visible.length === 0) return;
  console.log(`${label} 制品:`);
  for (const a of visible) {
    const channels = config.artifacts[a.id]?.channels ?? [];
    const tag = channels.length > 0 ? ` [${channels.join(", ")}]` : "";
    console.log(`  ${a.id}${tag}`);
  }
}
