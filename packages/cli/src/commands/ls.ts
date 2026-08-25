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
import { safeConsole as console } from "../output.js";
import {
  type CommandContractMetadata,
  defineCommandContract,
} from "../protocol/command-contract.js";
import { type CliCommandOutcome, commandSuccess } from "../protocol/execution.js";

// 列出库房资源(rules / mcp / skills)及其 collection 标签。
export function createLsCommandContract(definition: CommandContractMetadata<"ls">) {
  return defineCommandContract<"ls", { readonly collection?: string }, LsCommandData>(definition, {
    createCommand: createLsCommand,
    normalize: ({ command }) => command.opts<{ collection?: string }>(),
    execute: executeLs,
    presentText: presentLsText,
    mapError: () => undefined,
  });
}

function createLsCommand(): Command {
  return new Command("ls")
    .description("列出库房资源(rules / mcp / skills)及其 collection 标签")
    .option("--collection <collection>", "按 collection 过滤");
}

interface ArtifactDto {
  readonly id: string;
  readonly kind: "rules" | "mcp" | "skills";
  readonly collections: readonly string[];
}

interface LsCommandData {
  readonly artifacts: readonly ArtifactDto[];
  readonly storeEmpty: boolean;
}

async function executeLs(opts: {
  readonly collection?: string;
}): Promise<CliCommandOutcome<LsCommandData>> {
  const ctx = await resolveContext(opts);
  const [config, rules, mcp, skills] = await Promise.all([
    loadConfig(ctx.env, ctx.storeRoot),
    listRuleArtifacts(ctx.env, ctx.storeRoot),
    listMcpArtifacts(ctx.env, ctx.storeRoot),
    listSkillArtifacts(ctx.env, ctx.storeRoot),
  ]);
  const artifacts = [
    ...publicArtifacts("rules", rules, config, opts.collection),
    ...publicArtifacts("mcp", mcp, config, opts.collection),
    ...publicArtifacts("skills", skills, config, opts.collection),
  ];
  return commandSuccess({
    artifacts,
    storeEmpty: rules.length + mcp.length + skills.length === 0,
  });
}

function presentLsText(outcome: CliCommandOutcome<LsCommandData>): void {
  if (!outcome.ok) return;
  if (outcome.data.storeEmpty) {
    console.log("库房暂无资源(先 cellarer init 并在 store/{rules,mcp,skills} 放置内容)。");
    return;
  }
  printPublicGroup("rules", outcome.data.artifacts);
  printPublicGroup("mcp", outcome.data.artifacts);
  printPublicGroup("skills", outcome.data.artifacts);
}

function publicArtifacts(
  kind: ArtifactDto["kind"],
  arts: Artifact[],
  config: { artifacts: Record<string, { collections: string[] }> },
  collection?: string,
): ArtifactDto[] {
  // collection 匹配规则与 plan 一致(复用 core 的 inCollections,不在 CLI 重写)。
  const visible = arts.filter((a) => {
    const collections = config.artifacts[a.id]?.collections ?? [];
    return !collection || inCollections(collections, [collection]);
  });
  return visible.map((artifact) => ({
    id: artifact.id,
    kind,
    collections: config.artifacts[artifact.id]?.collections ?? [],
  }));
}

function printPublicGroup(label: ArtifactDto["kind"], artifacts: readonly ArtifactDto[]): void {
  const visible = artifacts.filter((artifact) => artifact.kind === label);
  if (visible.length === 0) return;
  console.log(`${label} 资源:`);
  for (const artifact of visible) {
    const tag = artifact.collections.length > 0 ? ` [${artifact.collections.join(", ")}]` : "";
    console.log(`  ${artifact.id}${tag}`);
  }
}
