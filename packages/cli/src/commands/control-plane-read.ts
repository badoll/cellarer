import {
  type Capability,
  type ControlPlaneAgentDto,
  type ControlPlaneCollectionDto,
  type ControlPlaneResourceDto,
  type Destination,
  diagnoseInterruptedOperation,
  diffControlPlane,
  discoverySummaryControlPlane,
  type LinkMethod,
  listControlPlaneAgents,
  listControlPlaneCollections,
  listControlPlaneOperations,
  listControlPlaneResources,
  mutationRecoveryPresentation,
  planApplyMutation,
  type ResourceState,
  recoverInterruptedOperation,
  type Scope,
  showControlPlaneAgent,
  showControlPlaneCollection,
  showControlPlaneConfig,
  showControlPlaneOperation,
  showControlPlaneResource,
  summaryControlPlane,
  validateControlPlaneConfig,
  verifyControlPlane,
} from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { createSafeConsole } from "../output.js";
import {
  type CommandContractMetadata,
  defineCommandContract,
} from "../protocol/command-contract.js";
import {
  cliErrorFromOperation,
  commandFailure,
  commandSuccess,
  publicOperationResult,
} from "../protocol/execution.js";
import { CliInputError, type CliInvocation } from "../protocol/input.js";
import { readProtectedPassphraseInput } from "./secret.js";

interface ResourceQueryOpts {
  readonly kind?: string;
  readonly state?: string;
  readonly source?: string;
  readonly agent?: string;
  readonly collection?: string;
  readonly destination?: string;
  readonly dir?: string;
  readonly includeDiscovered?: boolean;
}

interface AgentQueryOpts {
  readonly scope?: string;
  readonly dir?: string;
  readonly agent?: string;
}

interface VerificationOpts extends AgentQueryOpts {
  readonly collection?: string;
  readonly rules?: boolean;
  readonly mcp?: boolean;
  readonly skills?: boolean;
  readonly method?: string;
  readonly mcpStrategy?: string;
}

interface SummaryOpts extends VerificationOpts {
  readonly limit?: string | number;
  readonly includePlanCoverage?: boolean;
}

interface PlanOpts extends VerificationOpts {}

type OperationRecoveryCommandData =
  | { readonly diagnosis: ReturnType<typeof mutationRecoveryPresentation> }
  | { readonly operation: ReturnType<typeof publicOperationResult> };

export function resourceCommandRoot(): Command {
  return new Command("resource").description("检查受管与已发现资源");
}

export function agentCommandRoot(): Command {
  return new Command("agent").description("检查 agent adapter 状态与目标");
}

export function collectionCommandRoot(): Command {
  return new Command("collection").description("检查 collection 与精确成员");
}

export function configCommandRoot(): Command {
  return new Command("config").description("检查和验证 cellarer 配置");
}

export function discoveryCommandRoot(): Command {
  return new Command("discovery").description("检查 agent 中的可发现资源");
}

export function createDiscoverySummaryCommandContract(
  definition: CommandContractMetadata<"discovery.summary">,
) {
  return defineCommandContract<
    "discovery.summary",
    { readonly destination?: string; readonly dir?: string; readonly agent?: string },
    Awaited<ReturnType<typeof discoverySummaryControlPlane>>
  >(definition, {
    createCommand: () =>
      new Command("summary")
        .description("汇总 agent 目标中的可发现资源")
        .option("--destination <destination>", "目标:user | project")
        .option("--dir <path>", "project 目录")
        .option("-a, --agent <ids>", "agent id，逗号分隔"),
    normalize: ({ command }) =>
      command.opts<{ destination?: string; dir?: string; agent?: string }>(),
    execute: async (opts, { invocation }) => {
      const destination = parseDestination(
        requireValue(opts.destination, "destination", invocation),
        invocation,
      );
      const ctx = await resolveContext({ agent: opts.agent, dir: opts.dir }, "none");
      const data = await discoverySummaryControlPlane(ctx.env, {
        storeRoot: ctx.storeRoot,
        destination,
        ...(ctx.dir ? { dir: ctx.dir } : {}),
        ...(ctx.agents.length > 0 ? { agents: ctx.agents } : {}),
      });
      return commandSuccess(data);
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      const output = createSafeConsole(outcome.data);
      output.log(`discovery (${outcome.data.destination}):`);
      output.log(
        `  rules=${outcome.data.totals.rules} mcp=${outcome.data.totals.mcp} skills=${outcome.data.totals.skills}`,
      );
      for (const warning of outcome.data.warnings) output.warn(`⚠ ${warning}`);
    },
    mapError: () => undefined,
  });
}

export function operationCommandRoot(): Command {
  return new Command("operation").description("检查事务操作证据");
}

export function createOperationRecoverCommandContract(
  definition: CommandContractMetadata<"operation.recover">,
) {
  type RecoveryInput = {
    readonly operationId?: string;
    readonly opts: { readonly snapshotPassphraseFd?: string; readonly dryRun?: boolean };
  };
  return defineCommandContract<"operation.recover", RecoveryInput, OperationRecoveryCommandData>(
    definition,
    {
      createCommand: () =>
        new Command("recover")
          .description("按持久化证据恢复中断操作")
          .argument("[operationId]", "中断操作 ID")
          .option("--snapshot-passphrase-fd <number>", "从继承的文件描述符读取 snapshot 口令")
          .option("--dry-run", "仅诊断 recovery evidence，不执行恢复"),
      normalize: ({ actionArguments, command }) => ({
        operationId: actionArguments[0] as string | undefined,
        opts: command.opts<RecoveryInput["opts"]>(),
      }),
      execute: async ({ operationId, opts }, { invocation }) => {
        const id = requireValue(operationId, "operationId", invocation);
        const ctx = await resolveContext({}, "required");
        if (opts.dryRun) {
          const requested = await diagnoseInterruptedOperation(ctx.env, ctx.storeRoot, id);
          if (!requested.found) {
            return commandFailure({
              code: "DOMAIN_VALIDATION_FAILED",
              message: requested.message,
              details: { operationId: requested.operationId, reason: requested.status },
            });
          }
          return commandSuccess({
            diagnosis: mutationRecoveryPresentation(requested.diagnosis),
          });
        }
        const snapshotPassphrase = opts.snapshotPassphraseFd
          ? await readProtectedPassphraseInput(opts.snapshotPassphraseFd, undefined, {
              nonInteractive: invocation.nonInteractive,
              invocation,
            })
          : undefined;
        const operation = await recoverInterruptedOperation(ctx.env, ctx.storeRoot, {
          operationId: id,
          ...(snapshotPassphrase ? { snapshotPassphrase } : {}),
        });
        const data = { operation: publicOperationResult(operation) };
        const error = cliErrorFromOperation(operation);
        return error ? commandFailure(error, data) : commandSuccess(data);
      },
      presentText: (outcome) => {
        const output = createSafeConsole(outcome.ok ? outcome.data : outcome.error);
        if (!outcome.ok) {
          output.error(outcome.error.message);
          return;
        }
        if ("diagnosis" in outcome.data) {
          output.log(`recovery: ${outcome.data.diagnosis.status}`);
          const recoveryError = outcome.data.diagnosis.error;
          const detail =
            recoveryError && "guidance" in recoveryError
              ? recoveryError.guidance
              : recoveryError?.message;
          if (detail) output.log(`  ${detail}`);
          return;
        }
        output.log(
          outcome.data.operation.ok
            ? `recovered ${outcome.data.operation.receipt.operationId}`
            : "recovery requires manual handling",
        );
      },
      mapError: () => undefined,
    },
  );
}

export function createResourceListCommandContract(
  definition: CommandContractMetadata<"resource.list">,
) {
  return defineCommandContract<
    "resource.list",
    ResourceQueryOpts,
    Awaited<ReturnType<typeof listControlPlaneResources>>
  >(definition, {
    createCommand: () => addResourceQueryOptions(new Command("list").description("列出资源")),
    normalize: ({ command }) => command.opts<ResourceQueryOpts>(),
    execute: async (opts, { invocation }) => {
      const { ctx, query } = await resourceQuery(opts, invocation);
      return commandSuccess(await listControlPlaneResources(ctx.env, query));
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      const output = createSafeConsole(outcome.data);
      if (outcome.data.resources.length === 0) output.log("未找到匹配资源。");
      for (const resource of outcome.data.resources) printResource(resource, output);
      for (const warning of outcome.data.warnings) output.warn(`⚠ ${warning}`);
    },
    mapError: () => undefined,
  });
}

export function createResourceShowCommandContract(
  definition: CommandContractMetadata<"resource.show">,
) {
  return defineCommandContract<
    "resource.show",
    { readonly resourceId?: string; readonly opts: ResourceQueryOpts },
    Awaited<ReturnType<typeof showControlPlaneResource>>
  >(definition, {
    createCommand: () =>
      addResourceQueryOptions(
        new Command("show").description("按不可变 ID 检查资源").argument("[resourceId]", "资源 ID"),
      ),
    normalize: ({ actionArguments, command }) => ({
      resourceId: actionArguments[0] as string | undefined,
      opts: command.opts<ResourceQueryOpts>(),
    }),
    execute: async ({ resourceId, opts }, { invocation }) => {
      const id = requireValue(resourceId, "resourceId", invocation);
      const { ctx, query } = await resourceQuery(opts, invocation);
      return commandSuccess(await showControlPlaneResource(ctx.env, { ...query, resourceId: id }));
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      const output = createSafeConsole(outcome.data);
      if (outcome.data.resource) printResource(outcome.data.resource, output, true);
      else output.log("未找到资源。");
      for (const warning of outcome.data.warnings) output.warn(`⚠ ${warning}`);
    },
    mapError: () => undefined,
  });
}

function addResourceQueryOptions(command: Command): Command {
  return command
    .option("--kind <kind>", "资源类型:rules | mcp | skills")
    .option("--state <states>", "资源状态，逗号分隔")
    .option("--source <sources>", "精确来源，逗号分隔")
    .option("-a, --agent <ids>", "agent id，逗号分隔")
    .option("--collection <names>", "collection，逗号分隔")
    .option("--destination <destination>", "目标:user | project")
    .option("--dir <path>", "project 目录")
    .option("--no-include-discovered", "不扫描 agent 中的已发现资源");
}

async function resourceQuery(opts: ResourceQueryOpts, invocation: CliInvocation) {
  const kind = parseEnum(opts.kind, ["rules", "mcp", "skills"] as const, "kind", invocation);
  const states = parseEnumList(
    opts.state,
    ["managed", "discovered", "synced", "drifted", "missing", "blocked"] as const,
    "state",
    invocation,
  );
  const destination = parseDestination(opts.destination, invocation);
  const ctx = await resolveContext(
    { agent: opts.agent, dir: opts.dir, collection: opts.collection },
    "none",
  );
  return {
    ctx,
    query: {
      storeRoot: ctx.storeRoot,
      ...(kind ? { kind } : {}),
      ...(states ? { states: states as ResourceState[] } : {}),
      ...(parseList(opts.source) ? { sources: parseList(opts.source) } : {}),
      ...(ctx.agents.length > 0 ? { agents: ctx.agents } : {}),
      ...(parseList(opts.collection) ? { collections: parseList(opts.collection) } : {}),
      ...(destination ? { destination } : {}),
      ...(ctx.dir ? { dir: ctx.dir } : {}),
      ...(opts.includeDiscovered === undefined
        ? {}
        : { includeDiscovered: opts.includeDiscovered }),
    },
  };
}

export function createAgentListCommandContract(definition: CommandContractMetadata<"agent.list">) {
  return defineCommandContract<
    "agent.list",
    AgentQueryOpts,
    Awaited<ReturnType<typeof listControlPlaneAgents>>
  >(definition, {
    createCommand: () =>
      addAgentQueryOptions(new Command("list").description("列出 agent adapter")),
    normalize: ({ command }) => command.opts<AgentQueryOpts>(),
    execute: async (opts, { invocation }) => {
      const ctx = await resolveContext({ agent: opts.agent, dir: opts.dir }, "none");
      const scope = parseScope(opts.scope, invocation) ?? ctx.scope;
      return commandSuccess(
        await listControlPlaneAgents(ctx.env, {
          storeRoot: ctx.storeRoot,
          scope,
          ...(ctx.dir ? { dir: ctx.dir } : {}),
          ...(ctx.agents.length > 0 ? { agents: ctx.agents } : {}),
        }),
      );
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      const output = createSafeConsole(outcome.data);
      if (outcome.data.agents.length === 0) output.log("未找到匹配 agent。");
      for (const agent of outcome.data.agents) printAgent(agent, output);
      for (const warning of outcome.data.warnings) output.warn(`⚠ ${warning}`);
    },
    mapError: () => undefined,
  });
}

export function createAgentShowCommandContract(definition: CommandContractMetadata<"agent.show">) {
  return defineCommandContract<
    "agent.show",
    { readonly agentId?: string; readonly opts: AgentQueryOpts },
    Awaited<ReturnType<typeof showControlPlaneAgent>>
  >(definition, {
    createCommand: () =>
      addAgentQueryOptions(
        new Command("show")
          .description("按 adapter ID 检查 agent")
          .argument("[agentId]", "agent ID"),
      ),
    normalize: ({ actionArguments, command }) => ({
      agentId: actionArguments[0] as string | undefined,
      opts: command.opts<AgentQueryOpts>(),
    }),
    execute: async ({ agentId, opts }, { invocation }) => {
      const id = requireValue(agentId, "agentId", invocation);
      const ctx = await resolveContext({ agent: opts.agent, dir: opts.dir }, "none");
      const scope = parseScope(opts.scope, invocation) ?? ctx.scope;
      return commandSuccess(
        await showControlPlaneAgent(ctx.env, {
          storeRoot: ctx.storeRoot,
          scope,
          agentId: id,
          ...(ctx.dir ? { dir: ctx.dir } : {}),
        }),
      );
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      const output = createSafeConsole(outcome.data);
      if (outcome.data.agent) printAgent(outcome.data.agent, output, true);
      else output.log("未找到 agent。");
      for (const warning of outcome.data.warnings) output.warn(`⚠ ${warning}`);
    },
    mapError: () => undefined,
  });
}

function addAgentQueryOptions(command: Command): Command {
  return command
    .option("--scope <scope>", "作用域:global | project")
    .option("--dir <path>", "project 目录")
    .option("-a, --agent <ids>", "agent id，逗号分隔");
}

export function createCollectionListCommandContract(
  definition: CommandContractMetadata<"collection.list">,
) {
  return defineCommandContract<
    "collection.list",
    undefined,
    Awaited<ReturnType<typeof listControlPlaneCollections>>
  >(definition, {
    createCommand: () => new Command("list").description("列出 collections"),
    normalize: () => undefined,
    execute: async () => {
      const ctx = await resolveContext({}, "none");
      return commandSuccess(
        await listControlPlaneCollections(ctx.env, { storeRoot: ctx.storeRoot }),
      );
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      const output = createSafeConsole(outcome.data);
      if (outcome.data.collections.length === 0) output.log("暂无 collections。");
      for (const collection of outcome.data.collections) printCollection(collection, output);
    },
    mapError: () => undefined,
  });
}

export function createCollectionShowCommandContract(
  definition: CommandContractMetadata<"collection.show">,
) {
  return defineCommandContract<
    "collection.show",
    string | undefined,
    Awaited<ReturnType<typeof showControlPlaneCollection>>
  >(definition, {
    createCommand: () =>
      new Command("show")
        .description("按名称检查 collection")
        .argument("[collectionName]", "collection 名称"),
    normalize: ({ actionArguments }) => actionArguments[0] as string | undefined,
    execute: async (collectionName, { invocation }) => {
      const name = requireValue(collectionName, "collectionName", invocation);
      const ctx = await resolveContext({}, "none");
      return commandSuccess(
        await showControlPlaneCollection(ctx.env, {
          storeRoot: ctx.storeRoot,
          collectionName: name,
        }),
      );
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      const output = createSafeConsole(outcome.data);
      if (outcome.data.collection) printCollection(outcome.data.collection, output, true);
      else output.log("未找到 collection。");
    },
    mapError: () => undefined,
  });
}

export function createConfigShowCommandContract(
  definition: CommandContractMetadata<"config.show">,
) {
  return defineCommandContract<
    "config.show",
    undefined,
    Awaited<ReturnType<typeof showControlPlaneConfig>>
  >(definition, {
    createCommand: () => new Command("show").description("显示当前解析后的配置"),
    normalize: () => undefined,
    execute: async () => {
      const ctx = await resolveContext({}, "none");
      return commandSuccess(await showControlPlaneConfig(ctx.env, { storeRoot: ctx.storeRoot }));
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      const output = createSafeConsole(outcome.data);
      output.log(`revision: ${outcome.data.revision}`);
      output.log(JSON.stringify(outcome.data.config, null, 2));
    },
    mapError: () => undefined,
  });
}

export function createConfigValidateCommandContract(
  definition: CommandContractMetadata<"config.validate">,
) {
  return defineCommandContract<
    "config.validate",
    { readonly config?: unknown },
    ReturnType<typeof validateControlPlaneConfig>
  >(definition, {
    createCommand: () =>
      new Command("validate")
        .description("验证结构化配置，不写入 store")
        .option("--config <json>", "要验证的 JSON 配置"),
    normalize: ({ command }) => command.opts<{ config?: unknown }>(),
    execute: async (opts, { invocation }) => {
      if (opts.config === undefined) {
        throw new CliInputError(
          "INPUT_REQUIRED",
          "config validate requires a structured config",
          { fields: ["config"] },
          invocation,
        );
      }
      return commandSuccess(validateControlPlaneConfig(parseJson(opts.config, invocation)));
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      const output = createSafeConsole(outcome.data);
      if (outcome.data.valid) {
        output.log("配置有效。");
        return;
      }
      output.error("配置无效:");
      for (const issue of outcome.data.issues) output.error(`  ${issue.path}: ${issue.message}`);
    },
    mapError: () => undefined,
  });
}

export function createDiffCommandContract(definition: CommandContractMetadata<"diff">) {
  return defineCommandContract<
    "diff",
    VerificationOpts,
    Awaited<ReturnType<typeof diffControlPlane>>
  >(definition, {
    createCommand: () =>
      addVerificationOptions(new Command("diff").description("比较期望配置与已应用状态")),
    normalize: ({ command }) => command.opts<VerificationOpts>(),
    execute: async (opts, { invocation }) => {
      const { ctx, query } = await verificationQuery(opts, invocation);
      return commandSuccess(await diffControlPlane(ctx.env, query));
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      const output = createSafeConsole(outcome.data);
      output.log(
        `desired-vs-applied: ${outcome.data.status} (revision ${outcome.data.storeRevision})`,
      );
      for (const item of outcome.data.items)
        output.log(`  ${item.status ?? "?"} ${item.target ?? ""}`);
    },
    mapError: () => undefined,
  });
}

export function createVerifyCommandContract(definition: CommandContractMetadata<"verify">) {
  return defineCommandContract<
    "verify",
    VerificationOpts,
    Awaited<ReturnType<typeof verifyControlPlane>>
  >(definition, {
    createCommand: () =>
      addVerificationOptions(
        new Command("verify").description("组合验证期望状态、磁盘漂移和恢复状态"),
      ),
    normalize: ({ command }) => command.opts<VerificationOpts>(),
    execute: async (opts, { invocation }) => {
      const { ctx, query } = await verificationQuery(opts, invocation);
      return commandSuccess(await verifyControlPlane(ctx.env, query));
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      const output = createSafeConsole(outcome.data);
      output.log(outcome.data.healthy ? "验证通过。" : "验证发现问题。");
      output.log(`  desired-vs-applied: ${outcome.data.desiredVsApplied.status}`);
      output.log(`  applied-vs-disk: ${outcome.data.appliedVsDisk.status}`);
      output.log(`  recovery: ${outcome.data.recovery.status}`);
    },
    mapError: () => undefined,
  });
}

export function createSummaryCommandContract(definition: CommandContractMetadata<"summary">) {
  return defineCommandContract<
    "summary",
    SummaryOpts,
    Awaited<ReturnType<typeof summaryControlPlane>>
  >(definition, {
    createCommand: () =>
      addVerificationOptions(new Command("summary").description("汇总本地控制平面状态"))
        .option("--limit <count>", "最多返回的活动记录数")
        .option("--no-include-plan-coverage", "跳过只读 plan coverage"),
    normalize: ({ command }) => command.opts<SummaryOpts>(),
    execute: async (opts, { invocation }) => {
      const { ctx, query } = await verificationQuery(opts, invocation);
      const activityLimit = parseInteger(opts.limit, "activityLimit", invocation);
      return commandSuccess(
        await summaryControlPlane(ctx.env, {
          ...query,
          ...(activityLimit === undefined ? {} : { activityLimit }),
          ...(opts.includePlanCoverage === undefined
            ? {}
            : { includePlanCoverage: opts.includePlanCoverage }),
        }),
      );
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      const output = createSafeConsole(outcome.data);
      output.log(`resources: ${outcome.data.artifactCounts.total}`);
      output.log(
        `agents: ${outcome.data.agentCounts.ready} ready, ${outcome.data.agentCounts.warning} warning`,
      );
      output.log(
        `drift: ${Object.values(outcome.data.driftCounts).reduce((total, count) => total + count, 0)}`,
      );
    },
    mapError: () => undefined,
  });
}

export function createPlanCommandContract(definition: CommandContractMetadata<"plan">) {
  type Prepared = Awaited<ReturnType<typeof planApplyMutation>>;
  return defineCommandContract<
    "plan",
    PlanOpts,
    { readonly plan: Prepared["mutationPlan"]; readonly preview: Prepared["plan"] }
  >(definition, {
    createCommand: () =>
      addVerificationOptions(
        new Command("plan").description("生成只读、authority-sealed apply plan"),
      ),
    normalize: ({ command }) => command.opts<PlanOpts>(),
    execute: async (opts, { invocation }) => {
      const ctx = await resolveContext(
        { agent: opts.agent, dir: opts.dir, collection: opts.collection },
        "required",
      );
      if (ctx.agents.length === 0) {
        throw new CliInputError(
          "INPUT_REQUIRED",
          "plan requires at least one agent",
          { fields: ["agents"] },
          invocation,
        );
      }
      const scope = parseScope(opts.scope, invocation) ?? ctx.scope;
      if (scope === "project" && !ctx.dir) {
        throw new CliInputError(
          "INPUT_REQUIRED",
          "project scope requires dir",
          { fields: ["dir"] },
          invocation,
        );
      }
      const method = parseEnum(opts.method, ["symlink", "copy"] as const, "method", invocation);
      const mcpStrategy = parseEnum(
        opts.mcpStrategy,
        ["merge", "overwrite"] as const,
        "mcpStrategy",
        invocation,
      );
      const prepared = await planApplyMutation(ctx.env, {
        storeRoot: ctx.storeRoot,
        scope,
        agents: ctx.agents,
        ...(ctx.dir ? { dir: ctx.dir } : {}),
        ...(parseList(opts.collection) ? { collections: parseList(opts.collection) } : {}),
        ...(selectedCapabilities(opts) ? { capabilities: selectedCapabilities(opts) } : {}),
        ...(method ? { method: method as LinkMethod } : {}),
        ...(mcpStrategy ? { mcpStrategy } : {}),
        dryRun: true,
      });
      return commandSuccess({ plan: prepared.mutationPlan, preview: prepared.plan });
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      const output = createSafeConsole(outcome.data);
      output.log(`plan ${outcome.data.plan.planId} @ revision ${outcome.data.plan.baseRevision}`);
      for (const action of outcome.data.preview.actions) {
        output.log(`  [${action.op}] ${action.agent} ${action.capability} → ${action.target}`);
      }
    },
    mapError: () => undefined,
  });
}

export function createOperationListCommandContract(
  definition: CommandContractMetadata<"operation.list">,
) {
  return defineCommandContract<
    "operation.list",
    { readonly limit?: string | number },
    Awaited<ReturnType<typeof listControlPlaneOperations>>
  >(definition, {
    createCommand: () =>
      new Command("list")
        .description("列出已脱敏的操作回执")
        .option("--limit <count>", "最多返回的回执数"),
    normalize: ({ command }) => command.opts<{ limit?: string | number }>(),
    execute: async (opts, { invocation }) => {
      const ctx = await resolveContext({}, "none");
      const limit = parseInteger(opts.limit, "limit", invocation);
      return commandSuccess(
        await listControlPlaneOperations(ctx.env, {
          storeRoot: ctx.storeRoot,
          ...(limit === undefined ? {} : { limit }),
        }),
      );
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      const output = createSafeConsole(outcome.data);
      if (outcome.data.operations.length === 0) {
        output.log("暂无操作回执。");
        return;
      }
      for (const operation of outcome.data.operations) {
        output.log(
          `${operation.operationId} ${operation.operation} ${operation.outcome} r${operation.baseRevision}→r${operation.resultingRevision}`,
        );
      }
    },
    mapError: () => undefined,
  });
}

export function createOperationShowCommandContract(
  definition: CommandContractMetadata<"operation.show">,
) {
  return defineCommandContract<
    "operation.show",
    string | undefined,
    Awaited<ReturnType<typeof showControlPlaneOperation>>
  >(definition, {
    createCommand: () =>
      new Command("show")
        .description("按 ID 检查已脱敏的操作回执")
        .argument("[operationId]", "操作 ID"),
    normalize: ({ actionArguments }) => actionArguments[0] as string | undefined,
    execute: async (operationId, { invocation }) => {
      const id = requireValue(operationId, "operationId", invocation);
      const ctx = await resolveContext({}, "none");
      return commandSuccess(
        await showControlPlaneOperation(ctx.env, { storeRoot: ctx.storeRoot, operationId: id }),
      );
    },
    presentText: (outcome) => {
      if (!outcome.ok) return;
      const output = createSafeConsole(outcome.data);
      if (!outcome.data.operation) {
        output.log("未找到操作回执。");
        return;
      }
      const operation = outcome.data.operation;
      output.log(`${operation.operationId} ${operation.operation} ${operation.outcome}`);
      output.log(`  plan: ${operation.planId}`);
      output.log(`  recovery: ${operation.recoveryStatus}`);
    },
    mapError: () => undefined,
  });
}

async function verificationQuery(opts: VerificationOpts, invocation: CliInvocation) {
  const ctx = await resolveContext(
    { agent: opts.agent, dir: opts.dir, collection: opts.collection },
    "optional",
  );
  const scope = parseScope(opts.scope, invocation) ?? ctx.scope;
  const method = parseEnum(opts.method, ["symlink", "copy"] as const, "method", invocation);
  const mcpStrategy = parseEnum(
    opts.mcpStrategy,
    ["merge", "overwrite"] as const,
    "mcpStrategy",
    invocation,
  );
  return {
    ctx,
    query: {
      storeRoot: ctx.storeRoot,
      scope,
      agents: ctx.agents,
      ...(ctx.dir ? { dir: ctx.dir } : {}),
      ...(parseList(opts.collection) ? { collections: parseList(opts.collection) } : {}),
      ...(selectedCapabilities(opts) ? { capabilities: selectedCapabilities(opts) } : {}),
      ...(method ? { method } : {}),
      ...(mcpStrategy ? { mcpStrategy } : {}),
    },
  };
}

function addVerificationOptions(command: Command): Command {
  return command
    .option("--scope <scope>", "作用域:global | project")
    .option("--dir <path>", "project 目录")
    .option("-a, --agent <ids>", "agent id，逗号分隔")
    .option("--collection <names>", "collection，逗号分隔")
    .option("--rules", "验证 rules")
    .option("--mcp", "验证 MCP")
    .option("--skills", "验证 skills")
    .option("--method <method>", "落地方式:symlink | copy")
    .option("--mcp-strategy <strategy>", "MCP 策略:merge | overwrite");
}

function selectedCapabilities(opts: VerificationOpts): Capability[] | undefined {
  const capabilities: Capability[] = [];
  if (opts.rules) capabilities.push("rules");
  if (opts.mcp) capabilities.push("mcp");
  if (opts.skills) capabilities.push("skills");
  return capabilities.length > 0 ? capabilities : undefined;
}

function printResource(
  resource: ControlPlaneResourceDto,
  output: Pick<Console, "log" | "warn" | "error">,
  detail = false,
): void {
  output.log(`${resource.id} [${resource.state}] ${resource.source}`);
  output.log(`  collections: ${resource.membership.collections.join(", ") || "-"}`);
  output.log(`  desired: ${resource.selection.desired ? "yes" : "no"}`);
  output.log(`  applied targets: ${resource.usage.applied.length}`);
  if (!detail) return;
  output.log(`  validation: ${resource.validation.status}`);
  if (resource.provenance) output.log(`  provenance: ${JSON.stringify(resource.provenance)}`);
  for (const issue of resource.validation.issues)
    output.warn(`  ⚠ ${issue.path}: ${issue.message}`);
}

function printAgent(
  agent: ControlPlaneAgentDto,
  output: Pick<Console, "log" | "warn" | "error">,
  detail = false,
): void {
  output.log(
    `${agent.id} [${agent.adapterKind}] detected=${agent.detected} configured=${agent.configured} enabled=${agent.enabled}`,
  );
  output.log(`  capabilities: ${agent.capabilities.join(", ") || "-"}`);
  if (detail) {
    for (const target of agent.targets) {
      output.log(`  ${target.capability}/${target.scope}: ${target.path}`);
    }
  }
  for (const issue of agent.validationIssues) output.warn(`  ⚠ ${issue.path}: ${issue.message}`);
}

function printCollection(
  collection: ControlPlaneCollectionDto,
  output: Pick<Console, "log" | "warn" | "error">,
  detail = false,
): void {
  output.log(`${collection.name}${collection.isDefault ? " [default]" : ""}`);
  if (detail && collection.description) output.log(`  ${collection.description}`);
  output.log(`  resources: ${collection.resourceIds.join(", ") || "-"}`);
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

function parseEnumList<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  field: string,
  invocation: CliInvocation,
): T[] | undefined {
  const values = parseList(value);
  if (!values) return undefined;
  for (const entry of values) parseEnum(entry, allowed, field, invocation);
  return values as T[];
}

function parseEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  field: string,
  invocation: CliInvocation,
): T | undefined {
  if (value === undefined) return undefined;
  if (allowed.includes(value as T)) return value as T;
  throw new CliInputError(
    "INVALID_INPUT",
    `Invalid ${field}; expected ${allowed.join(", ")}`,
    { fields: [field] },
    invocation,
  );
}

function parseScope(value: string | undefined, invocation: CliInvocation): Scope | undefined {
  return parseEnum(value, ["global", "project"] as const, "scope", invocation);
}

function parseDestination(value: string, invocation: CliInvocation): Destination;
function parseDestination(
  value: string | undefined,
  invocation: CliInvocation,
): Destination | undefined;
function parseDestination(
  value: string | undefined,
  invocation: CliInvocation,
): Destination | undefined {
  return parseEnum(value, ["user", "project"] as const, "destination", invocation);
}

function parseJson(value: unknown, invocation: CliInvocation): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new CliInputError(
      "INVALID_INPUT",
      "config must be valid JSON",
      { fields: ["config"] },
      invocation,
    );
  }
}

function parseInteger(
  value: string | number | undefined,
  field: string,
  invocation: CliInvocation,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  throw new CliInputError(
    "INVALID_INPUT",
    `${field} must be a non-negative integer`,
    { fields: [field] },
    invocation,
  );
}

function requireValue<T>(value: T | undefined, field: string, invocation: CliInvocation): T {
  if (value !== undefined && (typeof value !== "string" || value.length > 0)) return value;
  throw new CliInputError(
    "INPUT_REQUIRED",
    `${field} is required`,
    { fields: [field] },
    invocation,
  );
}
