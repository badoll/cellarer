import { type InventoryRefreshResult, refreshInventory } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { createSafeConsole } from "../output.js";
import {
  type CommandContractMetadata,
  defineCommandContract,
} from "../protocol/command-contract.js";
import { commandSuccess } from "../protocol/execution.js";

interface InventoryRefreshInput {
  readonly agentId?: string;
  readonly dir?: string;
}

export function inventoryCommandRoot(): Command {
  return new Command("inventory").description("刷新已注册来源中的统一资源清单");
}

export function createInventoryRefreshCommandContract(
  definition: CommandContractMetadata<"inventory.refresh">,
) {
  return defineCommandContract<"inventory.refresh", InventoryRefreshInput, InventoryRefreshResult>(
    definition,
    {
      createCommand: () =>
        new Command("refresh")
          .description("只读刷新所有已注册或指定 agent 的资源清单")
          .option("-a, --agent <id>", "精确的已注册 agent id")
          .option("--dir <path>", "当前 project 根目录"),
      normalize: ({ command }) => {
        const opts = command.opts<{ readonly agent?: string; readonly dir?: string }>();
        return {
          ...(opts.agent ? { agentId: opts.agent } : {}),
          ...(opts.dir ? { dir: opts.dir } : {}),
        };
      },
      execute: async (input) => {
        const ctx = await resolveContext(
          {
            ...(input.agentId ? { agent: input.agentId } : {}),
            ...(input.dir ? { dir: input.dir } : {}),
          },
          "none",
        );
        return commandSuccess(
          await refreshInventory(ctx.env, {
            storeRoot: ctx.storeRoot,
            ...(ctx.dir ? { projectRoot: ctx.dir } : {}),
            ...(input.agentId ? { agentId: input.agentId } : {}),
          }),
        );
      },
      presentText: (outcome) => {
        if (!outcome.ok) return;
        const output = createSafeConsole(outcome.data);
        const { counts } = outcome.data;
        output.log(
          `inventory: ${outcome.data.completeness} (${counts.total} candidates; ${counts.ready} ready, ${counts.needsAttention} need attention, ${counts.inStore} in Store)`,
        );
        output.log(`sources: ${counts.observedSources} observed, ${counts.failedSources} failed`);
        for (const candidate of outcome.data.candidates) {
          output.log(
            `${candidate.id} ${candidate.kind}/${candidate.name} state=${candidate.state} selected=${String(candidate.defaultSelected)}`,
          );
          output.log(`  fingerprint=${candidate.contentFingerprint}`);
          for (const source of candidate.sources) {
            output.log(`  source=${source.scope}:${source.location} (${source.id})`);
          }
          if (candidate.relatedAdapters.length > 0) {
            output.log(`  adapters=${candidate.relatedAdapters.map(({ id }) => id).join(",")}`);
          }
          for (const finding of candidate.findings) {
            output.warn(
              `  finding=${finding.code} severity=${finding.severity} remediation=${finding.remediation}`,
            );
          }
          if (candidate.managedMatch) {
            output.log(
              `  managed=${candidate.managedMatch.resourceId}@${candidate.managedMatch.revisionId}`,
            );
          }
        }
        for (const finding of outcome.data.findings) {
          output.warn(
            `finding=${finding.code} scope=${finding.scope} remediation=${finding.remediation}`,
          );
        }
      },
      mapError: () => undefined,
    },
  );
}
