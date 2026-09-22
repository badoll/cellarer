import {
  type AppliedInventorySecretAdoption,
  type AppliedInventoryStoreImport,
  applyInventorySecretAdoptionPlan,
  applyInventoryStoreImportPlan,
  type InventoryRefreshResult,
  InventorySecretAdoptionPlanningError,
  type InventorySecretFieldSelector,
  InventoryStoreImportPlanningError,
  type MutationPlan,
  type PlannedInventorySecretAdoption,
  type PlannedInventoryStoreImport,
  planInventorySecretAdoption,
  planInventoryStoreImport,
  refreshInventory,
} from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { createSafeConsole } from "../output.js";
import {
  type CommandContractMetadata,
  defineCommandContract,
} from "../protocol/command-contract.js";
import { cliErrorFromOperation, commandFailure, commandSuccess } from "../protocol/execution.js";
import { CliInputError, type CliInvocation, getCliInvocation } from "../protocol/input.js";

interface InventoryRefreshInput {
  readonly agentId?: string;
  readonly dir?: string;
}

interface InventoryImportPlanInput extends InventoryRefreshInput {
  readonly candidateIds?: readonly string[];
  readonly intoCollection?: string;
}

interface InventoryImportApplyInput {
  readonly mutationPlan?: unknown;
}

interface InventorySecretAdoptionPlanInput extends InventoryRefreshInput {
  readonly candidateId: string;
  readonly selector: InventorySecretFieldSelector;
  readonly provider: "vault" | "keychain";
}

interface InventorySecretAdoptionApplyInput {
  readonly mutationPlan?: unknown;
  readonly confirmed: boolean;
}

export interface InventorySecretAdoptionCommandService {
  plan(input: InventorySecretAdoptionPlanInput): Promise<PlannedInventorySecretAdoption>;
  apply(mutationPlan: MutationPlan): Promise<AppliedInventorySecretAdoption>;
}

export function inventoryCommandRoot(): Command {
  return new Command("inventory").description("刷新已注册来源中的统一资源清单");
}

export function createInventoryRefreshCommandContract(
  definition: CommandContractMetadata<"inventory.refresh">,
) {
  return defineCommandContract<"inventory.refresh", InventoryRefreshInput, InventoryRefreshResult>(
    definition,
    {
      createCommand: () =>
        new Command("refresh")
          .description("只读刷新所有已注册或指定 agent 的资源清单")
          .option("-a, --agent <id>", "精确的已注册 agent id")
          .option("--dir <path>", "当前 project 根目录"),
      normalize: ({ command }) => {
        const opts = command.opts<{ readonly agent?: string; readonly dir?: string }>();
        return {
          ...(opts.agent ? { agentId: opts.agent } : {}),
          ...(opts.dir ? { dir: opts.dir } : {}),
        };
      },
      execute: async (input) => {
        const ctx = await resolveContext(
          {
            ...(input.agentId ? { agent: input.agentId } : {}),
            ...(input.dir ? { dir: input.dir } : {}),
          },
          "none",
        );
        return commandSuccess(
          await refreshInventory(ctx.env, {
            storeRoot: ctx.storeRoot,
            ...(ctx.dir ? { projectRoot: ctx.dir } : {}),
            ...(input.agentId ? { agentId: input.agentId } : {}),
          }),
        );
      },
      presentText: (outcome) => {
        if (!outcome.ok) return;
        const output = createSafeConsole(outcome.data);
        const { counts } = outcome.data;
        output.log(
          `inventory: ${outcome.data.completeness} (${counts.total} candidates; ${counts.ready} ready, ${counts.needsAttention} need attention, ${counts.inStore} in Store)`,
        );
        output.log(`sources: ${counts.observedSources} observed, ${counts.failedSources} failed`);
        for (const coverage of outcome.data.coverage ?? []) {
          output.log(
            `coverage=${coverage.adapterId}:${coverage.dimension}:${coverage.sourceId ?? "-"} ${coverage.status} (${coverage.mode}) ${coverage.location ?? ""} ${coverage.bounds ? JSON.stringify(coverage.bounds) : ""} ${coverage.reason}`,
          );
        }
        for (const candidate of outcome.data.candidates) {
          output.log(
            `${candidate.id} ${candidate.kind}/${candidate.name} state=${candidate.state} selected=${String(candidate.defaultSelected)}`,
          );
          output.log(`  fingerprint=${candidate.contentFingerprint}`);
          for (const source of candidate.sources) {
            output.log(`  source=${source.scope}:${source.location} (${source.id})`);
          }
          if (candidate.relatedAdapters.length > 0) {
            output.log(`  adapters=${candidate.relatedAdapters.map(({ id }) => id).join(",")}`);
          }
          for (const effective of outcome.data.effectiveResources?.filter(
            (row) => row.candidateId === candidate.id,
          ) ?? []) {
            output.log(
              `  effective=${effective.adapterId}:${effective.scope}:${effective.sourceId} ${effective.state}: ${effective.reason} ${effective.evidence}`,
            );
          }
          for (const finding of candidate.findings) {
            output.warn(
              `  finding=${finding.code} severity=${finding.severity} remediation=${finding.remediation}`,
            );
          }
          if (candidate.managedMatch) {
            output.log(
              `  managed=${candidate.managedMatch.resourceId}@${candidate.managedMatch.revisionId}`,
            );
          }
        }
        for (const finding of outcome.data.findings) {
          output.warn(
            `finding=${finding.code} scope=${finding.scope} remediation=${finding.remediation}`,
          );
        }
      },
      mapError: () => undefined,
    },
  );
}

export function createInventoryImportPlanCommandContract(
  definition: CommandContractMetadata<"inventory.import.plan">,
) {
  return defineCommandContract<
    "inventory.import.plan",
    InventoryImportPlanInput,
    PlannedInventoryStoreImport
  >(definition, {
    createCommand: () =>
      new Command("plan")
        .description("按精确 candidate ID 生成可跨进程应用的 Store import receipt")
        .option("-c, --candidate <ids...>", "一个或多个精确 Inventory candidate ID")
        .option("-a, --agent <id>", "精确的已注册 agent id")
        .option("--dir <path>", "当前 project 根目录")
        .option("--into-collection <id>", "将导入资源加入现有 collection"),
    normalize: ({ command }) => {
      const opts = command.opts<{
        readonly candidate?: readonly string[];
        readonly agent?: string;
        readonly dir?: string;
        readonly intoCollection?: string;
      }>();
      return {
        ...(opts.candidate ? { candidateIds: opts.candidate } : {}),
        ...(opts.agent ? { agentId: opts.agent } : {}),
        ...(opts.dir ? { dir: opts.dir } : {}),
        ...(opts.intoCollection ? { intoCollection: opts.intoCollection } : {}),
      };
    },
    execute: async (input) => {
      const ctx = await resolveContext(
        {
          ...(input.agentId ? { agent: input.agentId } : {}),
          ...(input.dir ? { dir: input.dir } : {}),
        },
        "required",
      );
      return commandSuccess(
        await planInventoryStoreImport(ctx.env, {
          storeRoot: ctx.storeRoot,
          candidateIds: input.candidateIds ?? [],
          refresh: {
            ...(input.agentId ? { agentId: input.agentId } : {}),
            ...(ctx.dir ? { projectRoot: ctx.dir } : {}),
          },
          ...(input.intoCollection ? { intoCollection: input.intoCollection } : {}),
        }),
      );
    },
    presentText: (outcome) => {
      const output = createSafeConsole(outcome);
      if (!outcome.ok) {
        output.error(outcome.error.message);
        return;
      }
      output.log(
        `inventory import plan ${outcome.data.mutationPlan.planId}: ${outcome.data.candidateIds.length} exact candidates at Store revision ${outcome.data.mutationPlan.baseRevision}`,
      );
      for (const candidateId of outcome.data.candidateIds) output.log(`  candidate=${candidateId}`);
    },
    mapError: (error) =>
      error instanceof InventoryStoreImportPlanningError
        ? {
            code: error.code,
            message: error.message,
            details: { reason: error.reason },
          }
        : undefined,
  });
}

export function createInventoryImportApplyCommandContract(
  definition: CommandContractMetadata<"inventory.import.apply">,
) {
  return defineCommandContract<
    "inventory.import.apply",
    InventoryImportApplyInput,
    AppliedInventoryStoreImport
  >(definition, {
    createCommand: () =>
      new Command("apply")
        .description("应用调用方提供的、未改动的 Inventory Store import receipt")
        .option("--plan <json>", "inventory import plan 返回的完整 mutationPlan JSON"),
    normalize: ({ command }) => ({
      mutationPlan: parseMutationPlan(
        command.opts<{ readonly plan?: unknown }>().plan,
        getCliInvocation(command),
      ),
    }),
    execute: async (input) => {
      const ctx = await resolveContext({}, "required");
      const result = await applyInventoryStoreImportPlan(
        ctx.env,
        input.mutationPlan as MutationPlan,
        {
          storeRoot: ctx.storeRoot,
        },
      );
      const error = cliErrorFromOperation(result.operation);
      return error ? commandFailure<AppliedInventoryStoreImport>(error) : commandSuccess(result);
    },
    presentText: (outcome) => {
      const output = createSafeConsole(outcome);
      if (!outcome.ok) {
        output.error(outcome.error.message);
        return;
      }
      const receipt = outcome.data.operation.ok ? outcome.data.operation.receipt : undefined;
      output.log(
        receipt
          ? `inventory import ${receipt.outcome}: revision ${receipt.baseRevision} -> ${receipt.resultingRevision}`
          : "inventory import was not applied",
      );
    },
    mapError: () => undefined,
  });
}

export function createInventorySecretAdoptionPlanCommandContract(
  definition: CommandContractMetadata<"inventory.adopt.plan">,
  service?: InventorySecretAdoptionCommandService,
) {
  return defineCommandContract<
    "inventory.adopt.plan",
    InventorySecretAdoptionPlanInput,
    PlannedInventorySecretAdoption
  >(definition, {
    createCommand: () =>
      new Command("plan")
        .description("为一个受支持的 MCP 字段生成 reference-only adoption receipt")
        .requiredOption("--candidate <id>", "精确的 Inventory candidate ID")
        .requiredOption("--selector <json>", "Inventory finding 返回的精确字段 selector JSON")
        .requiredOption("--provider <provider>", "vault 或 keychain")
        .option("-a, --agent <id>", "精确的已注册 agent id")
        .option("--dir <path>", "当前 project 根目录"),
    normalize: ({ command }) => {
      const opts = command.opts<{
        readonly candidate: string;
        readonly selector: unknown;
        readonly provider: "vault" | "keychain";
        readonly agent?: string;
        readonly dir?: string;
      }>();
      return {
        candidateId: opts.candidate,
        selector: parseSelector(opts.selector, getCliInvocation(command)),
        provider: opts.provider,
        ...(opts.agent ? { agentId: opts.agent } : {}),
        ...(opts.dir ? { dir: opts.dir } : {}),
      };
    },
    execute: async (input) => {
      if (service) return commandSuccess(await service.plan(input));
      const ctx = await resolveContext(
        {
          ...(input.agentId ? { agent: input.agentId } : {}),
          ...(input.dir ? { dir: input.dir } : {}),
        },
        "required",
      );
      return commandSuccess(
        await planInventorySecretAdoption(ctx.env, {
          storeRoot: ctx.storeRoot,
          candidateId: input.candidateId,
          selector: input.selector,
          provider: input.provider,
          refresh: {
            ...(input.agentId ? { agentId: input.agentId } : {}),
            ...(ctx.dir ? { projectRoot: ctx.dir } : {}),
          },
        }),
      );
    },
    presentText: (outcome) => {
      const output = createSafeConsole(outcome);
      if (!outcome.ok) {
        output.error(outcome.error.message);
        return;
      }
      output.log(
        `inventory adoption plan ${outcome.data.mutationPlan.planId}: candidate=${outcome.data.candidateId} target=${outcome.data.targetName} provider=${outcome.data.provider.kind}`,
      );
    },
    mapError: (error) =>
      error instanceof InventorySecretAdoptionPlanningError
        ? { code: error.code, message: error.message, details: { reason: error.reason } }
        : undefined,
  });
}

export function createInventorySecretAdoptionApplyCommandContract(
  definition: CommandContractMetadata<"inventory.adopt.apply">,
  service?: InventorySecretAdoptionCommandService,
) {
  return defineCommandContract<
    "inventory.adopt.apply",
    InventorySecretAdoptionApplyInput,
    AppliedInventorySecretAdoption
  >(definition, {
    createCommand: () =>
      new Command("apply")
        .description("经显式确认后应用未改动的 secret-adoption receipt")
        .requiredOption("--plan <json>", "inventory adopt plan 返回的完整 mutationPlan JSON")
        .option("--confirm", "确认创建精确缺失的 provider reference 并发布 Store 引用"),
    normalize: ({ command }) => {
      const opts = command.opts<{ readonly plan?: unknown; readonly confirm?: boolean }>();
      return {
        mutationPlan: parseMutationPlan(opts.plan, getCliInvocation(command)),
        confirmed: opts.confirm === true,
      };
    },
    execute: async (input, execution) => {
      if (!input.confirmed) {
        throw new CliInputError(
          "INPUT_REQUIRED",
          "explicit adoption confirmation is required",
          { fields: ["confirmed"] },
          execution.invocation,
        );
      }
      const result = service
        ? await service.apply(input.mutationPlan as MutationPlan)
        : await (async () => {
            const ctx = await resolveContext({}, "required");
            return applyInventorySecretAdoptionPlan(ctx.env, input.mutationPlan as MutationPlan, {
              storeRoot: ctx.storeRoot,
            });
          })();
      const error = cliErrorFromOperation(result.operation);
      return error
        ? commandFailure<AppliedInventorySecretAdoption>(error, result)
        : commandSuccess(result);
    },
    presentText: (outcome) => {
      const output = createSafeConsole(outcome);
      const result = outcome.ok ? outcome.data : outcome.data;
      if (!result) {
        if (!outcome.ok) output.error(outcome.error.message);
        return;
      }
      output.log(
        `inventory adoption ${result.status}: target=${result.targetName ?? "untrusted"} provider=${result.provider?.kind ?? "untrusted"}`,
      );
      if (result.orphan) output.warn(`cleanup=${result.orphan.cleanupCommand}`);
    },
    mapError: () => undefined,
  });
}

function parseMutationPlan(value: unknown, invocation: CliInvocation): MutationPlan {
  if (value === undefined) {
    throw new CliInputError(
      "INPUT_REQUIRED",
      "plan is required",
      { fields: ["mutationPlan"] },
      invocation,
    );
  }
  if (typeof value !== "string") return value as MutationPlan;
  try {
    return JSON.parse(value) as MutationPlan;
  } catch {
    throw new CliInputError(
      "INVALID_INPUT",
      "plan must be valid JSON",
      { fields: ["mutationPlan"] },
      invocation,
    );
  }
}

function parseSelector(value: unknown, invocation: CliInvocation): InventorySecretFieldSelector {
  if (typeof value !== "string") return value as InventorySecretFieldSelector;
  try {
    return JSON.parse(value) as InventorySecretFieldSelector;
  } catch {
    throw new CliInputError(
      "INVALID_INPUT",
      "selector must be valid JSON",
      { fields: ["selector"] },
      invocation,
    );
  }
}
