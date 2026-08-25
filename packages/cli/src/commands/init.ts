import { createInterface } from "node:readline/promises";
import {
  type AppliedInventoryStoreImport,
  applyInventoryStoreImportPlan,
  type InventoryRefreshResult,
  InventoryStoreImportPlanningError,
  initializeStore,
  type PlannedInventoryStoreImport,
  planInventoryStoreImport,
  refreshInventory,
} from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { safeConsole as console, createSafeConsole } from "../output.js";
import {
  type CommandContractMetadata,
  defineCommandContract,
} from "../protocol/command-contract.js";
import { commandSuccess, publicOperationResult } from "../protocol/execution.js";

interface InitOpts {
  readonly global?: boolean;
  readonly dryRun?: boolean;
}

export type InitInventoryImportConfirmer = (plan: PlannedInventoryStoreImport) => Promise<boolean>;

type InitConfirmationPhase =
  | {
      readonly status: "not-offered";
      readonly candidateIds: readonly string[];
      readonly reason: "inventory-incomplete" | "no-ready-candidates" | "non-interactive";
    }
  | { readonly status: "declined"; readonly candidateIds: readonly string[] }
  | { readonly status: "confirmed"; readonly candidateIds: readonly string[] };

type InitImportPhase =
  | { readonly status: "not-started" }
  | {
      readonly status: "failed";
      readonly error: { readonly code: string; readonly reason: string };
    }
  | {
      readonly status: "applied";
      readonly candidateIds: readonly string[];
      readonly resourceIds: readonly string[];
      readonly operation: ReturnType<typeof publicOperationResult>;
      readonly warnings: readonly string[];
    };

interface InteractiveInitCommandData {
  readonly store: {
    readonly storeRoot: string;
    readonly createdConfig: boolean;
    readonly operation: ReturnType<typeof publicOperationResult>;
  };
  readonly inventory: InventoryRefreshResult;
  readonly confirmation: InitConfirmationPhase;
  readonly import: InitImportPhase;
}

type InitCommandData =
  | InteractiveInitCommandData
  | {
      readonly dryRun: true;
      readonly storeRoot: string;
    };

interface InitCommandInput {
  readonly opts: InitOpts;
}

// 初始化库房:委托给 core 并发安全 initializer(不变量 1:CLI 不写 fs 业务逻辑)。
export function createInitCommandContract(
  definition: CommandContractMetadata<"init">,
  confirmImport: InitInventoryImportConfirmer = confirmInventoryImport,
) {
  return defineCommandContract<"init", InitCommandInput, InitCommandData>(definition, {
    createCommand: () =>
      new Command("init")
        .description("初始化库房并刷新统一 Inventory")
        .option("--global", "初始化全局库房(默认)")
        .option("--dry-run", "仅解析库房位置，不创建或修改库房"),
    normalize: ({ command }) => ({ opts: command.opts<InitOpts>() }),
    execute: async ({ opts }, { invocation }) => {
      const preview = await resolveContext({}, "none");
      if (opts.dryRun) {
        return commandSuccess({
          dryRun: true as const,
          storeRoot: preview.storeRoot,
        });
      }
      return executeInventoryInit(invocation.nonInteractive, confirmImport);
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      if ("store" in outcome.data) {
        presentInteractiveInventoryInit(outcome.data);
        return;
      }
      if ("dryRun" in outcome.data) {
        console.log(`dry-run: would initialize ${outcome.data.storeRoot}`);
      }
    },
    mapError: () => undefined,
  });
}

async function executeInventoryInit(
  nonInteractive: boolean,
  confirmImport: InitInventoryImportConfirmer,
): Promise<ReturnType<typeof commandSuccess<InteractiveInitCommandData>>> {
  const { env, storeRoot } = await resolveContext({}, "provision");
  const initialized = await initializeStore(env, storeRoot);
  const inventory = await refreshInventory(env, { storeRoot });
  const candidateIds = inventory.candidates
    .filter((candidate) => candidate.state === "ready" && candidate.defaultSelected)
    .map((candidate) => candidate.id);
  const store = {
    storeRoot: initialized.storeRoot,
    createdConfig: initialized.createdConfig,
    operation: publicOperationResult(initialized.operation),
  };
  if (nonInteractive) {
    return commandSuccess({
      store,
      inventory,
      confirmation: {
        status: "not-offered",
        candidateIds,
        reason: "non-interactive",
      },
      import: { status: "not-started" },
    });
  }
  if (inventory.completeness !== "complete") {
    return commandSuccess({
      store,
      inventory,
      confirmation: {
        status: "not-offered",
        candidateIds,
        reason: "inventory-incomplete",
      },
      import: { status: "not-started" },
    });
  }
  if (candidateIds.length === 0) {
    return commandSuccess({
      store,
      inventory,
      confirmation: {
        status: "not-offered",
        candidateIds,
        reason: "no-ready-candidates",
      },
      import: { status: "not-started" },
    });
  }

  let planned: PlannedInventoryStoreImport;
  try {
    planned = await planInventoryStoreImport(env, { storeRoot, candidateIds });
  } catch (error) {
    if (!(error instanceof InventoryStoreImportPlanningError)) throw error;
    return commandSuccess({
      store,
      inventory,
      confirmation: {
        status: "not-offered",
        candidateIds,
        reason: "inventory-incomplete",
      },
      import: {
        status: "failed",
        error: {
          code: error.code,
          reason: error.reason,
        },
      },
    });
  }
  const confirmed = await confirmImport(planned);
  if (!confirmed) {
    return commandSuccess({
      store,
      inventory: planned.inventory,
      confirmation: { status: "declined", candidateIds: planned.candidateIds },
      import: { status: "not-started" },
    });
  }
  const applied = await applyInventoryStoreImportPlan(env, planned.mutationPlan, { storeRoot });
  return commandSuccess({
    store,
    inventory: planned.inventory,
    confirmation: { status: "confirmed", candidateIds: planned.candidateIds },
    import: publicInventoryImport(applied),
  });
}

async function confirmInventoryImport(plan: PlannedInventoryStoreImport): Promise<boolean> {
  const output = createSafeConsole(plan);
  presentInventorySummary(output, plan.inventory);
  for (const candidate of plan.inventory.candidates.filter(({ id }) =>
    plan.candidateIds.includes(id),
  )) {
    output.log(`  selected ${candidate.kind}/${candidate.name} (${candidate.id})`);
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(
      `Import ${plan.candidateIds.length} exact ready candidate${plan.candidateIds.length === 1 ? "" : "s"} into Store? [y/N] `,
    );
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

function publicInventoryImport(applied: AppliedInventoryStoreImport): InitImportPhase {
  return {
    status: "applied",
    candidateIds: applied.candidateIds,
    resourceIds: applied.resourceIds,
    operation: publicOperationResult(applied.operation),
    warnings: applied.warnings,
  };
}

function presentInteractiveInventoryInit(data: InteractiveInitCommandData): void {
  const output = createSafeConsole(data);
  const note = data.store.createdConfig ? "" : " (config.json 已存在,保留)";
  if (data.store.operation.ok) {
    output.log(
      `库房已初始化:${data.store.storeRoot}${note} (operation ${data.store.operation.receipt.operationId}, revision ${data.store.operation.receipt.resultingRevision})`,
    );
  }
  presentInventorySummary(output, data.inventory);
  if (data.confirmation.status === "declined") {
    output.log("inventory import declined; Store initialization remains complete");
  } else if (data.confirmation.status === "not-offered") {
    if (data.confirmation.reason === "inventory-incomplete") {
      output.warn(
        "Inventory is incomplete; no import was offered. Retry: cellarer inventory refresh",
      );
    } else if (data.confirmation.reason === "non-interactive") {
      output.log("inventory import not offered in non-interactive mode");
    } else {
      output.log("inventory import not offered: no new or changed ready candidates");
    }
  }
  if (data.import.status === "failed") {
    output.warn(
      `inventory import plan failed: ${data.import.error.code}/${data.import.error.reason}. Retry: cellarer inventory refresh`,
    );
  } else if (data.import.status === "applied") {
    if (data.import.operation.ok) {
      output.log(
        `inventory import ${data.import.operation.receipt.outcome}: ${data.import.resourceIds.length} resources`,
      );
    } else {
      output.warn(
        `inventory import failed: ${data.import.operation.conflict.code}. Retry: cellarer inventory refresh, then create a new exact plan`,
      );
    }
  }
}

function presentInventorySummary(
  output: ReturnType<typeof createSafeConsole>,
  inventory: InventoryRefreshResult,
): void {
  output.log(
    `inventory: ${inventory.completeness} (${inventory.counts.total} candidates; ${inventory.counts.ready} ready, ${inventory.counts.needsAttention} need attention, ${inventory.counts.inStore} in Store)`,
  );
  output.log(
    `sources: ${inventory.counts.observedSources} observed, ${inventory.counts.failedSources} failed`,
  );
}
