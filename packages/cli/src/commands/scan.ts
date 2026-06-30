import { applyScan, type ConflictStrategy, type ScanItem, scanPlan } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";

interface ScanOpts {
  agent?: string;
  dir?: string;
  rules?: boolean;
  mcp?: boolean;
  skills?: boolean;
  intoChannel?: string;
  conflict?: string;
  select?: string;
  dryRun?: boolean;
  json?: boolean;
}

const CONFLICTS: ConflictStrategy[] = ["keep-theirs", "keep-mine", "copy"];

function resolveCaps(opts: ScanOpts): ("rules" | "mcp" | "skills")[] | undefined {
  const caps: ("rules" | "mcp" | "skills")[] = [];
  if (opts.rules) caps.push("rules");
  if (opts.mcp) caps.push("mcp");
  if (opts.skills) caps.push("skills");
  return caps.length > 0 ? caps : undefined; // undefined = 全部
}

// 扫描回写(import):agent/目录现有配置 → 规范化 + 脱敏 → 写库房。
// scan 默认即非交互(无确认提示):用 --dry-run 预览,--select 缩范围,CELLARER_JSON=1 出 JSON。
export function scanCommand(): Command {
  return new Command("scan")
    .description("扫描 agent 现有 rules/mcp/skills 回写库房(密钥自动脱敏为占位符)")
    .option("--agent <id>", "扫描指定 agent")
    .option("--dir <path>", "扫描指定工程目录(project scope)")
    .option("--rules", "仅扫 rules")
    .option("--mcp", "仅扫 mcp")
    .option("--skills", "仅扫 skills")
    .option("--into-channel <channel>", "入库制品归入通道")
    .option("--conflict <strategy>", "冲突策略:keep-theirs(默认)| keep-mine | copy")
    .option("--select <names>", "仅导入这些制品名(逗号分隔)")
    .option("--dry-run", "仅预览发现项,不写库房")
    .option("--json", "JSON 输出(等价 CELLARER_JSON=1)")
    .action(async (opts: ScanOpts) => {
      const ctx = resolveContext(opts);
      if (ctx.agents.length !== 1) {
        console.error("scan 需指定单个 --agent <id>,例:--agent claude-code");
        process.exitCode = 1;
        return;
      }
      if (opts.conflict && !CONFLICTS.includes(opts.conflict as ConflictStrategy)) {
        console.error(`无效 --conflict "${opts.conflict}";可选:${CONFLICTS.join(" | ")}`);
        process.exitCode = 1;
        return;
      }
      const json = opts.json || process.env.CELLARER_JSON === "1";
      const scanArgs = {
        storeRoot: ctx.storeRoot,
        agent: ctx.agents[0] as string,
        scope: ctx.scope,
        dir: ctx.dir,
        intoChannel: opts.intoChannel,
        conflict: opts.conflict as ConflictStrategy | undefined,
        capabilities: resolveCaps(opts),
        select: opts.select
          ? opts.select
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
      };

      if (opts.dryRun) {
        const plan = await scanPlan(ctx.env, scanArgs);
        if (json) {
          console.log(JSON.stringify(plan, null, 2));
          return;
        }
        for (const w of plan.warnings) console.warn(`⚠ ${w}`);
        if (plan.items.length === 0) {
          console.log("未发现可回写的制品。");
          return;
        }
        console.log("dry-run 发现项:");
        for (const it of plan.items) printItem(it, "将");
        return;
      }

      const result = await applyScan(ctx.env, scanArgs);
      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      for (const w of result.plan.warnings) console.warn(`⚠ ${w}`);
      if (result.imported.length === 0) {
        console.log("无新制品入库(检查冲突策略与 --select)。");
        return;
      }
      for (const it of result.imported) printItem(it, "已");
      // 提示:涉密制品需把真值存入 vault。
      const refs = result.imported.flatMap((i) => i.secretRefs ?? []);
      if (refs.length > 0) {
        console.log(`\n🔑 检测到密钥引用(真值未入库):${[...new Set(refs)].join(", ")}`);
        console.log("   用 cellarer secret add <name> <value> 存入 vault。");
      }
    });
}

function printItem(it: ScanItem, verb: string): void {
  const tag = it.status === "conflict" ? " [冲突]" : "";
  const refs = it.secretRefs && it.secretRefs.length > 0 ? ` 🔑[${it.secretRefs.join(",")}]` : "";
  console.log(`  ${verb}导入 ${it.kind}/${it.name}${tag}${refs}  ← ${it.source}`);
}
