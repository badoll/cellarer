import {
  type AddResult,
  add,
  type PresentedOperationResult,
  type SecretMode,
  type SkillCandidate,
} from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { createCliGitClient } from "../git-client.js";
import { createSafeConsole } from "../output.js";
import {
  cliErrorFromOperation,
  commandFailure,
  commandSuccess,
  commandWarnings,
  executeCliCommand,
  publicOperationResult,
} from "../protocol/execution.js";
import { CliInputError, type CliInvocation } from "../protocol/input.js";
import { readProtectedPassphraseInput } from "./secret.js";

interface AddCliOpts {
  force?: boolean;
  list?: boolean;
  skill?: string[];
  all?: boolean;
  collection?: string;
  yes?: boolean;
  json?: boolean;
  secretMode?: string;
  vaultPassphraseFd?: string;
  keychainService?: string;
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

interface AddCommandData {
  readonly imported: AddResult["imported"];
  readonly skipped: AddResult["skipped"];
  readonly rejected: AddResult["rejected"];
  readonly candidates: AddResult["candidates"];
  readonly operation?: PresentedOperationResult;
}

// 从源导入资源到库房。CLI 是薄壳:解析参数 + 注入 GitClient effect + 展示 core report。
export function addCommand(): Command {
  return new Command("add")
    .description("从本地路径或 GitHub source 导入资源到库房")
    .argument("[source]", "源:本地 .md/.json/skill 目录、GitHub owner/repo 或 GitHub URL")
    .option("--force", "同名资源已存在时覆盖(默认跳过)")
    .option("--list", "只列出可导入的 skill candidates,不写库房")
    .option("--skill <name>", "导入指定 skill;可重复传入", collect, [])
    .option("--all", "导入所有 eligible skills")
    .option("--collection <name>", "给导入资源归入 collection;internal 会包含 internal skills")
    .option("--yes", "跳过确认提示(当前 add 为非交互,保留命令面兼容)")
    .option("--secret-mode <mode>", "密钥来源:env(默认)| vault | keychain")
    .option("--vault-passphrase-fd <number>", "从继承的文件描述符读取 vault 口令")
    .option("--keychain-service <name>", "keychain service 名称(默认 cellarer)")
    .option("--json", "输出 JSON report")
    .action(async (source: string | undefined, opts: AddCliOpts, command: Command) => {
      await executeCliCommand(
        command,
        async (execution) => {
          const invocation = execution.invocation;
          if (!source) {
            throw new CliInputError(
              "INPUT_REQUIRED",
              "add requires an explicit source",
              { fields: ["source"] },
              invocation,
            );
          }
          if ((opts.skill?.length ?? 0) > 0 && opts.all) {
            throw new CliInputError(
              "INPUT_AMBIGUITY",
              "--skill and --all are mutually exclusive",
              { fields: ["skills", "all"] },
              invocation,
            );
          }
          const ctx = await resolveContext({}, opts.list ? "optional" : "required");
          const secretMode = parseSecretMode(opts.secretMode, invocation);
          const vaultPassphrase =
            secretMode === "vault"
              ? await readProtectedPassphraseInput(opts.vaultPassphraseFd, undefined, {
                  nonInteractive: invocation.nonInteractive,
                  invocation,
                })
              : undefined;
          const result = await add(ctx.env, {
            storeRoot: ctx.storeRoot,
            source,
            force: opts.force,
            list: opts.list,
            skills: opts.skill,
            all: opts.all,
            collection: opts.collection,
            yes: opts.yes,
            gitClient: createCliGitClient(),
            secretMode,
            vaultPassphrase,
            keychainService: opts.keychainService,
          });
          const data: AddCommandData = {
            imported: result.imported,
            skipped: result.skipped,
            rejected: result.rejected,
            candidates: result.candidates,
            ...(result.operation ? { operation: publicOperationResult(result.operation) } : {}),
          };
          const warnings = commandWarnings(result.warnings, "ADD_WARNING");
          const error = result.operation ? cliErrorFromOperation(result.operation) : undefined;
          const partialError =
            result.rejected.length > 0
              ? { code: "PARTIAL_FAILURE" as const, message: "One or more resources were rejected" }
              : undefined;
          const failure = error ?? partialError;
          return failure
            ? commandFailure(failure, data, warnings, result)
            : commandSuccess(data, warnings, result);
        },
        (outcome) => {
          const data = outcome.data;
          if (!data) return;
          printResult(data, opts, outcome.warnings, createSafeConsole(outcome.context));
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

function printResult(
  r: AddCommandData,
  opts: AddCliOpts,
  warnings: readonly { readonly message: string }[],
  output: Pick<Console, "log" | "warn" | "error">,
): void {
  if (opts.list) {
    printCandidates(r.candidates, output);
    return;
  }
  for (const i of r.imported) output.log(`✓ 已导入 ${i.kind}/${i.name} → ${i.path}`);
  for (const s of r.skipped) output.log(`- 跳过 ${s.kind}/${s.name}(${s.reason})`);
  for (const j of r.rejected) output.error(`✗ 拒绝 ${j.kind}/${j.name}(${j.reason})`);
  for (const warning of warnings) output.warn(`⚠ ${warning.message}`);
  if (r.operation?.ok === false) {
    output.error(`✗ mutation ${r.operation.conflict.code}: ${r.operation.conflict.message}`);
  }
  if (r.imported.length === 0 && r.skipped.length === 0 && r.rejected.length === 0) {
    output.log("未导入任何资源。");
  }
}

function printCandidates(
  candidates: SkillCandidate[],
  output: Pick<Console, "log" | "warn" | "error">,
): void {
  if (candidates.length === 0) {
    output.log("未发现可导入的 skills。");
    return;
  }
  output.log("可导入 skills:");
  for (const c of candidates) {
    const flags = [c.internal ? "internal" : "", c.rejected ? "rejected" : ""]
      .filter(Boolean)
      .join(", ");
    const tag = flags ? ` [${flags}]` : "";
    const reason = c.rejectionReason ? ` — ${c.rejectionReason}` : "";
    output.log(`  ${c.name}${tag} — ${c.description || "(no description)"}${reason}`);
  }
}
