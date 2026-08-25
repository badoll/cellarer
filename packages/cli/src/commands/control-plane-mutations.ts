import {
  ControlPlaneDependencyError,
  ControlPlaneValidationError,
  mutateBuiltinAgent,
  mutateCollection,
  mutateControlPlaneSettings,
  mutateCustomAdapter,
  type PlannedControlPlaneMutationDto,
  parseAdapterBodyConfig,
  parseAdapterPatchConfig,
  parseControlPlaneSettingFields,
  parseControlPlaneSettingsPatch,
} from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { createSafeConsole } from "../output.js";
import {
  type CommandContractMetadata,
  defineCommandContract,
} from "../protocol/command-contract.js";
import { type CliCommandOutcome, commandFailure, commandSuccess } from "../protocol/execution.js";
import { CliInputError, type CliInvocation } from "../protocol/input.js";

interface MutationOpts {
  readonly dryRun?: boolean;
}

interface AdapterMutationOpts extends MutationOpts {
  readonly adapter?: unknown;
}

interface SettingsMutationOpts extends MutationOpts {
  readonly settings?: unknown;
  readonly field?: unknown;
}

interface CollectionMutationOpts extends MutationOpts {
  readonly description?: string;
  readonly resource?: unknown;
  readonly collection?: unknown;
}

type BuiltinAgentAction = "enable" | "disable" | "configure" | "reset";
type CustomAdapterAction = "add" | "update" | "remove";
type CollectionAction = "create" | "update" | "delete" | "set-members" | "set-defaults";

interface AgentMutationInput extends AdapterMutationOpts {
  readonly agentId?: string;
}

interface CollectionMutationInput extends CollectionMutationOpts {
  readonly collectionName?: string;
}

export function createBuiltinAgentMutationCommandContract<
  TCommand extends "agent.enable" | "agent.disable" | "agent.configure" | "agent.reset",
>(definition: CommandContractMetadata<TCommand>, action: BuiltinAgentAction) {
  const builtInOnly = action === "reset" || action === "configure";
  return defineCommandContract<TCommand, AgentMutationInput, PlannedControlPlaneMutationDto>(
    definition,
    {
      createCommand: () => {
        const command = new Command(action)
          .description(
            action === "reset"
              ? "reset a built-in adapter override"
              : action === "configure"
                ? "configure a built-in adapter override"
                : `${action} an agent through a planned adapter override`,
          )
          .argument("[agentId]", builtInOnly ? "built-in adapter id" : "adapter id");
        if (action === "configure") {
          command.option("--adapter <json>", "typed adapter override JSON");
        }
        return command.option("--dry-run", "仅返回 revisioned plan，不写入");
      },
      normalize: ({ actionArguments, command }) => ({
        agentId: actionArguments[0] as string | undefined,
        ...command.opts<AdapterMutationOpts>(),
      }),
      execute: (input, { invocation }) =>
        executeMutation(async () => {
          const agentId = requiredString(input.agentId, "agentId", invocation);
          if (action === "configure") {
            const adapter = parseAdapterPatch(input.adapter, "adapter", invocation);
            const ctx = await resolveContext({}, "required");
            return mutateBuiltinAgent(ctx.env, {
              storeRoot: ctx.storeRoot,
              agentId,
              action,
              adapter,
              dryRun: input.dryRun,
            });
          }
          const ctx = await resolveContext({}, "required");
          return mutateBuiltinAgent(ctx.env, {
            storeRoot: ctx.storeRoot,
            agentId,
            action,
            dryRun: input.dryRun,
          });
        }),
      presentText: presentMutation,
      mapError: () => undefined,
    },
  );
}

export function createCustomAdapterMutationCommandContract<
  TCommand extends "agent.add" | "agent.update" | "agent.remove",
>(definition: CommandContractMetadata<TCommand>, action: CustomAdapterAction) {
  return defineCommandContract<TCommand, AgentMutationInput, PlannedControlPlaneMutationDto>(
    definition,
    {
      createCommand: () => {
        const command = new Command(action)
          .description(
            action === "remove"
              ? "remove a custom adapter when no dependencies remain"
              : `${action} a declarative custom adapter`,
          )
          .argument("[agentId]", "custom adapter id");
        if (action !== "remove") {
          command.option("--adapter <json>", "typed complete custom adapter JSON");
        }
        return command.option("--dry-run", "仅返回 revisioned plan，不写入");
      },
      normalize: ({ actionArguments, command }) => ({
        agentId: actionArguments[0] as string | undefined,
        ...command.opts<AdapterMutationOpts>(),
      }),
      execute: (input, { invocation }) =>
        executeMutation(async () => {
          const agentId = requiredString(input.agentId, "agentId", invocation);
          if (action === "remove") {
            const ctx = await resolveContext({}, "required");
            return mutateCustomAdapter(ctx.env, {
              storeRoot: ctx.storeRoot,
              agentId,
              action,
              dryRun: input.dryRun,
            });
          }
          const adapter = parseAdapterBody(input.adapter, "adapter", invocation);
          const ctx = await resolveContext({}, "required");
          return mutateCustomAdapter(ctx.env, {
            storeRoot: ctx.storeRoot,
            agentId,
            action,
            adapter,
            dryRun: input.dryRun,
          });
        }),
      presentText: presentMutation,
      mapError: () => undefined,
    },
  );
}

export function createConfigMutationCommandContract<
  TCommand extends "config.update" | "config.reset",
>(definition: CommandContractMetadata<TCommand>, action: "update" | "reset") {
  return defineCommandContract<TCommand, SettingsMutationOpts, PlannedControlPlaneMutationDto>(
    definition,
    {
      createCommand: () =>
        action === "update"
          ? new Command("update")
              .description("update typed non-secret settings")
              .option("--settings <json>", "typed settings JSON")
              .option("--dry-run", "仅返回 revisioned plan，不写入")
          : new Command("reset")
              .description("reset typed non-secret settings to packaged defaults")
              .option("--field <names>", "method,secretMode,os；逗号分隔")
              .option("--dry-run", "仅返回 revisioned plan，不写入"),
      normalize: ({ command }) => command.opts<SettingsMutationOpts>(),
      execute: (input, { invocation }) =>
        executeMutation(async () => {
          if (action === "update") {
            const rawSettings = requiredJson(input.settings, "settings", invocation);
            let settings: ReturnType<typeof parseControlPlaneSettingsPatch>;
            try {
              settings = parseControlPlaneSettingsPatch(rawSettings);
            } catch (error) {
              throw invalidTypedInput("settings", error, invocation);
            }
            const ctx = await resolveContext({}, "required");
            return mutateControlPlaneSettings(ctx.env, {
              storeRoot: ctx.storeRoot,
              action,
              settings,
              dryRun: input.dryRun,
            });
          }
          let fields: ReturnType<typeof parseControlPlaneSettingFields>;
          try {
            fields = parseControlPlaneSettingFields(parseList(input.field));
          } catch (error) {
            throw invalidTypedInput("fields", error, invocation);
          }
          const ctx = await resolveContext({}, "required");
          return mutateControlPlaneSettings(ctx.env, {
            storeRoot: ctx.storeRoot,
            action,
            fields,
            dryRun: input.dryRun,
          });
        }),
      presentText: presentMutation,
      mapError: () => undefined,
    },
  );
}

export function createCollectionMutationCommandContract<
  TCommand extends
    | "collection.create"
    | "collection.update"
    | "collection.delete"
    | "collection.members.set"
    | "collection.defaults.set",
>(definition: CommandContractMetadata<TCommand>, action: CollectionAction) {
  return defineCommandContract<TCommand, CollectionMutationInput, PlannedControlPlaneMutationDto>(
    definition,
    {
      createCommand: () => createCollectionMutationLeaf(action),
      normalize: ({ actionArguments, command }) => ({
        ...(action === "set-defaults"
          ? {}
          : { collectionName: actionArguments[0] as string | undefined }),
        ...command.opts<CollectionMutationOpts>(),
      }),
      execute: (input, { invocation }) =>
        executeMutation(async () => {
          if (action === "set-defaults") {
            const collectionNames = requiredList(
              input.collection,
              "collectionNames",
              invocation,
              false,
            );
            const ctx = await resolveContext({}, "required");
            return mutateCollection(ctx.env, {
              storeRoot: ctx.storeRoot,
              action,
              collectionNames,
              dryRun: input.dryRun,
            });
          }
          const collectionName = requiredString(input.collectionName, "collectionName", invocation);
          if (action === "create" || action === "set-members") {
            const resourceIds = requiredList(input.resource, "resourceIds", invocation, true);
            const ctx = await resolveContext({}, "required");
            return mutateCollection(ctx.env, {
              storeRoot: ctx.storeRoot,
              action,
              collectionName,
              ...(action === "create" && input.description !== undefined
                ? { description: input.description }
                : {}),
              resourceIds,
              dryRun: input.dryRun,
            });
          }
          if (action === "update") {
            const description = requiredString(input.description, "description", invocation, true);
            const ctx = await resolveContext({}, "required");
            return mutateCollection(ctx.env, {
              storeRoot: ctx.storeRoot,
              action,
              collectionName,
              description,
              dryRun: input.dryRun,
            });
          }
          const ctx = await resolveContext({}, "required");
          return mutateCollection(ctx.env, {
            storeRoot: ctx.storeRoot,
            action,
            collectionName,
            dryRun: input.dryRun,
          });
        }),
      presentText: presentMutation,
      mapError: () => undefined,
    },
  );
}

export function addCollectionMutationGroups(command: Command): Command {
  return command
    .addCommand(new Command("members").description("manage exact collection membership"))
    .addCommand(new Command("defaults").description("manage default desired collections"));
}

function createCollectionMutationLeaf(action: CollectionAction): Command {
  if (action === "set-defaults") {
    return new Command("set")
      .description("replace default desired collections")
      .option("--collection <names>", "collection names, comma separated")
      .option("--dry-run", "仅返回 revisioned plan，不写入");
  }
  const command = new Command(action === "set-members" ? "set" : action);
  if (action === "create") {
    return command
      .description("create a collection from exact immutable resource IDs")
      .argument("[collectionName]", "collection name")
      .option("--description <text>", "collection description")
      .option("--resource <ids>", "immutable resource IDs, comma separated")
      .option("--dry-run", "仅返回 revisioned plan，不写入");
  }
  if (action === "update") {
    return command
      .description("update collection metadata")
      .argument("[collectionName]", "collection name")
      .option("--description <text>", "replacement collection description")
      .option("--dry-run", "仅返回 revisioned plan，不写入");
  }
  if (action === "set-members") {
    return command
      .description("replace collection members with immutable resource IDs")
      .argument("[collectionName]", "collection name")
      .option("--resource <ids>", "immutable resource IDs, comma separated")
      .option("--dry-run", "仅返回 revisioned plan，不写入");
  }
  return command
    .description("delete an unselected collection")
    .argument("[collectionName]", "collection name")
    .option("--dry-run", "仅返回 revisioned plan，不写入");
}

async function executeMutation(
  run: () => Promise<PlannedControlPlaneMutationDto>,
): Promise<CliCommandOutcome<PlannedControlPlaneMutationDto>> {
  try {
    return commandSuccess(await run());
  } catch (error) {
    if (error instanceof ControlPlaneDependencyError) {
      return commandFailure({
        code: "DOMAIN_VALIDATION_FAILED",
        message: error.message,
        details: error.details,
      });
    }
    if (error instanceof ControlPlaneValidationError) {
      return commandFailure({
        code: "DOMAIN_VALIDATION_FAILED",
        message: error.message,
        details: error.details,
      });
    }
    throw error;
  }
}

function presentMutation(outcome: CliCommandOutcome<PlannedControlPlaneMutationDto>): void {
  if (!outcome.ok) {
    createSafeConsole(outcome.error).error(outcome.error.message);
    return;
  }
  const output = createSafeConsole(outcome.data);
  output.log(`plan ${outcome.data.plan.planId} @ revision ${outcome.data.plan.baseRevision}`);
  output.log(`changed: ${outcome.data.changedFields.join(", ") || "none"}`);
  if (outcome.data.receipt) {
    output.log(
      `operation ${outcome.data.receipt.operationId}, revision ${outcome.data.receipt.resultingRevision}`,
    );
  } else {
    output.log("dry-run: no changes applied");
  }
}

function parseAdapterPatch(
  value: unknown,
  field: string,
  invocation: CliInvocation,
): ReturnType<typeof parseAdapterPatchConfig> {
  const input = requiredJson(value, field, invocation);
  try {
    return parseAdapterPatchConfig(input);
  } catch (error) {
    throw invalidTypedInput(field, error, invocation);
  }
}

function parseAdapterBody(
  value: unknown,
  field: string,
  invocation: CliInvocation,
): ReturnType<typeof parseAdapterBodyConfig> {
  const input = requiredJson(value, field, invocation);
  try {
    return parseAdapterBodyConfig(input);
  } catch (error) {
    throw invalidTypedInput(field, error, invocation);
  }
}

function requiredJson(value: unknown, field: string, invocation: CliInvocation): unknown {
  if (value === undefined) {
    throw new CliInputError(
      "INPUT_REQUIRED",
      `${invocation.command} requires ${field}`,
      { fields: [field] },
      invocation,
    );
  }
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new CliInputError(
      "INVALID_INPUT",
      `${field} must be valid JSON`,
      { fields: [field] },
      invocation,
    );
  }
}

function requiredString(
  value: string | undefined,
  field: string,
  invocation: CliInvocation,
  allowEmpty = false,
): string {
  if (value !== undefined && (allowEmpty || value.length > 0)) return value;
  throw new CliInputError(
    "INPUT_REQUIRED",
    `${invocation.command} requires ${field}`,
    { fields: [field] },
    invocation,
  );
}

function invalidTypedInput(
  field: string,
  error: unknown,
  invocation: CliInvocation,
): CliInputError {
  return new CliInputError(
    "INVALID_INPUT",
    `${field} does not match its typed schema`,
    { fields: [field], issue: error instanceof Error ? error.message : String(error) },
    invocation,
  );
}

function parseList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : String(value).split(",");
  return values
    .map(String)
    .map((item) => item.trim())
    .filter(Boolean);
}

function requiredList(
  value: unknown,
  field: string,
  invocation: CliInvocation,
  allowEmpty: boolean,
): string[] {
  if (value === undefined) {
    throw new CliInputError(
      "INPUT_REQUIRED",
      `${invocation.command} requires ${field}`,
      { fields: [field] },
      invocation,
    );
  }
  const parsed = parseList(value) ?? [];
  if (!allowEmpty && parsed.length === 0) {
    throw new CliInputError(
      "INPUT_REQUIRED",
      `${invocation.command} requires a non-empty ${field}`,
      { fields: [field] },
      invocation,
    );
  }
  return parsed;
}
