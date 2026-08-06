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
  type CliCommandOutcome,
  commandFailure,
  commandSuccess,
  executeCliCommand,
} from "../protocol/execution.js";
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

export function addAgentMutationCommands(command: Command): Command {
  for (const action of ["enable", "disable", "reset"] as const) {
    const builtInOnly = action === "reset";
    command.addCommand(
      new Command(action)
        .description(
          builtInOnly
            ? "reset a built-in adapter override"
            : `${action} an agent through a planned adapter override`,
        )
        .argument("[agentId]", builtInOnly ? "built-in adapter id" : "adapter id")
        .option("--dry-run", "仅返回 revisioned plan，不写入")
        .action(async (agentId: string | undefined, opts: MutationOpts, leaf: Command) => {
          await runMutation(leaf, async (invocation) => {
            const exactAgentId = requiredString(agentId, "agentId", invocation);
            const ctx = await resolveContext({}, "required");
            return mutateBuiltinAgent(ctx.env, {
              storeRoot: ctx.storeRoot,
              agentId: exactAgentId,
              action,
              dryRun: opts.dryRun,
            });
          });
        }),
    );
  }

  command.addCommand(
    new Command("configure")
      .description("configure a built-in adapter override")
      .argument("[agentId]", "built-in adapter id")
      .option("--adapter <json>", "typed adapter override JSON")
      .option("--dry-run", "仅返回 revisioned plan，不写入")
      .action(async (agentId: string | undefined, opts: AdapterMutationOpts, leaf: Command) => {
        await runMutation(leaf, async (invocation) => {
          const exactAgentId = requiredString(agentId, "agentId", invocation);
          const adapter = parseAdapterPatch(opts.adapter, "adapter", invocation);
          const ctx = await resolveContext({}, "required");
          return mutateBuiltinAgent(ctx.env, {
            storeRoot: ctx.storeRoot,
            agentId: exactAgentId,
            action: "configure",
            adapter,
            dryRun: opts.dryRun,
          });
        });
      }),
  );

  for (const action of ["add", "update"] as const) {
    command.addCommand(
      new Command(action)
        .description(`${action} a declarative custom adapter`)
        .argument("[agentId]", "custom adapter id")
        .option("--adapter <json>", "typed complete custom adapter JSON")
        .option("--dry-run", "仅返回 revisioned plan，不写入")
        .action(async (agentId: string | undefined, opts: AdapterMutationOpts, leaf: Command) => {
          await runMutation(leaf, async (invocation) => {
            const exactAgentId = requiredString(agentId, "agentId", invocation);
            const adapter = parseAdapterBody(opts.adapter, "adapter", invocation);
            const ctx = await resolveContext({}, "required");
            return mutateCustomAdapter(ctx.env, {
              storeRoot: ctx.storeRoot,
              agentId: exactAgentId,
              action,
              adapter,
              dryRun: opts.dryRun,
            });
          });
        }),
    );
  }

  command.addCommand(
    new Command("remove")
      .description("remove a custom adapter when no dependencies remain")
      .argument("[agentId]", "custom adapter id")
      .option("--dry-run", "仅返回 revisioned plan，不写入")
      .action(async (agentId: string | undefined, opts: MutationOpts, leaf: Command) => {
        await runMutation(leaf, async (invocation) => {
          const exactAgentId = requiredString(agentId, "agentId", invocation);
          const ctx = await resolveContext({}, "required");
          return mutateCustomAdapter(ctx.env, {
            storeRoot: ctx.storeRoot,
            agentId: exactAgentId,
            action: "remove",
            dryRun: opts.dryRun,
          });
        });
      }),
  );
  return command;
}

export function addConfigMutationCommands(command: Command): Command {
  command.addCommand(
    new Command("update")
      .description("update typed non-secret settings")
      .option("--settings <json>", "typed settings JSON")
      .option("--dry-run", "仅返回 revisioned plan，不写入")
      .action(async (opts: SettingsMutationOpts, leaf: Command) => {
        await runMutation(leaf, async (invocation) => {
          const input = requiredJson(opts.settings, "settings", invocation);
          let settings: ReturnType<typeof parseControlPlaneSettingsPatch>;
          try {
            settings = parseControlPlaneSettingsPatch(input);
          } catch (error) {
            throw invalidTypedInput("settings", error, invocation);
          }
          const ctx = await resolveContext({}, "required");
          return mutateControlPlaneSettings(ctx.env, {
            storeRoot: ctx.storeRoot,
            action: "update",
            settings,
            dryRun: opts.dryRun,
          });
        });
      }),
  );

  command.addCommand(
    new Command("reset")
      .description("reset typed non-secret settings to packaged defaults")
      .option("--field <names>", "method,secretMode,os；逗号分隔")
      .option("--dry-run", "仅返回 revisioned plan，不写入")
      .action(async (opts: SettingsMutationOpts, leaf: Command) => {
        await runMutation(leaf, async (invocation) => {
          let fields: ReturnType<typeof parseControlPlaneSettingFields>;
          try {
            fields = parseControlPlaneSettingFields(parseList(opts.field));
          } catch (error) {
            throw invalidTypedInput("fields", error, invocation);
          }
          const ctx = await resolveContext({}, "required");
          return mutateControlPlaneSettings(ctx.env, {
            storeRoot: ctx.storeRoot,
            action: "reset",
            fields,
            dryRun: opts.dryRun,
          });
        });
      }),
  );
  return command;
}

export function addCollectionMutationCommands(command: Command): Command {
  command.addCommand(
    new Command("create")
      .description("create a collection from exact immutable resource IDs")
      .argument("[collectionName]", "collection name")
      .option("--description <text>", "collection description")
      .option("--resource <ids>", "immutable resource IDs, comma separated")
      .option("--dry-run", "仅返回 revisioned plan，不写入")
      .action(
        async (collectionName: string | undefined, opts: CollectionMutationOpts, leaf: Command) => {
          await runMutation(leaf, async (invocation) => {
            const exactCollectionName = requiredString(
              collectionName,
              "collectionName",
              invocation,
            );
            const resourceIds = requiredList(opts.resource, "resourceIds", invocation, true);
            const ctx = await resolveContext({}, "required");
            return mutateCollection(ctx.env, {
              storeRoot: ctx.storeRoot,
              action: "create",
              collectionName: exactCollectionName,
              ...(opts.description === undefined ? {} : { description: opts.description }),
              resourceIds,
              dryRun: opts.dryRun,
            });
          });
        },
      ),
  );

  command.addCommand(
    new Command("update")
      .description("update collection metadata")
      .argument("[collectionName]", "collection name")
      .option("--description <text>", "replacement collection description")
      .option("--dry-run", "仅返回 revisioned plan，不写入")
      .action(
        async (collectionName: string | undefined, opts: CollectionMutationOpts, leaf: Command) => {
          await runMutation(leaf, async (invocation) => {
            const exactCollectionName = requiredString(
              collectionName,
              "collectionName",
              invocation,
            );
            const description = requiredString(opts.description, "description", invocation, true);
            const ctx = await resolveContext({}, "required");
            return mutateCollection(ctx.env, {
              storeRoot: ctx.storeRoot,
              action: "update",
              collectionName: exactCollectionName,
              description,
              dryRun: opts.dryRun,
            });
          });
        },
      ),
  );

  command.addCommand(
    new Command("delete")
      .description("delete an unselected collection")
      .argument("[collectionName]", "collection name")
      .option("--dry-run", "仅返回 revisioned plan，不写入")
      .action(async (collectionName: string | undefined, opts: MutationOpts, leaf: Command) => {
        await runMutation(leaf, async (invocation) => {
          const exactCollectionName = requiredString(collectionName, "collectionName", invocation);
          const ctx = await resolveContext({}, "required");
          return mutateCollection(ctx.env, {
            storeRoot: ctx.storeRoot,
            action: "delete",
            collectionName: exactCollectionName,
            dryRun: opts.dryRun,
          });
        });
      }),
  );

  command.addCommand(
    new Command("members").description("manage exact collection membership").addCommand(
      new Command("set")
        .description("replace collection members with immutable resource IDs")
        .argument("[collectionName]", "collection name")
        .option("--resource <ids>", "immutable resource IDs, comma separated")
        .option("--dry-run", "仅返回 revisioned plan，不写入")
        .action(
          async (
            collectionName: string | undefined,
            opts: CollectionMutationOpts,
            leaf: Command,
          ) => {
            await runMutation(leaf, async (invocation) => {
              const exactCollectionName = requiredString(
                collectionName,
                "collectionName",
                invocation,
              );
              const resourceIds = requiredList(opts.resource, "resourceIds", invocation, true);
              const ctx = await resolveContext({}, "required");
              return mutateCollection(ctx.env, {
                storeRoot: ctx.storeRoot,
                action: "set-members",
                collectionName: exactCollectionName,
                resourceIds,
                dryRun: opts.dryRun,
              });
            });
          },
        ),
    ),
  );

  command.addCommand(
    new Command("defaults").description("manage default desired collections").addCommand(
      new Command("set")
        .description("replace default desired collections")
        .option("--collection <names>", "collection names, comma separated")
        .option("--dry-run", "仅返回 revisioned plan，不写入")
        .action(async (opts: CollectionMutationOpts, leaf: Command) => {
          await runMutation(leaf, async (invocation) => {
            const collectionNames = requiredList(
              opts.collection,
              "collectionNames",
              invocation,
              false,
            );
            const ctx = await resolveContext({}, "required");
            return mutateCollection(ctx.env, {
              storeRoot: ctx.storeRoot,
              action: "set-defaults",
              collectionNames,
              dryRun: opts.dryRun,
            });
          });
        }),
    ),
  );
  return command;
}

async function runMutation(
  command: Command,
  run: (invocation: CliInvocation) => Promise<PlannedControlPlaneMutationDto>,
): Promise<void> {
  await executeCliCommand(
    command,
    async ({ invocation }): Promise<CliCommandOutcome<PlannedControlPlaneMutationDto>> => {
      try {
        return commandSuccess(await run(invocation));
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
    },
    (outcome) => presentMutation(outcome),
  );
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
