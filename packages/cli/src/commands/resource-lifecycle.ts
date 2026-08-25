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
  type CommandContractMetadata,
  defineCommandContract,
} from "../protocol/command-contract.js";
import {
  type CliCommandOutcome,
  cliErrorFromOperation,
  commandFailure,
  commandSuccess,
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

interface ResourceLifecycleInput extends PlanOpts {
  readonly resourceId?: string;
  readonly newName?: string;
  readonly localFork?: boolean;
  readonly cascade?: boolean;
  readonly bundlePath?: string;
}

interface ProfileInput extends DryRunOpts {
  readonly profileId?: string;
  readonly desired?: unknown;
}

interface SyncInput extends ProfileInvocationOpts, PlanOpts {
  readonly profileId?: string;
  readonly acknowledge?: string;
}

type ResourceLifecycleCommand =
  | "resource.dependencies"
  | "resource.check"
  | "resource.update"
  | "resource.rename"
  | "resource.remove"
  | "resource.export"
  | "resource.import";
type ResourceLifecycleAction = ResourceLifecycleCommand extends `resource.${infer TAction}`
  ? TAction
  : never;
type ProfileCommand =
  | "profile.list"
  | "profile.show"
  | "profile.create"
  | "profile.update"
  | "profile.delete";
type ProfileAction = ProfileCommand extends `profile.${infer TAction}` ? TAction : never;
type SyncCommand = "sync.plan" | "sync.apply" | "sync.verify" | "sync.uninstall";
type SyncAction = SyncCommand extends `sync.${infer TAction}` ? TAction : never;

export function profileCommandRoot(): Command {
  return new Command("profile").description("管理可复用的精确同步 profile");
}

export function syncProfileCommandRoot(): Command {
  return new Command("sync").description("按 profile 计划、应用、验证或卸载精确目标");
}

export function createResourceLifecycleCommandContract<TCommand extends ResourceLifecycleCommand>(
  definition: CommandContractMetadata<TCommand>,
  action: ResourceLifecycleAction,
) {
  return defineCommandContract<TCommand, ResourceLifecycleInput, unknown>(definition, {
    createCommand: () => createResourceLifecycleLeaf(action),
    normalize: ({ actionArguments, command }) => {
      const opts = command.opts<PlanOpts & { localFork?: boolean; cascade?: boolean }>();
      return {
        ...(action === "import"
          ? { bundlePath: actionArguments[0] as string | undefined }
          : { resourceId: actionArguments[0] as string | undefined }),
        ...(action === "rename" ? { newName: actionArguments[1] as string | undefined } : {}),
        ...(action === "export" ? { bundlePath: actionArguments[1] as string | undefined } : {}),
        ...opts,
      };
    },
    execute: (input, { invocation }) =>
      executeDomain(() => executeResourceLifecycle(action, input, invocation)),
    presentText: (outcome) => presentOutcome(outcome, presentResourceLifecycle(action)),
    mapError: () => undefined,
  });
}

export function createProfileCommandContract<TCommand extends ProfileCommand>(
  definition: CommandContractMetadata<TCommand>,
  action: ProfileAction,
) {
  return defineCommandContract<TCommand, ProfileInput, unknown>(definition, {
    createCommand: () => createProfileLeaf(action),
    normalize: ({ actionArguments, command }) => ({
      ...(action === "list" ? {} : { profileId: actionArguments[0] as string | undefined }),
      ...command.opts<{ desired?: unknown; dryRun?: boolean }>(),
    }),
    execute: (input, { invocation }) =>
      executeDomain(() => executeProfile(action, input, invocation)),
    presentText: (outcome) => presentOutcome(outcome, presentProfile(action)),
    mapError: () => undefined,
  });
}

export function createSyncCommandContract<TCommand extends SyncCommand>(
  definition: CommandContractMetadata<TCommand>,
  action: SyncAction,
) {
  return defineCommandContract<TCommand, SyncInput, unknown>(definition, {
    createCommand: () => createSyncLeaf(action),
    normalize: ({ actionArguments, command }) => ({
      profileId: actionArguments[0] as string | undefined,
      ...command.opts<ProfileInvocationOpts & PlanOpts & { acknowledge?: string }>(),
    }),
    execute: (input, { invocation }) => executeDomain(() => executeSync(action, input, invocation)),
    presentText: (outcome) => presentOutcome(outcome, presentSync(action)),
    mapError: () => undefined,
  });
}

function createResourceLifecycleLeaf(action: ResourceLifecycleAction): Command {
  if (action === "dependencies") {
    return new Command("dependencies")
      .description("报告 exact resource ID 的 collection/profile/selection/target 依赖")
      .argument("[resourceId]", "immutable resource ID");
  }
  if (action === "check") {
    return new Command("check")
      .description("只读检查 resource source evidence")
      .argument("[resourceId]", "immutable resource ID");
  }
  if (action === "update") {
    return new Command("update")
      .description("检查、私有 staging 并计划/应用 store-only resource update")
      .argument("[resourceId]", "immutable resource ID")
      .option("--plan <json>", "previously staged update plan JSON")
      .option("--dry-run", "仅返回 staged candidate 和 plan");
  }
  if (action === "rename") {
    return new Command("rename")
      .description("按 exact ID 计划/应用 metadata rename 或显式 local fork")
      .argument("[resourceId]", "immutable resource ID")
      .argument("[newName]", "new managed name")
      .option("--local-fork", "创建显式 local fork")
      .option("--plan <json>", "approved lifecycle plan JSON")
      .option("--dry-run", "仅返回 plan");
  }
  if (action === "remove") {
    return new Command("remove")
      .description("store-only remove；cascade 必须显式请求且不会卸载 targets")
      .argument("[resourceId]", "immutable resource ID")
      .option("--cascade", "枚举并移除 store dependencies")
      .option("--plan <json>", "approved lifecycle plan JSON")
      .option("--dry-run", "仅返回 plan");
  }
  const resourceRequired = action === "export";
  const command = new Command(action)
    .description(`${action} a portable reference-only resource bundle`)
    .argument(
      resourceRequired ? "[resourceId]" : "[bundlePath]",
      resourceRequired ? "immutable resource ID" : "bundle path",
    );
  if (resourceRequired) command.argument("[bundlePath]", "bundle path");
  return command
    .option("--plan <json>", "approved bundle plan JSON")
    .option("--dry-run", "仅返回 plan");
}

function createProfileLeaf(action: ProfileAction): Command {
  if (action === "list") return new Command("list").description("列出 sync profiles");
  const command = new Command(action)
    .description(
      action === "show"
        ? "按 ID 显示 sync profile"
        : action === "delete"
          ? "删除未被调用的 sync profile"
          : `${action} a revisioned sync profile`,
    )
    .argument("[profileId]", "profile ID");
  if (action === "create" || action === "update") {
    command.option("--desired <json>", "精确 desired-state JSON");
  }
  if (action === "create" || action === "update" || action === "delete") {
    command.option("--dry-run", "仅返回 plan，不写入");
  }
  return command;
}

function createSyncLeaf(action: SyncAction): Command {
  if (action === "plan") {
    return addProfileInvocationOptions(
      new Command("plan")
        .description("生成 profile 的 immutable sync plan")
        .argument("[profileId]", "profile ID")
        .option("--snapshot-passphrase-fd <number>", "从继承的文件描述符读取 snapshot 口令"),
    );
  }
  if (action === "apply") {
    return addProfileInvocationOptions(
      new Command("apply")
        .description("应用调用方提供的 immutable profile plan")
        .argument("[profileId]", "profile ID")
        .option("--plan <json>", "sync plan JSON")
        .option("--snapshot-passphrase-fd <number>", "从继承的文件描述符读取 snapshot 口令"),
    );
  }
  if (action === "verify") {
    return addProfileInvocationOptions(
      new Command("verify")
        .description("验证 profile desired/applied/disk 状态")
        .argument("[profileId]", "profile ID"),
    );
  }
  return addProfileInvocationOptions(
    new Command("uninstall")
      .description("计划或卸载 profile 的精确 owned targets")
      .argument("[profileId]", "profile ID")
      .option("--plan <json>", "previously approved uninstall plan JSON")
      .option("--acknowledge <tokens>", "plan-bound drift acknowledgements，逗号分隔")
      .option("--dry-run", "仅返回精确卸载计划"),
  );
}

async function executeResourceLifecycle(
  action: ResourceLifecycleAction,
  input: ResourceLifecycleInput,
  invocation: CliInvocation,
): Promise<unknown | CliCommandOutcome<unknown>> {
  if (action === "dependencies" || action === "check") {
    const ctx = await resolveContext({}, "none");
    const options = {
      storeRoot: ctx.storeRoot,
      resourceId: required(input.resourceId, "resourceId", invocation),
    };
    return action === "dependencies"
      ? resourceDependencyReport(ctx.env, options)
      : checkResourceUpdate(ctx.env, options);
  }
  const ctx = await resolveContext({}, "required");
  if (action === "update") {
    const resourceId = required(input.resourceId, "resourceId", invocation);
    if (input.plan !== undefined) {
      const result = await applyResourceUpdatePlan(ctx.env, parsePlan(input.plan, invocation), {
        storeRoot: ctx.storeRoot,
      });
      return operationOutcome(result, result.operation);
    }
    const planned = await planAvailableResourceUpdate(ctx.env, {
      storeRoot: ctx.storeRoot,
      resourceId,
    });
    if (input.dryRun) return planned;
    const applied = await applyResourceUpdatePlan(ctx.env, planned.plan, {
      storeRoot: ctx.storeRoot,
    });
    return operationOutcome({ ...planned, ...applied }, applied.operation);
  }
  if (action === "rename") {
    const options = {
      storeRoot: ctx.storeRoot,
      resourceId: required(input.resourceId, "resourceId", invocation),
      newName: required(input.newName, "newName", invocation),
      mode: input.localFork ? ("local-fork" as const) : ("rename" as const),
    };
    const planned = await planResourceRename(ctx.env, options);
    if (input.dryRun) return planned;
    const applied = await applyResourceRenamePlan(
      ctx.env,
      input.plan === undefined ? planned.plan : parsePlan(input.plan, invocation),
      { storeRoot: ctx.storeRoot, options },
    );
    return operationOutcome({ ...planned, ...applied }, applied.operation);
  }
  if (action === "remove") {
    const options = {
      storeRoot: ctx.storeRoot,
      resourceId: required(input.resourceId, "resourceId", invocation),
      cascade: input.cascade === true,
    };
    const planned = await planResourceRemove(ctx.env, options);
    if (input.dryRun) return planned;
    const applied = await applyResourceRemovePlan(
      ctx.env,
      input.plan === undefined ? planned.plan : parsePlan(input.plan, invocation),
      { storeRoot: ctx.storeRoot, options },
    );
    return operationOutcome({ ...planned, ...applied }, applied.operation);
  }
  const options = {
    storeRoot: ctx.storeRoot,
    resourceId:
      action === "export" ? required(input.resourceId, "resourceId", invocation) : "bundle-import",
    bundlePath: required(input.bundlePath, "bundlePath", invocation),
  };
  const suppliedPlan = input.plan === undefined ? undefined : parsePlan(input.plan, invocation);
  if (action === "export") {
    const planned = await planResourceExport(ctx.env, options);
    if (input.dryRun) return planned;
    const applied = await applyResourceExportPlan(ctx.env, suppliedPlan ?? planned.plan, {
      storeRoot: ctx.storeRoot,
      options,
    });
    return operationOutcome({ ...planned, ...applied }, applied.operation);
  }
  const importOptions = { storeRoot: options.storeRoot, bundlePath: options.bundlePath };
  const planned = await planResourceBundleImport(ctx.env, importOptions);
  if (input.dryRun) return planned;
  const applied = await applyResourceBundleImportPlan(ctx.env, suppliedPlan ?? planned.plan, {
    storeRoot: ctx.storeRoot,
    options: importOptions,
  });
  return operationOutcome({ ...planned, ...applied }, applied.operation);
}

async function executeProfile(
  action: ProfileAction,
  input: ProfileInput,
  invocation: CliInvocation,
): Promise<unknown> {
  if (action === "list") {
    const ctx = await resolveContext({}, "none");
    return { profiles: await listSyncProfiles(ctx.env, { storeRoot: ctx.storeRoot }) };
  }
  if (action === "show") {
    const ctx = await resolveContext({}, "none");
    return showSyncProfile(ctx.env, {
      storeRoot: ctx.storeRoot,
      profileId: required(input.profileId, "profileId", invocation),
    });
  }
  const ctx = await resolveContext({}, "required");
  const profileId = required(input.profileId, "profileId", invocation);
  if (action === "delete") {
    return deleteSyncProfile(ctx.env, {
      storeRoot: ctx.storeRoot,
      profileId,
      dryRun: input.dryRun,
    });
  }
  const options = {
    storeRoot: ctx.storeRoot,
    profileId,
    desired: parseDesired(input.desired, invocation),
    dryRun: input.dryRun,
  };
  return action === "create"
    ? createSyncProfile(ctx.env, options)
    : updateSyncProfile(ctx.env, options);
}

async function executeSync(
  action: SyncAction,
  input: SyncInput,
  invocation: CliInvocation,
): Promise<unknown | CliCommandOutcome<unknown>> {
  const ctx = await resolveContext({}, action === "verify" ? "optional" : "required");
  if (action === "plan") {
    const snapshotPassphrase = await profileSnapshotPassphrase(input, invocation);
    return planSyncProfile(
      ctx.env,
      invocationOptions(ctx.storeRoot, input.profileId, input, invocation, snapshotPassphrase),
    );
  }
  if (action === "apply") {
    const snapshotPassphrase = await profileSnapshotPassphrase(input, invocation);
    const result = await applySyncProfilePlan(
      ctx.env,
      parsePlan(input.plan, invocation),
      invocationOptions(ctx.storeRoot, input.profileId, input, invocation, snapshotPassphrase),
    );
    return operationOutcome(result, result.operation);
  }
  if (action === "verify") {
    return verifySyncProfile(
      ctx.env,
      invocationOptions(ctx.storeRoot, input.profileId, input, invocation),
    );
  }
  const base = invocationOptions(ctx.storeRoot, input.profileId, input, invocation);
  const acknowledgements = list(input.acknowledge);
  const planned = await planSyncProfileUninstall(ctx.env, { ...base, acknowledgements });
  if (input.dryRun) return planned;
  const result = await applySyncProfileUninstallPlan(
    ctx.env,
    input.plan === undefined ? planned.mutationPlan : parsePlan(input.plan, invocation),
    { ...base, targetKeys: planned.targetKeys, acknowledgements },
  );
  return operationOutcome(result, result.operation);
}

function presentResourceLifecycle(action: ResourceLifecycleAction): (data: unknown) => void {
  if (action === "dependencies") {
    return (data) => {
      const value = data as Parameters<typeof dependencyCount>[0] & { resourceId: string };
      createSafeConsole(data).log(`${value.resourceId}: ${dependencyCount(value)} dependencies`);
    };
  }
  if (action === "check") {
    return (data) => {
      const value = data as { resourceId: string; status: string };
      createSafeConsole(data).log(`${value.resourceId}: ${value.status}`);
    };
  }
  return presentPlan;
}

function presentProfile(action: ProfileAction): (data: unknown) => void {
  if (action === "list") {
    return (data) => {
      const value = data as { profiles: readonly { profileId: string; revision: string }[] };
      const output = createSafeConsole(data);
      if (value.profiles.length === 0) output.log("暂无 profiles。");
      for (const profile of value.profiles) output.log(`${profile.profileId} ${profile.revision}`);
    };
  }
  if (action === "show") {
    return (data) => {
      const value = data as { profile?: { profileId: string; revision: string } };
      const output = createSafeConsole(data);
      if (!value.profile) output.log("未找到 profile。");
      else output.log(`${value.profile.profileId} ${value.profile.revision}`);
    };
  }
  return presentPlan;
}

function presentSync(action: SyncAction): (data: unknown) => void {
  if (action === "apply") return presentOperation;
  if (action === "verify") {
    return (data) => {
      const value = data as { profileId: string; healthy: boolean };
      createSafeConsole(data).log(
        `${value.profileId}: ${value.healthy ? "converged" : "diverged"}`,
      );
    };
  }
  return presentPlan;
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

async function executeDomain<T>(
  execute: () => Promise<T | CliCommandOutcome<T>>,
): Promise<CliCommandOutcome<T>> {
  try {
    const result = await execute();
    return isOutcome(result) ? result : commandSuccess(result);
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
}

function presentOutcome(
  outcome: CliCommandOutcome<unknown>,
  present: (data: unknown) => void,
): void {
  if (!outcome.ok) {
    createSafeConsole(outcome.error).error(outcome.error.message);
    return;
  }
  present(outcome.data);
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
