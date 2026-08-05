import { status, verify } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { printMutationRecovery } from "../mutation-output.js";
import { safeConsole as console } from "../output.js";

const ICON: Record<string, string> = {
  ok: "✓",
  drifted: "✗",
  missing: "∅",
  "broken-link": "⚠",
};

// 漂移检测:库房台账 vs 实际落地。
export function statusCommand(): Command {
  return new Command("status")
    .description("漂移检测(库房 vs 落地)")
    .option("-a, --agent <ids>", "指定 agent")
    .option("--dir <path>", "指定工程目录")
    .option("--json", "JSON 输出(CI 漂移检查用)")
    .action(async (opts: { agent?: string; dir?: string; json?: boolean }) => {
      const ctx = await resolveContext(opts);
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
      if (opts.json) {
        console.log(JSON.stringify({ items, ...(verification ? { verification } : {}) }, null, 2));
        return;
      }
      if (verification) {
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
      for (const it of items) {
        console.log(
          `${ICON[it.status] ?? "?"} ${it.status.padEnd(11)} ${it.agent} ${it.capability}/${it.scope} → ${it.target}`,
        );
      }
    });
}
