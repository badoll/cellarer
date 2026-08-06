import {
  applyResourceBundleImportPlan,
  applyResourceExportPlan,
  applyResourceRemovePlan,
  applyResourceRenamePlan,
  applyResourceUpdatePlan,
  applySyncProfilePlan,
  applySyncProfileUninstallPlan,
  checkResourceUpdate,
  createSyncProfile,
  deleteSyncProfile,
  listSyncProfiles,
  type MutationPlan,
  planAvailableResourceUpdate,
  planResourceBundleImport,
  planResourceExport,
  planResourceRemove,
  planResourceRename,
  planSyncProfile,
  planSyncProfileUninstall,
  resourceDependencyReport,
  type SyncProfileDesiredState,
  showSyncProfile,
  syncProfileDesiredStateSchema,
  updateSyncProfile,
  verifySyncProfile,
} from "@cellarer/core";
import { Command } from "commander";
import { resolveContext } from "../context.js";
import { createSafeConsole } from "../output.js";
import {
  type CliCommandOutcome,
  cliErrorFromOperation,
  commandFailure,
  commandSuccess,
  executeCliCommand,
} from "../protocol/execution.js";
import { CliInputError, type CliInvocation } from "../protocol/input.js";
import { readProtectedPassphraseInput } from "./secret.js";

interface DryRunOpts {
  readonly dryRun?: boolean;
}

interface PlanOpts extends DryRunOpts {
  readonly plan?: unknown;
}

interface ProfileInvocationOpts {
  readonly workspaceRoot?: string;
  readonly replaceUnowned?: string;
  readonly overrideDrift?: string;
  readonly snapshotPassphraseFd?: string;
}

export function addResourceLifecycleCommands(command: Command): Command {
  return command
    .addCommand(resourceDependenciesCommand())
    .addCommand(resourceCheckCommand())
    .addCommand(resourceUpdateCommand())
    .addCommand(resourceRenameCommand())
    .addCommand(resourceRemoveCommand())
    .addCommand(resourceExportCommand())
    .addCommand(resourceImportCommand());
}

export function profileCommand(): Command {
  const root = new Command("profile").description("管理可复用的精确同步 profile");
  root.addCommand(
    new Command("list").description("列出 sync profiles").action(async (_opts, command) => {
      await run(
        command,
        async () => {
          const ctx = await resolveContext({}, "none");
          return { profiles: await listSyncProfiles(ctx.env, { storeRoot: ctx.storeRoot }) };
        },
        (data) => {
          const output = createSafeConsole(data);
          if (data.profiles.length === 0) output.log("暂无 profiles。");
          for (const profile of data.profiles)
            output.log(`${profile.profileId} ${profile.revision}`);
        },
      );
    }),
  );
  root.addCommand(
    new Command("show")
      .description("按 ID 显示 sync profile")
      .argument("[profileId]", "profile ID")
      .action(async (profileId: string | undefined, _opts, command) => {
        await run(
          command,
          async (invocation) => {
            const ctx = await resolveContext({}, "none");
            return showSyncProfile(ctx.env, {
              storeRoot: ctx.storeRoot,
              profileId: required(profileId, "profileId", invocation),
            });
          },
          (data) => {
            const output = createSafeConsole(data);
            if (!data.profile) output.log("未找到 profile。");
            else output.log(`${data.profile.profileId} ${data.profile.revision}`);
          },
        );
      }),
  );
  for (const action of ["create", "update"] as const) {
    root.addCommand(
      new Command(action)
        .description(`${action} a revisioned sync profile`)
        .argument("[profileId]", "profile ID")
        .option("--desired <json>", "精确 desired-state JSON")
        .option("--dry-run", "仅返回 plan，不写入")
        .action(
          async (
            profileId: string | undefined,
            opts: { desired?: unknown; dryRun?: boolean },
            command,
          ) => {
            await run(
              command,
              async (invocation) => {
                const ctx = await resolveContext({}, "required");
                const input = {
                  storeRoot: ctx.storeRoot,
                  profileId: required(profileId, "profileId", invocation),
                  desired: parseDesired(opts.desired, invocation),
                  dryRun: opts.dryRun,
                };
                return action === "create"
                  ? createSyncProfile(ctx.env, input)
                  : updateSyncProfile(ctx.env, input);
              },
              presentPlan,
            );
          },
        ),
    );
  }
  root.addCommand(
    new Command("delete")
      .description("删除未被调用的 sync profile")
      .argument("[profileId]", "profile ID")
      .option("--dry-run", "仅返回 plan，不写入")
      .action(async (profileId: string | undefined, opts: DryRunOpts, command) => {
        await run(
          command,
          async (invocation) => {
            const ctx = await resolveContext({}, "required");
            return deleteSyncProfile(ctx.env, {
              storeRoot: ctx.storeRoot,
              profileId: required(profileId, "profileId", invocation),
              dryRun: opts.dryRun,
            });
          },
          presentPlan,
        );
      }),
  );
  return root;
}

export function syncProfileCommand(): Command {
  const root = new Command("sync").description("按 profile 计划、应用、验证或卸载精确目标");
  root.addCommand(
    addProfileInvocationOptions(
      new Command("plan")
        .description("生成 profile 的 immutable sync plan")
        .argument("[profileId]", "profile ID")
        .option("--snapshot-passphrase-fd <number>", "从继承的文件描述符读取 snapshot 口令"),
    ).action(async (profileId: string | undefined, opts: ProfileInvocationOpts, command) => {
      await run(
        command,
        async (invocation) => {
          const ctx = await resolveContext({}, "required");
          const snapshotPassphrase = await profileSnapshotPassphrase(opts, invocation);
          return planSyncProfile(
            ctx.env,
            invocationOptions(ctx.storeRoot, profileId, opts, invocation, snapshotPassphrase),
          );
        },
        presentPlan,
      );
    }),
  );
  root.addCommand(
    addProfileInvocationOptions(
      new Command("apply")
        .description("应用调用方提供的 immutable profile plan")
        .argument("[profileId]", "profile ID")
        .option("--plan <json>", "sync plan JSON")
        .option("--snapshot-passphrase-fd <number>", "从继承的文件描述符读取 snapshot 口令"),
    ).action(
      async (
        profileId: string | undefined,
        opts: ProfileInvocationOpts & { plan?: unknown },
        command,
      ) => {
        await run(
          command,
          async (invocation) => {
            const ctx = await resolveContext({}, "required");
            const snapshotPassphrase = await profileSnapshotPassphrase(opts, invocation);
            const result = await applySyncProfilePlan(
              ctx.env,
              parsePlan(opts.plan, invocation),
              invocationOptions(ctx.storeRoot, profileId, opts, invocation, snapshotPassphrase),
            );
            return operationOutcome(result, result.operation);
          },
          presentOperation,
        );
      },
    ),
  );
  root.addCommand(
    addProfileInvocationOptions(
      new Command("verify")
        .description("验证 profile desired/applied/disk 状态")
        .argument("[profileId]", "profile ID"),
    ).action(async (profileId: string | undefined, opts: ProfileInvocationOpts, command) => {
      await run(
        command,
        async (invocation) => {
          const ctx = await resolveContext({}, "optional");
          return verifySyncProfile(
            ctx.env,
            invocationOptions(ctx.storeRoot, profileId, opts, invocation),
          );
        },
        (data) =>
          createSafeConsole(data).log(
            `${data.profileId}: ${data.healthy ? "converged" : "diverged"}`,
          ),
      );
    }),
  );
  root.addCommand(
    addProfileInvocationOptions(
      new Command("uninstall")
        .description("计划或卸载 profile 的精确 owned targets")
        .argument("[profileId]", "profile ID")
        .option("--plan <json>", "previously approved uninstall plan JSON")
        .option("--acknowledge <tokens>", "plan-bound drift acknowledgements，逗号分隔")
        .option("--dry-run", "仅返回精确卸载计划"),
    ).action(
      async (
        profileId: string | undefined,
        opts: ProfileInvocationOpts & PlanOpts & { acknowledge?: string },
        command,
      ) => {
        await run(
          command,
          async (invocation) => {
            const ctx = await resolveContext({}, "required");
            const base = invocationOptions(ctx.storeRoot, profileId, opts, invocation);
            const acknowledgements = list(opts.acknowledge);
            const planned = await planSyncProfileUninstall(ctx.env, { ...base, acknowledgements });
            if (opts.dryRun) return planned;
            const result = await applySyncProfileUninstallPlan(
              ctx.env,
              opts.plan === undefined ? planned.mutationPlan : parsePlan(opts.plan, invocation),
              { ...base, targetKeys: planned.targetKeys, acknowledgements },
            );
            return operationOutcome(result, result.operation);
          },
          presentPlan,
        );
      },
    ),
  );
  return root;
}

function resourceDependenciesCommand(): Command {
  return new Command("dependencies")
    .description("报告 exact resource ID 的 collection/profile/selection/target 依赖")
    .argument("[resourceId]", "immutable resource ID")
    .action(async (resourceId: string | undefined, _opts, command) => {
      await run(
        command,
        async (invocation) => {
          const ctx = await resolveContext({}, "none");
          return resourceDependencyReport(ctx.env, {
            storeRoot: ctx.storeRoot,
            resourceId: required(resourceId, "resourceId", invocation),
          });
        },
        (data) =>
          createSafeConsole(data).log(`${data.resourceId}: ${dependencyCount(data)} dependencies`),
      );
    });
}

function resourceCheckCommand(): Command {
  return new Command("check")
    .description("只读检查 resource source evidence")
    .argument("[resourceId]", "immutable resource ID")
    .action(async (resourceId: string | undefined, _opts, command) => {
      await run(
        command,
        async (invocation) => {
          const ctx = await resolveContext({}, "none");
          return checkResourceUpdate(ctx.env, {
            storeRoot: ctx.storeRoot,
            resourceId: required(resourceId, "resourceId", invocation),
          });
        },
        (data) => createSafeConsole(data).log(`${data.resourceId}: ${data.status}`),
      );
    });
}

function resourceUpdateCommand(): Command {
  return new Command("update")
    .description("检查、私有 staging 并计划/应用 store-only resource update")
    .argument("[resourceId]", "immutable resource ID")
    .option("--plan <json>", "previously staged update plan JSON")
    .option("--dry-run", "仅返回 staged candidate 和 plan")
    .action(async (resourceId: string | undefined, opts: PlanOpts, command) => {
      await run(
        command,
        async (invocation) => {
          const ctx = await resolveContext({}, "required");
          required(resourceId, "resourceId", invocation);
          if (opts.plan !== undefined) {
            const result = await applyResourceUpdatePlan(
              ctx.env,
              parsePlan(opts.plan, invocation),
              {
                storeRoot: ctx.storeRoot,
              },
            );
            return operationOutcome(result, result.operation);
          }
          const planned = await planAvailableResourceUpdate(ctx.env, {
            storeRoot: ctx.storeRoot,
            resourceId: resourceId as string,
          });
          if (opts.dryRun) return planned;
          const applied = await applyResourceUpdatePlan(ctx.env, planned.plan, {
            storeRoot: ctx.storeRoot,
          });
          return operationOutcome({ ...planned, ...applied }, applied.operation);
        },
        presentPlan,
      );
    });
}

function resourceRenameCommand(): Command {
  return new Command("rename")
    .description("按 exact ID 计划/应用 metadata rename 或显式 local fork")
    .argument("[resourceId]", "immutable resource ID")
    .argument("[newName]", "new managed name")
    .option("--local-fork", "创建显式 local fork")
    .option("--plan <json>", "approved lifecycle plan JSON")
    .option("--dry-run", "仅返回 plan")
    .action(
      async (
        resourceId: string | undefined,
        newName: string | undefined,
        opts: PlanOpts & { localFork?: boolean },
        command,
      ) => {
        await run(
          command,
          async (invocation) => {
            const ctx = await resolveContext({}, "required");
            const options = {
              storeRoot: ctx.storeRoot,
              resourceId: required(resourceId, "resourceId", invocation),
              newName: required(newName, "newName", invocation),
              mode: opts.localFork ? ("local-fork" as const) : ("rename" as const),
            };
            const planned = await planResourceRename(ctx.env, options);
            if (opts.dryRun) return planned;
            const applied = await applyResourceRenamePlan(
              ctx.env,
              opts.plan === undefined ? planned.plan : parsePlan(opts.plan, invocation),
              { storeRoot: ctx.storeRoot, options },
            );
            return operationOutcome({ ...planned, ...applied }, applied.operation);
          },
          presentPlan,
        );
      },
    );
}

function resourceRemoveCommand(): Command {
  return new Command("remove")
    .description("store-only remove；cascade 必须显式请求且不会卸载 targets")
    .argument("[resourceId]", "immutable resource ID")
    .option("--cascade", "枚举并移除 store dependencies")
    .option("--plan <json>", "approved lifecycle plan JSON")
    .option("--dry-run", "仅返回 plan")
    .action(
      async (resourceId: string | undefined, opts: PlanOpts & { cascade?: boolean }, command) => {
        await run(
          command,
          async (invocation) => {
            const ctx = await resolveContext({}, "required");
            const options = {
              storeRoot: ctx.storeRoot,
              resourceId: required(resourceId, "resourceId", invocation),
              cascade: opts.cascade === true,
            };
            const planned = await planResourceRemove(ctx.env, options);
            if (opts.dryRun) return planned;
            const applied = await applyResourceRemovePlan(
              ctx.env,
              opts.plan === undefined ? planned.plan : parsePlan(opts.plan, invocation),
              { storeRoot: ctx.storeRoot, options },
            );
            return operationOutcome({ ...planned, ...applied }, applied.operation);
          },
          presentPlan,
        );
      },
    );
}

function resourceExportCommand(): Command {
  return bundleMutation("export", async (ctx, options, plan) => {
    const planned = await planResourceExport(ctx.env, options);
    if (!plan.apply) return planned;
    const applied = await applyResourceExportPlan(ctx.env, plan.value ?? planned.plan, {
      storeRoot: ctx.storeRoot,
      options,
    });
    return operationOutcome({ ...planned, ...applied }, applied.operation);
  });
}

function resourceImportCommand(): Command {
  return bundleMutation(
    "import",
    async (ctx, options, plan) => {
      const importOptions = { storeRoot: options.storeRoot, bundlePath: options.bundlePath };
      const planned = await planResourceBundleImport(ctx.env, importOptions);
      if (!plan.apply) return planned;
      const applied = await applyResourceBundleImportPlan(ctx.env, plan.value ?? planned.plan, {
        storeRoot: ctx.storeRoot,
        options: importOptions,
      });
      return operationOutcome({ ...planned, ...applied }, applied.operation);
    },
    false,
  );
}

function bundleMutation(
  name: "export" | "import",
  execute: (
    ctx: Awaited<ReturnType<typeof resolveContext>>,
    options: { storeRoot: string; resourceId: string; bundlePath: string },
    plan: { apply: boolean; value?: MutationPlan },
  ) => Promise<unknown>,
  resourceRequired = true,
): Command {
  const command = new Command(name)
    .description(`${name} a portable reference-only resource bundle`)
    .argument(
      resourceRequired ? "[resourceId]" : "[bundlePath]",
      resourceRequired ? "immutable resource ID" : "bundle path",
    );
  if (resourceRequired) command.argument("[bundlePath]", "bundle path");
  return command
    .option("--plan <json>", "approved bundle plan JSON")
    .option("--dry-run", "仅返回 plan")
    .action(async (...args: unknown[]) => {
      const leaf = args.at(-1) as Command;
      const opts = args.at(-2) as PlanOpts;
      const first = args[0] as string | undefined;
      const second = resourceRequired ? (args[1] as string | undefined) : first;
      await run(
        leaf,
        async (invocation) => {
          const ctx = await resolveContext({}, "required");
          const options = {
            storeRoot: ctx.storeRoot,
            resourceId: resourceRequired
              ? required(first, "resourceId", invocation)
              : "bundle-import",
            bundlePath: required(second, "bundlePath", invocation),
          };
          return execute(ctx, options, {
            apply: !opts.dryRun,
            ...(opts.plan === undefined ? {} : { value: parsePlan(opts.plan, invocation) }),
          });
        },
        presentPlan,
      );
    });
}

function addProfileInvocationOptions(command: Command): Command {
  return command
    .option("--workspace-root <path>", "project profile 的显式 workspace root")
    .option("--replace-unowned <tokens>", "plan-bound replacement acknowledgements，逗号分隔")
    .option("--override-drift <tokens>", "plan-bound drift acknowledgements，逗号分隔");
}

function invocationOptions(
  storeRoot: string,
  profileId: string | undefined,
  opts: ProfileInvocationOpts,
  invocation: CliInvocation,
  snapshotPassphrase?: string,
) {
  return {
    storeRoot,
    profileId: required(profileId, "profileId", invocation),
    workspaceRoot: opts.workspaceRoot,
    replaceUnowned: list(opts.replaceUnowned),
    overrideDrift: list(opts.overrideDrift),
    ...(snapshotPassphrase ? { snapshotPassphrase } : {}),
    secretMode: "env" as const,
  };
}

async function profileSnapshotPassphrase(
  opts: ProfileInvocationOpts,
  invocation: CliInvocation,
): Promise<string | undefined> {
  if (!opts.replaceUnowned && !opts.overrideDrift) return undefined;
  return readProtectedPassphraseInput(opts.snapshotPassphraseFd, undefined, {
    nonInteractive: invocation.nonInteractive,
    invocation,
  });
}

async function run<T>(
  command: Command,
  execute: (invocation: CliInvocation) => Promise<T | CliCommandOutcome<T>>,
  present: (data: T) => void,
): Promise<void> {
  await executeCliCommand<T>(
    command,
    async ({ invocation }) => {
      try {
        const result = await execute(invocation);
        if (isOutcome(result)) return result;
        return commandSuccess(result);
      } catch (error) {
        const code = domainCode(error);
        if (!code) throw error;
        if (code === "WORKSPACE_ROOT_REQUIRED") {
          return commandFailure({
            code: "INPUT_REQUIRED",
            message:
              error instanceof Error
                ? error.message
                : "project-scoped profile requires an explicit workspace root",
            details: { coreCode: code, fields: ["workspaceRoot"] },
          });
        }
        return commandFailure({
          code: "DOMAIN_VALIDATION_FAILED",
          message: error instanceof Error ? error.message : "domain validation failed",
          details: { coreCode: code, ...domainDetails(error) },
        });
      }
    },
    (outcome) => {
      if (!outcome.ok) {
        createSafeConsole(outcome.error).error(outcome.error.message);
        return;
      }
      present(outcome.data);
    },
  );
}

function operationOutcome<T extends object>(
  data: T,
  operation: Parameters<typeof cliErrorFromOperation>[0],
): CliCommandOutcome<T> {
  const error = cliErrorFromOperation(operation);
  return error ? commandFailure(error, data) : commandSuccess(data);
}

function isOutcome<T>(value: T | CliCommandOutcome<T>): value is CliCommandOutcome<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    "warnings" in value &&
    "context" in value
  );
}

function domainCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
  return typeof code === "string" ? code : undefined;
}

function domainDetails(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return {};
  const details = Object.getOwnPropertyDescriptor(error, "details")?.value;
  const findings = Object.getOwnPropertyDescriptor(error, "findings")?.value;
  return {
    ...(typeof details === "object" && details !== null ? { details } : {}),
    ...(Array.isArray(findings) ? { findings } : {}),
  };
}

function parseDesired(value: unknown, invocation: CliInvocation): SyncProfileDesiredState {
  const parsed = parseJson(value, "desired", invocation);
  const result = syncProfileDesiredStateSchema.safeParse(parsed);
  if (result.success) return result.data;
  throw new CliInputError(
    "INVALID_INPUT",
    "desired does not match the sync profile schema",
    { fields: ["desired"], issues: result.error.issues.map((issue) => issue.message) },
    invocation,
  );
}

function parsePlan(value: unknown, invocation: CliInvocation): MutationPlan {
  return parseJson(value, "plan", invocation) as MutationPlan;
}

function parseJson(value: unknown, field: string, invocation: CliInvocation): unknown {
  if (value === undefined)
    throw new CliInputError(
      "INPUT_REQUIRED",
      `${field} is required`,
      { fields: [field] },
      invocation,
    );
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

function required(value: string | undefined, field: string, invocation: CliInvocation): string {
  if (value) return value;
  throw new CliInputError(
    "INPUT_REQUIRED",
    `${field} is required`,
    { fields: [field] },
    invocation,
  );
}

function list(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length === 0 ? undefined : values;
}

function dependencyCount(data: {
  collections: readonly unknown[];
  profiles: readonly unknown[];
  desiredSelections: readonly unknown[];
  ownedTargets: readonly unknown[];
}): number {
  return (
    data.collections.length +
    data.profiles.length +
    data.desiredSelections.length +
    data.ownedTargets.length
  );
}

function presentPlan(data: unknown): void {
  const value = data as {
    plan?: { planId?: string };
    mutationPlan?: { planId?: string };
    blocked?: readonly string[];
    operation?: { ok?: boolean };
  };
  const output = createSafeConsole(data);
  output.log(`plan ${value.plan?.planId ?? value.mutationPlan?.planId ?? "prepared"}`);
  if (value.blocked?.length) output.warn(`blocked: ${value.blocked.join(", ")}`);
  if (value.operation) output.log(value.operation.ok ? "applied" : "not applied");
}

function presentOperation(data: unknown): void {
  const value = data as { operation?: { ok?: boolean } };
  createSafeConsole(data).log(value.operation?.ok ? "applied" : "not applied");
}
