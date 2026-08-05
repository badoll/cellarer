import { apply, type Capability, type LinkMethod, type SecretMode } from "@cellarer/core";
import { Command } from "commander";
import { parseAgents, resolveContext } from "../context.js";
import { printMutation } from "../mutation-output.js";
import { createSafeConsole } from "../output.js";
import {
  cliErrorFromMutationConflict,
  commandFailure,
  commandSuccess,
  commandWarnings,
  executeCliCommand,
} from "../protocol/execution.js";
import {
  assertNonInteractiveMutationInput,
  CliInputError,
  type CliInvocation,
} from "../protocol/input.js";
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

// 从 --rules/--mcp/--skills 解析显式能力集合。仅交互式 text 路径保留默认全部。
function selectedCapabilities(opts: ApplyOpts): Capability[] {
  const caps: Capability[] = [];
  if (opts.rules) caps.push("rules");
  if (opts.mcp) caps.push("mcp");
  if (opts.skills) caps.push("skills");
  return caps;
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
    .action(async (opts: ApplyOpts, command: Command) => {
      await executeCliCommand(
        command,
        async (execution) => {
          const invocation = execution.invocation;
          const secretMode = parseSecretMode(opts.secretMode, invocation);
          const explicitCapabilities = selectedCapabilities(opts);
          assertNonInteractiveMutationInput(
            "apply",
            {
              agents: parseAgents(opts.agent),
              capabilities: explicitCapabilities,
              dryRun: opts.dryRun,
            },
            invocation,
          );
          const ctx = await resolveContext(opts, "required");
          if (ctx.agents.length === 0) {
            throw new CliInputError(
              "INPUT_REQUIRED",
              "apply requires at least one agent",
              { fields: ["agents"] },
              invocation,
            );
          }
          const method: LinkMethod | undefined = opts.copy ? "copy" : undefined;
          const capabilities =
            explicitCapabilities.length > 0
              ? explicitCapabilities
              : (["rules", "mcp", "skills"] satisfies Capability[]);
          const vaultPassphrase =
            secretMode === "vault"
              ? await readProtectedPassphraseInput(opts.vaultPassphraseFd, undefined, {
                  nonInteractive: invocation.nonInteractive,
                  invocation,
                })
              : undefined;
          const needsSnapshotPassphrase =
            !opts.dryRun && Boolean(opts.replaceUnowned || opts.overrideDrift);
          const snapshotPassphrase = needsSnapshotPassphrase
            ? await readProtectedPassphraseInput(opts.snapshotPassphraseFd, undefined, {
                nonInteractive: invocation.nonInteractive,
                invocation,
              })
            : undefined;

          execution.event("APPLY_STARTED", { phase: "apply", current: 0, total: 1 });
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
          execution.event("APPLY_COMPLETED", { phase: "apply", current: 1, total: 1 });
          const warnings = commandWarnings(result.plan.warnings, "APPLY_WARNING");
          const operationConflict =
            result.mutation.result && !result.mutation.result.ok
              ? cliErrorFromMutationConflict(result.mutation.result.conflict)
              : undefined;
          const guarded = result.plan.actions.some(
            (action) =>
              action.op === "skip" &&
              (action.reason?.includes("secret-scan") ||
                action.reason?.includes("secret-reference")),
          );
          const error =
            operationConflict ??
            (result.failures.length > 0
              ? { code: "PARTIAL_FAILURE" as const, message: "Apply reported action failures" }
              : result.plan.conflicts.length > 0
                ? { code: "TARGET_CONFLICT" as const, message: "Apply plan is blocked" }
                : guarded
                  ? {
                      code: "POLICY_VIOLATION" as const,
                      message: "Apply was blocked by a safety guard",
                    }
                  : undefined);
          return error ? commandFailure(error, result, warnings) : commandSuccess(result, warnings);
        },
        (outcome) => {
          const result = outcome.data;
          if (!result) return;
          const resultConsole = createSafeConsole(result);
          printApplyText(result, opts, resultConsole);
        },
      );
    });
}

function parseSecretMode(
  value: string | undefined,
  invocation: CliInvocation,
): SecretMode | undefined {
  if (value === undefined) return undefined;
  if (["env", "vault", "keychain"].includes(value)) return value as SecretMode;
  throw new CliInputError(
    "INVALID_INPUT",
    "Invalid --secret-mode; expected env, vault, or keychain",
    { fields: ["secretMode"] },
    invocation,
  );
}

function printApplyText(
  result: Awaited<ReturnType<typeof apply>>,
  opts: ApplyOpts,
  output: Pick<Console, "log" | "warn" | "error">,
): void {
  printMutation(result.mutation, output);
  for (const warning of result.plan.warnings) output.warn(`⚠ ${warning}`);
  for (const conflict of result.plan.conflicts) {
    output.error(`⛔ ${conflict.code} ${conflict.target} — ${conflict.message}`);
    if (conflict.acknowledgement) {
      output.error(`   acknowledgement: ${conflict.acknowledgement.token}`);
    }
  }
  for (const failure of result.failures) {
    output.error(`⛔ ${failure.code} ${failure.target} — ${failure.message}`);
  }
  if (opts.dryRun) {
    output.log("dry-run 预览:");
    for (const action of result.plan.actions) {
      if (action.op === "skip") {
        output.log(
          `  [skip] ${action.agent} ${action.capability}/${action.scope} — ${action.reason}`,
        );
        continue;
      }
      const existed = action.preview?.before !== undefined ? "(覆盖既有)" : "(新建)";
      const detail = action.capability === "skills" ? "" : ` ${existed}`;
      output.log(
        `  [${action.op}] ${action.agent} ${action.capability} → ${action.target}${detail}`,
      );
    }
    return;
  }
  for (const entry of result.entries) {
    const refs =
      entry.secretRefs && entry.secretRefs.length > 0 ? ` 🔑[${entry.secretRefs.join(",")}]` : "";
    output.log(
      `✓ ${entry.agent} ${entry.capability}/${entry.scope} → ${entry.target} (${entry.receipt.method})${refs}`,
    );
  }
  for (const action of result.plan.actions) {
    if (
      action.op === "skip" &&
      (action.reason?.includes("secret-scan") || action.reason?.includes("secret-reference"))
    ) {
      output.error(`⛔ ${action.agent} ${action.capability} 被安全护栏拦截:${action.reason}`);
    }
  }
  if (result.entries.length === 0) {
    output.log("无可下发的资源(检查 collection 过滤与 agent 能力)。");
  }
}

function parseTokens(spec: string | undefined): string[] | undefined {
  if (!spec) return undefined;
  const tokens = spec
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.length > 0 ? tokens : undefined;
}
