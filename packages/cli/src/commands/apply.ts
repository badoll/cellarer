import { apply, type Capability, type LinkMethod, type SecretMode } from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { printMutation } from "../mutation-output.js";
import { safeConsole as console, createSafeConsole } from "../output.js";
import { readProtectedPassphraseInput } from "./secret.js";

interface ApplyOpts {
  agent?: string;
  dir?: string;
  collection?: string;
  rules?: boolean;
  mcp?: boolean;
  skills?: boolean;
  copy?: boolean;
  mcpOverwrite?: boolean;
  secretMode?: string;
  vaultPassphraseFd?: string;
  keychainService?: string;
  replaceUnowned?: string;
  overrideDrift?: string;
  snapshotPassphraseFd?: string;
  dryRun?: boolean;
  json?: boolean;
}

// 从 --rules/--mcp/--skills 解析能力集合;都不给 → 默认全部三类。
function resolveCapabilities(opts: ApplyOpts): Capability[] {
  const caps: Capability[] = [];
  if (opts.rules) caps.push("rules");
  if (opts.mcp) caps.push("mcp");
  if (opts.skills) caps.push("skills");
  return caps.length > 0 ? caps : ["rules", "mcp", "skills"];
}

// 下发(distribute):库房资源 → agent。支持 rules / mcp / skills。
export function applyCommand(): Command {
  return new Command("apply")
    .description("下发库房资源到 agent(默认全局;指定 --dir 则下发到该工程)")
    .option("-a, --agent <ids>", "指定 agent(逗号分隔)")
    .option("--dir <path>", "下发到指定工程目录(否则下发到 agent 家目录)")
    .option("--collection <collection>", "按 collection 过滤")
    .option("--rules", "下发 rules")
    .option("--mcp", "下发 mcp")
    .option("--skills", "下发 skills")
    .option("--copy", "强制 copy(不软链)")
    .option("--mcp-overwrite", "mcp 用 overwrite 策略(默认 merge)")
    .option("--secret-mode <mode>", "密钥来源:env(默认)| vault | keychain")
    .option("--vault-passphrase-fd <number>", "从继承的文件描述符读取 vault 口令")
    .option("--keychain-service <name>", "keychain service 名称(默认 cellarer)")
    .option("--replace-unowned <tokens>", "确认 plan 返回的精确非托管替换 token(逗号分隔)")
    .option("--override-drift <tokens>", "确认 plan 返回的精确漂移覆盖 token(逗号分隔)")
    .option("--snapshot-passphrase-fd <number>", "从继承的文件描述符读取 snapshot 口令")
    .option("--dry-run", "仅预览,不落地")
    .option("--json", "输出完整 Core apply plan/result")
    .action(async (opts: ApplyOpts) => {
      // 校验 --secret-mode:无效值直接报错,避免被静默当作 vault 路径(导致密钥未解析却报成功)。
      const SECRET_MODES = ["env", "vault", "keychain"] as const;
      if (opts.secretMode && !SECRET_MODES.includes(opts.secretMode as SecretMode)) {
        console.error(`无效 --secret-mode "${opts.secretMode}";可选:${SECRET_MODES.join(" | ")}`);
        process.exitCode = 1;
        return;
      }
      const ctx = await resolveContext(opts, "required");
      if (ctx.agents.length === 0) {
        console.error("需指定 --agent <ids>(逗号分隔),例:--agent claude-code,codex");
        process.exitCode = 1;
        return;
      }
      const method: LinkMethod | undefined = opts.copy ? "copy" : undefined;
      const capabilities = resolveCapabilities(opts);
      const secretMode = opts.secretMode as SecretMode | undefined;
      const vaultPassphrase =
        secretMode === "vault"
          ? await readProtectedPassphraseInput(opts.vaultPassphraseFd)
          : undefined;
      const needsSnapshotPassphrase =
        !opts.dryRun && Boolean(opts.replaceUnowned || opts.overrideDrift);
      const snapshotPassphrase = needsSnapshotPassphrase
        ? await readProtectedPassphraseInput(opts.snapshotPassphraseFd)
        : undefined;

      const result = await apply(ctx.env, {
        storeRoot: ctx.storeRoot,
        scope: ctx.scope,
        dir: ctx.dir,
        agents: ctx.agents,
        collections: ctx.collections,
        capabilities,
        method,
        mcpStrategy: opts.mcpOverwrite ? "overwrite" : undefined,
        secretMode,
        vaultPassphrase,
        keychainService: opts.keychainService,
        replaceUnowned: parseTokens(opts.replaceUnowned),
        overrideDrift: parseTokens(opts.overrideDrift),
        snapshotPassphrase,
        dryRun: opts.dryRun,
      });
      const resultConsole = createSafeConsole(result);

      const blocked = result.plan.conflicts.length > 0;
      const failed = result.failures.length > 0;
      const operationFailed = result.mutation.result?.ok === false;
      const guarded = result.plan.actions.some(
        (action) =>
          action.op === "skip" &&
          (action.reason?.includes("secret-scan") || action.reason?.includes("secret-reference")),
      );
      if (blocked || failed || guarded || operationFailed) process.exitCode = 1;
      if (opts.json) {
        resultConsole.log(JSON.stringify(result, null, 2));
        return;
      }

      printMutation(result.mutation, resultConsole);
      for (const w of result.plan.warnings) resultConsole.warn(`⚠ ${w}`);
      for (const conflict of result.plan.conflicts) {
        resultConsole.error(`⛔ ${conflict.code} ${conflict.target} — ${conflict.message}`);
        if (conflict.acknowledgement) {
          resultConsole.error(`   acknowledgement: ${conflict.acknowledgement.token}`);
        }
      }
      for (const failure of result.failures) {
        resultConsole.error(`⛔ ${failure.code} ${failure.target} — ${failure.message}`);
      }

      if (opts.dryRun) {
        resultConsole.log("dry-run 预览:");
        for (const a of result.plan.actions) {
          if (a.op === "skip") {
            resultConsole.log(`  [skip] ${a.agent} ${a.capability}/${a.scope} — ${a.reason}`);
            continue;
          }
          const existed = a.preview?.before !== undefined ? "(覆盖既有)" : "(新建)";
          const detail = a.capability === "skills" ? "" : ` ${existed}`;
          resultConsole.log(`  [${a.op}] ${a.agent} ${a.capability} → ${a.target}${detail}`);
        }
        return;
      }

      for (const e of result.entries) {
        const refs =
          e.secretRefs && e.secretRefs.length > 0 ? ` 🔑[${e.secretRefs.join(",")}]` : "";
        resultConsole.log(
          `✓ ${e.agent} ${e.capability}/${e.scope} → ${e.target} (${e.receipt.method})${refs}`,
        );
      }
      // skip 的安全护栏命中要醒目提示(secret-scan 拦截)。
      for (const a of result.plan.actions) {
        if (
          a.op === "skip" &&
          (a.reason?.includes("secret-scan") || a.reason?.includes("secret-reference"))
        ) {
          resultConsole.error(`⛔ ${a.agent} ${a.capability} 被安全护栏拦截:${a.reason}`);
        }
      }
      if (result.entries.length === 0) {
        resultConsole.log("无可下发的资源(检查 collection 过滤与 agent 能力)。");
      }
    });
}

function parseTokens(spec: string | undefined): string[] | undefined {
  if (!spec) return undefined;
  const tokens = spec
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.length > 0 ? tokens : undefined;
}
