import {
  type AgentDoctorReport,
  type DiagnosticCheck,
  type DoctorReport,
  doctor,
} from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";

interface DoctorOpts {
  agent?: string;
  dir?: string;
  json?: boolean;
}

export function doctorCommand(): Command {
  return new Command("doctor")
    .description("检查库房、adapter 注册表、agent 探测与目标路径写权限")
    .option("-a, --agent <ids>", "只检查指定 agent(逗号分隔)")
    .option("--dir <path>", "按 project scope 检查目标路径")
    .option("--json", "JSON 输出")
    .action(async (opts: DoctorOpts) => {
      const ctx = resolveContext(opts);
      const report = await doctor(ctx.env, {
        storeRoot: ctx.storeRoot,
        scope: ctx.scope,
        dir: ctx.dir,
        agents: ctx.agents.length > 0 ? ctx.agents : undefined,
      });

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        if (hasErrors(report)) process.exitCode = 1;
        return;
      }

      for (const w of report.warnings) console.warn(`⚠ ${w}`);
      console.log(`cellarer doctor (${report.scope})`);
      for (const check of report.checks) printCheck(check, "  ");

      if (report.agents.length > 0) console.log("agents:");
      for (const agent of report.agents) printAgent(agent);

      if (hasErrors(report)) process.exitCode = 1;
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
