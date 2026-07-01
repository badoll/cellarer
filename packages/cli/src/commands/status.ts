import { status } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";

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
    .option("--agent <ids>", "指定 agent")
    .option("--dir <path>", "指定工程目录")
    .option("--json", "JSON 输出(CI 漂移检查用)")
    .action(async (opts: { agent?: string; dir?: string; json?: boolean }) => {
      const ctx = resolveContext(opts);
      const items = await status(ctx.env, {
        storeRoot: ctx.storeRoot,
        scope: ctx.scopeFilter,
        dir: ctx.dir,
        agents: ctx.agents.length > 0 ? ctx.agents : undefined,
      });
      if (opts.json) {
        console.log(JSON.stringify({ items }, null, 2));
        return;
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
