import {
  applyScan,
  type ConflictStrategy,
  type ScanItem,
  type SecretMode,
  scanPlan,
} from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { safeConsole as console, createSafeConsole } from "../output.js";
import { readProtectedPassphraseInput } from "./secret.js";

interface ScanOpts {
  agent?: string;
  dir?: string;
  rules?: boolean;
  mcp?: boolean;
  skills?: boolean;
  intoCollection?: string;
  conflict?: string;
  select?: string;
  dryRun?: boolean;
  json?: boolean;
  secretMode?: string;
  vaultPassphraseFd?: string;
  keychainService?: string;
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
export function scanCommand(resolve = resolveContext): Command {
  return new Command("scan")
    .description("扫描 agent 现有 rules/mcp/skills 回写库房(密钥自动脱敏为占位符)")
    .option("-a, --agent <id>", "扫描指定 agent")
    .option("--dir <path>", "扫描指定工程目录(project scope)")
    .option("--rules", "仅扫 rules")
    .option("--mcp", "仅扫 mcp")
    .option("--skills", "仅扫 skills")
    .option("--into-collection <collection>", "给导入资源归入 collection")
    .option("--conflict <strategy>", "冲突策略:keep-theirs(默认)| keep-mine | copy")
    .option("--select <names>", "仅导入这些资源名(逗号分隔)")
    .option("--dry-run", "仅预览发现项,不写库房")
    .option("--secret-mode <mode>", "密钥来源:env(默认)| vault | keychain")
    .option("--vault-passphrase-fd <number>", "从继承的文件描述符读取 vault 口令")
    .option("--keychain-service <name>", "keychain service 名称(默认 cellarer)")
    .option("--json", "JSON 输出(等价 CELLARER_JSON=1)")
    .action(async (opts: ScanOpts) => {
      const ctx = await resolve(opts, opts.dryRun ? "none" : "required");
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
      const requestedSecretMode = parseSecretMode(opts.secretMode);
      const secretMode = opts.dryRun ? "env" : requestedSecretMode;
      const vaultPassphrase =
        secretMode === "vault"
          ? await readProtectedPassphraseInput(opts.vaultPassphraseFd)
          : undefined;
      const scanArgs = {
        storeRoot: ctx.storeRoot,
        agent: ctx.agents[0] as string,
        scope: ctx.scope,
        dir: ctx.dir,
        intoCollection: opts.intoCollection,
        conflict: opts.conflict as ConflictStrategy | undefined,
        capabilities: resolveCaps(opts),
        select: opts.select
          ? opts.select
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
        secretMode,
        vaultPassphrase,
        keychainService: opts.keychainService,
      };

      if (opts.dryRun) {
        const plan = await scanPlan(ctx.env, scanArgs);
        const resultConsole = createSafeConsole(plan);
        if (json) {
          resultConsole.log(JSON.stringify(plan, null, 2));
          return;
        }
        for (const w of plan.warnings) resultConsole.warn(`⚠ ${w}`);
        if (plan.items.length === 0) {
          resultConsole.log("未发现可回写的资源。");
          return;
        }
        resultConsole.log("dry-run 发现项:");
        for (const it of plan.items) printItem(it, "将", resultConsole);
        return;
      }

      const result = await applyScan(ctx.env, scanArgs);
      const resultConsole = createSafeConsole(result);
      if (json) {
        resultConsole.log(JSON.stringify(result, null, 2));
        return;
      }
      for (const w of result.plan.warnings) resultConsole.warn(`⚠ ${w}`);
      if (result.imported.length === 0) {
        resultConsole.log("无新资源入库(检查冲突策略与 --select)。");
        return;
      }
      for (const it of result.imported) printItem(it, "已", resultConsole);
      // 提示:涉密资源需把真值存入 vault。
      const refs = result.imported.flatMap((i) => i.secretRefs ?? []);
      if (refs.length > 0) {
        resultConsole.log(`\n🔑 检测到密钥引用(真值未入库):${[...new Set(refs)].join(", ")}`);
        resultConsole.log("   用 cellarer secret add <name> --stdin 存入 vault。");
      }
    });
}

function parseSecretMode(value: string | undefined): SecretMode | undefined {
  if (value === undefined) return undefined;
  if (["env", "vault", "keychain"].includes(value)) return value as SecretMode;
  throw new TypeError(`无效 --secret-mode "${value}";可选:env | vault | keychain`);
}

function printItem(
  it: ScanItem,
  verb: string,
  output: Pick<Console, "log" | "warn" | "error">,
): void {
  const tag = it.status === "conflict" ? " [冲突]" : "";
  const refs = it.secretRefs && it.secretRefs.length > 0 ? ` 🔑[${it.secretRefs.join(",")}]` : "";
  output.log(`  ${verb}导入 ${it.kind}/${it.name}${tag}${refs}  ← ${it.source}`);
}
