import type { MutationPresentation, MutationRecoveryPresentation } from "@cellarer/core";
import { safeConsole as console } from "./output.js";

export function printMutation(
  mutation: MutationPresentation,
  output: Pick<Console, "log" | "error"> = console,
): void {
  output.log(
    `plan ${mutation.planId} (${mutation.operation}) base revision ${mutation.baseRevision}`,
  );
  if (!mutation.result) return;
  if (!mutation.result.ok) {
    output.error(`⛔ ${mutation.result.conflict.code} — ${mutation.result.conflict.message}`);
    return;
  }

  const receipt = mutation.result.receipt;
  output.log(
    `operation ${receipt.operationId} ${receipt.outcome}: revision ${receipt.baseRevision} → ${receipt.resultingRevision}`,
  );
  for (const action of receipt.actionReceipts) {
    output.log(`  ${action.outcome} ${action.actionId} → ${action.target}`);
  }
}

export function printMutationRecovery(recovery: MutationRecoveryPresentation): void {
  if (!recovery.error) return;
  const plan = recovery.planId ? ` plan ${recovery.planId}` : "";
  const revision =
    recovery.baseRevision === undefined ? "" : ` base revision ${recovery.baseRevision}`;
  console.error(`⛔ ${recovery.error.code}${plan}${revision} — ${recovery.error.message}`);
}
