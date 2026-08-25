import {
  type AgentDoctorReport,
  type DiagnosticCheck,
  type DoctorReport,
  doctor,
} from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { printMutationRecovery } from "../mutation-output.js";
import { safeConsole as console } from "../output.js";
import {
  type CommandContractMetadata,
  defineCommandContract,
} from "../protocol/command-contract.js";
import { commandFailure, commandSuccess, commandWarnings } from "../protocol/execution.js";

interface DoctorOpts {
  readonly agent?: string;
  readonly dir?: string;
  readonly json?: boolean;
}

type DoctorCommandData = Omit<DoctorReport, "warnings">;

export function createDoctorCommandContract(definition: CommandContractMetadata<"doctor">) {
  return defineCommandContract<"doctor", DoctorOpts, DoctorCommandData>(definition, {
    createCommand: () =>
      new Command("doctor")
        .description("检查库房、adapter 注册表、agent 探测与目标路径写权限")
        .option("-a, --agent <ids>", "只检查指定 agent(逗号分隔)")
        .option("--dir <path>", "按 project scope 检查目标路径")
        .option("--json", "JSON 输出"),
    normalize: ({ command }) => command.opts<DoctorOpts>(),
    execute: async (opts) => {
      const ctx = await resolveContext(opts);
      const report = await doctor(ctx.env, {
        storeRoot: ctx.storeRoot,
        scope: ctx.scope,
        dir: ctx.dir,
        agents: ctx.agents.length > 0 ? ctx.agents : undefined,
      });
      const { warnings, ...data } = report;
      const cliWarnings = commandWarnings(warnings, "DOCTOR_WARNING");
      if (!hasErrors(report)) return commandSuccess(data, cliWarnings);
      const recoveryRequired = report.mutationRecovery.error !== undefined;
      return commandFailure(
        {
          code: recoveryRequired ? "RECOVERY_REQUIRED" : "DOMAIN_VALIDATION_FAILED",
          message: recoveryRequired
            ? "Mutation recovery is required"
            : "Doctor checks reported errors",
        },
        data,
        cliWarnings,
      );
    },
    presentText: (outcome) => {
      const data = outcome.data;
      if (!data) return;
      for (const warning of outcome.warnings) console.warn(`⚠ ${warning.message}`);
      console.log(`cellarer doctor (${data.scope})`);
      printMutationRecovery(data.mutationRecovery);
      for (const check of data.checks) printCheck(check, "  ");
      if (data.agents.length > 0) console.log("agents:");
      for (const agent of data.agents) printAgent(agent);
    },
    mapError: () => undefined,
  });
}

function printAgent(agent: AgentDoctorReport): void {
  const mark = agent.detected ? "✓" : "∅";
  const enabled = agent.enabled ? "" : " [disabled]";
  console.log(`  ${mark} ${agent.id} — ${agent.displayName}${enabled}`);
  for (const check of agent.checks) printCheck(check, "    ");
}

function printCheck(check: DiagnosticCheck, indent: string): void {
  const icon = check.status === "ok" ? "✓" : check.status === "warning" ? "⚠" : "✗";
  const suffix = check.path ? ` (${check.path})` : "";
  console.log(`${indent}${icon} ${check.message}${suffix}`);
}

function hasErrors(report: DoctorReport): boolean {
  return (
    report.checks.some((check) => check.status === "error") ||
    report.agents.some((agent) => agent.checks.some((check) => check.status === "error"))
  );
}
