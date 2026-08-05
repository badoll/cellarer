import { revert } from "@cellarer/core";
import { Command } from "commander";
import { parseAgents, resolveContext } from "../context.js";
import { printMutation } from "../mutation-output.js";
import { safeConsole as console } from "../output.js";
import {
  cliErrorFromMutationConflict,
  commandFailure,
  commandSuccess,
  commandWarnings,
  executeCliCommand,
} from "../protocol/execution.js";
import { assertNonInteractiveMutationInput, CliInputError } from "../protocol/input.js";
import { readProtectedPassphraseInput } from "./secret.js";

interface RevertOpts {
  agent?: string;
  dir?: string;
  keepBackups?: boolean;
  dryRun?: boolean;
  all?: boolean;
  acknowledge?: string;
  snapshotPassphraseFd?: string;
  json?: boolean;
}

// 依据台账回滚下发。
export function revertCommand(): Command {
  return new Command("revert")
    .description("依据台账回滚下发")
    .option("-a, --agent <ids>", "指定 agent")
    .option("--dir <path>", "指定工程目录")
    .option("--all", "回滚台账中的全部条目(无 --agent/--dir 时必须显式确认)")
    .option("--keep-backups", "保留 .bak 备份")
    .option("--acknowledge <tokens>", "确认 dry-run 返回的精确漂移 token(逗号分隔)")
    .option("--snapshot-passphrase-fd <number>", "从继承的文件描述符读取 snapshot 口令")
    .option("--dry-run", "仅预览,不落地")
    .option("--json", "输出完整 Core revert plan/result")
    .action(async (opts: RevertOpts, command: Command) => {
      await executeCliCommand(
        command,
        async (execution) => {
          const invocation = execution.invocation;
          assertNonInteractiveMutationInput(
            "revert",
            {
              agents: parseAgents(opts.agent),
              dir: opts.dir,
              all: opts.all,
              dryRun: opts.dryRun,
            },
            invocation,
          );
          const ctx = await resolveContext(opts, "required");
          const hasSelector = ctx.agents.length > 0 || ctx.dir !== undefined;
          if (!hasSelector && !opts.all && !opts.dryRun) {
            throw new CliInputError(
              "INPUT_REQUIRED",
              "revert requires agents, dir, or explicit all selection",
              { fields: ["agents|dir|all"] },
              invocation,
            );
          }
          const snapshotPassphrase =
            !opts.dryRun && (opts.acknowledge || opts.snapshotPassphraseFd)
              ? await readProtectedPassphraseInput(opts.snapshotPassphraseFd, undefined, {
                  nonInteractive: invocation.nonInteractive,
                  invocation,
                })
              : undefined;
          execution.event("REVERT_STARTED", { phase: "revert", current: 0, total: 1 });
          const result = await revert(ctx.env, {
            storeRoot: ctx.storeRoot,
            scope: ctx.scopeFilter,
            dir: ctx.dir,
            agents: ctx.agents.length > 0 ? ctx.agents : undefined,
            acknowledgements: parseTokens(opts.acknowledge),
            snapshotPassphrase,
            keepBackups: opts.keepBackups,
            dryRun: opts.dryRun,
          });
          execution.event("REVERT_COMPLETED", { phase: "revert", current: 1, total: 1 });
          const warnings = commandWarnings(result.warnings, "REVERT_WARNING");
          const operationConflict =
            result.mutation.result && !result.mutation.result.ok
              ? cliErrorFromMutationConflict(result.mutation.result.conflict)
              : undefined;
          const error =
            operationConflict ??
            (result.failures.length > 0
              ? { code: "PARTIAL_FAILURE" as const, message: "Revert reported action failures" }
              : result.plan.conflicts.length > 0 ||
                  (!opts.dryRun && result.plan.targets.some((target) => target.blocked))
                ? { code: "TARGET_CONFLICT" as const, message: "Revert plan is blocked" }
                : undefined);
          return error ? commandFailure(error, result, warnings) : commandSuccess(result, warnings);
        },
        (outcome) => {
          const result = outcome.data;
          if (!result) return;
          printRevertText(result, opts);
        },
      );
    });
}

function printRevertText(result: Awaited<ReturnType<typeof revert>>, opts: RevertOpts): void {
  printMutation(result.mutation);
  for (const warning of result.warnings) console.warn(`⚠ ${warning}`);
  for (const target of result.plan.targets) {
    if (!target.blocked) continue;
    console.error(`⛔ ${target.target} — ${target.blockReason ?? "revert blocked"}`);
    if (target.acknowledgement) {
      console.error(`   acknowledgement: ${target.acknowledgement.token}`);
    }
  }
  for (const failure of result.failures) {
    console.error(`⛔ ${failure.target} — ${failure.message}`);
  }
  if (result.plan.targets.length === 0) {
    console.log("台账中无匹配条目可回滚。");
    return;
  }
  if (opts.dryRun) {
    for (const target of result.plan.targets) {
      const verb = target.blocked ? "已阻止" : "将回滚";
      console.log(`↩ ${verb} ${target.proposedAction} → ${target.target}`);
    }
    return;
  }
  for (const entry of result.reverted) {
    console.log(`↩ 已回滚 ${entry.agent} ${entry.capability}/${entry.scope} → ${entry.target}`);
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
