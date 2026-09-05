import { status, VerificationInputError, verify } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { printMutationRecovery } from "../mutation-output.js";
import { safeConsole as console } from "../output.js";
import {
  type CommandContractMetadata,
  defineCommandContract,
} from "../protocol/command-contract.js";
import { commandSuccess } from "../protocol/execution.js";

const ICON: Record<string, string> = {
  ok: "✓",
  drifted: "✗",
  missing: "∅",
  "broken-link": "⚠",
};

interface StatusOpts {
  readonly agent?: string;
  readonly dir?: string;
  readonly json?: boolean;
}

interface StatusCommandData {
  readonly items: Awaited<ReturnType<typeof status>>;
  readonly verification?: Awaited<ReturnType<typeof verify>>;
}

// 漂移检测:库房台账 vs 实际落地。
export function createStatusCommandContract(definition: CommandContractMetadata<"status">) {
  return defineCommandContract<"status", StatusOpts, StatusCommandData>(definition, {
    createCommand: () =>
      new Command("status")
        .description("漂移检测(库房 vs 落地)")
        .option("-a, --agent <ids>", "指定 agent")
        .option("--dir <path>", "指定工程目录")
        .option("--json", "JSON 输出(CI 漂移检查用)"),
    normalize: ({ command }) => command.opts<StatusOpts>(),
    execute: async (opts) => {
      const ctx = await resolveContext(opts, "none");
      const verification =
        ctx.agents.length > 0
          ? await verify(ctx.env, {
              storeRoot: ctx.storeRoot,
              scope: ctx.scope,
              dir: ctx.dir,
              agents: ctx.agents,
              collections: ctx.collections,
              capabilities: ["rules", "mcp", "skills"],
            })
          : undefined;
      const items = verification
        ? [...verification.appliedVsDisk.items]
        : await status(ctx.env, {
            storeRoot: ctx.storeRoot,
            scope: ctx.scopeFilter,
            dir: ctx.dir,
          });
      return commandSuccess({ items, ...(verification ? { verification } : {}) });
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      const { items, verification } = outcome.data;
      if (verification) {
        console.log(
          `configuration: ${verification.configuration}; native runtime: ${verification.runtime.observation}`,
        );
        console.log(
          `coverage: ${verification.coverage.observed}/${verification.coverage.expected}`,
        );
        console.log(`desired-vs-applied: ${verification.desiredVsApplied.status}`);
        for (const item of verification.desiredVsApplied.items) {
          if (item.status === "in-sync") continue;
          console.log(
            `  ${item.status} ${item.agent} ${item.capability}/${item.scope} → ${item.target}`,
          );
        }
        console.log(`applied-vs-disk: ${verification.appliedVsDisk.status}`);
        printMutationRecovery(verification.recovery);
      }
      if (items.length === 0) {
        console.log("台账为空(尚未 apply)。");
        return;
      }
      for (const item of items) {
        console.log(
          `${ICON[item.status] ?? "?"} ${item.status.padEnd(11)} ${item.agent} ${item.capability}/${item.scope} → ${item.target}`,
        );
      }
    },
    mapError: (error) =>
      error instanceof VerificationInputError
        ? { code: "INVALID_INPUT", message: error.message }
        : undefined,
  });
}
