import { apply, type Capability, type LinkMethod, type SecretMode } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";

interface ApplyOpts {
  agent?: string;
  dir?: string;
  channel?: string;
  rules?: boolean;
  mcp?: boolean;
  skills?: boolean;
  copy?: boolean;
  mcpOverwrite?: boolean;
  secretMode?: string;
  vaultPassphrase?: string;
  dryRun?: boolean;
}

// 从 --rules/--mcp/--skills 解析能力集合;都不给 → 默认全部三类。
function resolveCapabilities(opts: ApplyOpts): Capability[] {
  const caps: Capability[] = [];
  if (opts.rules) caps.push("rules");
  if (opts.mcp) caps.push("mcp");
  if (opts.skills) caps.push("skills");
  return caps.length > 0 ? caps : ["rules", "mcp", "skills"];
}

// 下发(distribute):库房 → agent。支持 rules / mcp / skills。
export function applyCommand(): Command {
  return new Command("apply")
    .description("下发库房制品到 agent(默认全局;指定 --dir 则下发到该工程)")
    .option("--agent <ids>", "指定 agent(逗号分隔)")
    .option("--dir <path>", "下发到指定工程目录(否则下发到 agent 家目录)")
    .option("--channel <channel>", "按通道过滤")
    .option("--rules", "下发 rules")
    .option("--mcp", "下发 mcp")
    .option("--skills", "下发 skills")
    .option("--copy", "强制 copy(不软链)")
    .option("--mcp-overwrite", "mcp 用 overwrite 策略(默认 merge)")
    .option("--secret-mode <mode>", "密钥来源:env(默认)| vault | keychain")
    .option("--vault-passphrase <pp>", "vault 口令(secret-mode=vault 时用;留空走交互更安全)")
    .option("--dry-run", "仅预览,不落地")
    .action(async (opts: ApplyOpts) => {
      const ctx = resolveContext(opts);
      if (ctx.agents.length === 0) {
        console.error("需指定 --agent <ids>(逗号分隔),例:--agent claude-code,codex");
        process.exitCode = 1;
        return;
      }
      const method: LinkMethod | undefined = opts.copy ? "copy" : undefined;
      const capabilities = resolveCapabilities(opts);
      // 校验 --secret-mode:无效值直接报错,避免被静默当作 vault 路径(导致密钥未解析却报成功)。
      const SECRET_MODES = ["env", "vault", "keychain"] as const;
      if (opts.secretMode && !SECRET_MODES.includes(opts.secretMode as SecretMode)) {
        console.error(`无效 --secret-mode "${opts.secretMode}";可选:${SECRET_MODES.join(" | ")}`);
        process.exitCode = 1;
        return;
      }
      const secretMode = opts.secretMode as SecretMode | undefined;

      const result = await apply(ctx.env, {
        storeRoot: ctx.storeRoot,
        scope: ctx.scope,
        dir: ctx.dir,
        agents: ctx.agents,
        channels: ctx.channels,
        capabilities,
        method,
        mcpStrategy: opts.mcpOverwrite ? "overwrite" : undefined,
        secretMode,
        vaultPassphrase: opts.vaultPassphrase,
        dryRun: opts.dryRun,
      });

      for (const w of result.plan.warnings) console.warn(`⚠ ${w}`);

      if (opts.dryRun) {
        console.log("dry-run 预览:");
        for (const a of result.plan.actions) {
          if (a.op === "skip") {
            console.log(`  [skip] ${a.agent} ${a.capability}/${a.scope} — ${a.reason}`);
            continue;
          }
          const existed = a.preview?.before !== undefined ? "(覆盖既有)" : "(新建)";
          const detail = a.capability === "skills" ? "" : ` ${existed}`;
          console.log(`  [${a.op}] ${a.agent} ${a.capability} → ${a.target}${detail}`);
        }
        return;
      }

      for (const e of result.entries) {
        const refs =
          e.secretRefs && e.secretRefs.length > 0 ? ` 🔑[${e.secretRefs.join(",")}]` : "";
        console.log(`✓ ${e.agent} ${e.capability}/${e.scope} → ${e.target} (${e.method})${refs}`);
      }
      // skip 的安全护栏命中要醒目提示(secret-scan 拦截)。
      for (const a of result.plan.actions) {
        if (a.op === "skip" && a.reason?.includes("secret-scan")) {
          console.error(`⛔ ${a.agent} ${a.capability} 被安全护栏拦截:${a.reason}`);
          process.exitCode = 1;
        }
      }
      if (result.entries.length === 0) {
        console.log("无可下发的制品(检查通道过滤与 agent 能力)。");
      }
    });
}
