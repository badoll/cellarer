import {
  type Artifact,
  inCollections,
  listMcpArtifacts,
  listRuleArtifacts,
  listSkillArtifacts,
  loadConfig,
} from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";

// 列出库房资源(rules / mcp / skills)及其 collection 标签。
export function lsCommand(): Command {
  return new Command("ls")
    .description("列出库房资源(rules / mcp / skills)及其 collection 标签")
    .option("--collection <collection>", "按 collection 过滤")
    .action(async (opts: { collection?: string }) => {
      const ctx = resolveContext(opts);
      const [config, rules, mcp, skills] = await Promise.all([
        loadConfig(ctx.env, ctx.storeRoot),
        listRuleArtifacts(ctx.env, ctx.storeRoot),
        listMcpArtifacts(ctx.env, ctx.storeRoot),
        listSkillArtifacts(ctx.env, ctx.storeRoot),
      ]);
      const all = [...rules, ...mcp, ...skills];
      if (all.length === 0) {
        console.log("库房暂无资源(先 cellarer init 并在 store/{rules,mcp,skills} 放置内容)。");
        return;
      }
      printGroup("rules", rules, config, opts.collection);
      printGroup("mcp", mcp, config, opts.collection);
      printGroup("skills", skills, config, opts.collection);
    });
}

function printGroup(
  label: string,
  arts: Artifact[],
  config: { artifacts: Record<string, { collections: string[] }> },
  collection?: string,
): void {
  // collection 匹配规则与 plan 一致(复用 core 的 inCollections,不在 CLI 重写)。
  const visible = arts.filter((a) => {
    const collections = config.artifacts[a.id]?.collections ?? [];
    return !collection || inCollections(collections, [collection]);
  });
  if (visible.length === 0) return;
  console.log(`${label} 资源:`);
  for (const a of visible) {
    const collections = config.artifacts[a.id]?.collections ?? [];
    const tag = collections.length > 0 ? ` [${collections.join(", ")}]` : "";
    console.log(`  ${a.id}${tag}`);
  }
}
