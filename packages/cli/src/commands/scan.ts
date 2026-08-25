import {
  applyScan,
  type ConflictStrategy,
  type PresentedOperationResult,
  type ScanItem,
  type ScanPlan,
  type ScanSelection,
  type SecretMode,
  scanPlan,
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
  commandWarnings,
  publicOperationResult,
} from "../protocol/execution.js";
import {
  assertNonInteractiveMutationInput,
  CliInputError,
  type CliInvocation,
} from "../protocol/input.js";
import { readProtectedPassphraseInput } from "./secret.js";

interface ScanOpts {
  agent?: string;
  dir?: string;
  rules?: boolean;
  mcp?: boolean;
  skills?: boolean;
  intoCollection?: string;
  conflict?: string;
  select?: unknown;
  dryRun?: boolean;
  json?: boolean;
  secretMode?: string;
  vaultPassphraseFd?: string;
  keychainService?: string;
}

const CONFLICTS: ConflictStrategy[] = ["keep-theirs", "keep-mine", "copy"];

interface ScanCommandData {
  readonly plan: ScanPlan;
  readonly imported: readonly ScanItem[];
  readonly operation?: PresentedOperationResult;
}

interface ScanCommandInput {
  readonly opts: ScanOpts;
}

function resolveCaps(opts: ScanOpts): ("rules" | "mcp" | "skills")[] | undefined {
  const caps: ("rules" | "mcp" | "skills")[] = [];
  if (opts.rules) caps.push("rules");
  if (opts.mcp) caps.push("mcp");
  if (opts.skills) caps.push("skills");
  return caps.length > 0 ? caps : undefined; // undefined = 全部
}

// 扫描回写(import):agent/目录现有配置 → 规范化 + 脱敏 → 写库房。
// scan 默认即非交互(无确认提示):用 --dry-run 预览、完整 kind/name/source selector 缩小范围。
export function createScanCommandContract(
  definition: CommandContractMetadata<"scan">,
  resolve: typeof resolveContext = resolveContext,
) {
  const dryRunOutcomes = new WeakSet<object>();
  return defineCommandContract<
    "scan",
    ScanCommandInput,
    ScanCommandData,
    { readonly phase: string; readonly current: number; readonly total: number }
  >(definition, {
    createCommand: () =>
      new Command("scan")
        .description("扫描 agent 现有 rules/mcp/skills 回写库房(密钥自动脱敏为占位符)")
        .option("-a, --agent <id>", "扫描指定 agent")
        .option("--dir <path>", "扫描指定工程目录(project scope)")
        .option("--rules", "仅扫 rules")
        .option("--mcp", "仅扫 mcp")
        .option("--skills", "仅扫 skills")
        .option("--into-collection <collection>", "给导入资源归入 collection")
        .option("--conflict <strategy>", "冲突策略:keep-theirs(默认)| keep-mine | copy")
        .option("--select <json>", "精确 selector JSON 数组：kind/name/source")
        .option("--dry-run", "仅预览发现项,不写库房")
        .option("--secret-mode <mode>", "密钥来源:env(默认)| vault | keychain")
        .option("--vault-passphrase-fd <number>", "从继承的文件描述符读取 vault 口令")
        .option("--keychain-service <name>", "keychain service 名称(默认 cellarer)")
        .option("--json", "JSON 输出(兼容别名;等价 --output json)"),
    normalize: ({ command }) => ({ opts: command.opts<ScanOpts>() }),
    execute: async ({ opts }, execution) => {
      const invocation = execution.invocation;
      const selectItems = parseExactSelections(opts.select, invocation);
      const capabilities = resolveCaps(opts);
      assertNonInteractiveMutationInput(
        "scan",
        {
          agent: opts.agent,
          capabilities,
          dryRun: opts.dryRun,
        },
        invocation,
      );
      const ctx = await resolve(opts, opts.dryRun ? "none" : "required");
      if (ctx.agents.length !== 1) {
        throw new CliInputError(
          "INPUT_REQUIRED",
          "scan requires exactly one agent",
          { fields: ["agent"] },
          invocation,
        );
      }
      if (opts.conflict && !CONFLICTS.includes(opts.conflict as ConflictStrategy)) {
        throw new CliInputError(
          "INVALID_INPUT",
          "Invalid conflict strategy",
          { fields: ["conflict"] },
          invocation,
        );
      }
      const requestedSecretMode = parseSecretMode(opts.secretMode, invocation);
      const secretMode = opts.dryRun ? "env" : requestedSecretMode;
      const vaultPassphrase =
        secretMode === "vault"
          ? await readProtectedPassphraseInput(opts.vaultPassphraseFd, undefined, {
              nonInteractive: invocation.nonInteractive,
              invocation,
            })
          : undefined;
      const scanArgs = {
        storeRoot: ctx.storeRoot,
        agent: ctx.agents[0] as string,
        scope: ctx.scope,
        dir: ctx.dir,
        intoCollection: opts.intoCollection,
        conflict: opts.conflict as ConflictStrategy | undefined,
        capabilities,
        selectItems,
        secretMode,
        vaultPassphrase,
        keychainService: opts.keychainService,
      };

      execution.event("SCAN_STARTED", { phase: "scan", current: 0, total: 1 });
      let data: ScanCommandData;
      let observableContext: unknown;
      if (opts.dryRun) {
        const plan = await scanPlan(ctx.env, scanArgs);
        data = { plan, imported: [] };
        observableContext = plan;
      } else {
        const result = await applyScan(ctx.env, scanArgs);
        data = {
          plan: result.plan,
          imported: result.imported,
          operation: publicOperationResult(result.operation),
        };
        observableContext = result;
      }
      execution.event("SCAN_COMPLETED", { phase: "scan", current: 1, total: 1 });
      const warnings = commandWarnings(data.plan.warnings, "SCAN_WARNING");
      const error =
        !opts.dryRun && data.operation ? cliErrorFromPresentedOperation(data.operation) : undefined;
      const outcome = error
        ? commandFailure(error, data, warnings, observableContext)
        : commandSuccess(data, warnings, observableContext);
      if (opts.dryRun) dryRunOutcomes.add(outcome);
      return outcome;
    },
    presentText: (outcome) => {
      const data = outcome.data;
      if (!data) return;
      printScanText(data, dryRunOutcomes.has(outcome));
    },
    mapError: () => undefined,
  });
}

function parseExactSelections(
  value: unknown,
  invocation: CliInvocation,
): ScanSelection[] | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw ambiguousSelector(invocation);
    }
  }
  if (!Array.isArray(parsed)) throw ambiguousSelector(invocation);
  return parsed.map((selector) => {
    if (selector === null || typeof selector !== "object" || Array.isArray(selector)) {
      throw ambiguousSelector(invocation);
    }
    const record = selector as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (
      keys.join("\0") !== ["kind", "name", "source"].sort().join("\0") ||
      !["rules", "mcp", "skills"].includes(String(record.kind)) ||
      typeof record.name !== "string" ||
      record.name.length === 0 ||
      typeof record.source !== "string" ||
      record.source.length === 0
    ) {
      throw ambiguousSelector(invocation);
    }
    return {
      kind: record.kind as ScanSelection["kind"],
      name: record.name,
      source: record.source,
    };
  });
}

function ambiguousSelector(invocation: CliInvocation): CliInputError {
  return new CliInputError(
    "INVALID_INPUT",
    "mutating scan selection requires complete kind, name, and source selectors",
    { fields: ["select"], reason: "AMBIGUOUS_SELECTOR" },
    invocation,
  );
}

function parseSecretMode(
  value: string | undefined,
  invocation: CliInvocation,
): SecretMode | undefined {
  if (value === undefined) return undefined;
  if (["env", "vault", "keychain"].includes(value)) return value as SecretMode;
  throw new CliInputError(
    "INVALID_INPUT",
    "Invalid --secret-mode; expected env, vault, or keychain",
    { fields: ["secretMode"] },
    invocation,
  );
}

function cliErrorFromPresentedOperation(operation: PresentedOperationResult) {
  return cliErrorFromOperation(operation);
}

function printScanText(data: ScanCommandData, dryRun: boolean): void {
  const output = createSafeConsole(data);
  for (const warning of data.plan.warnings) output.warn(`⚠ ${warning}`);
  if (dryRun) {
    if (data.plan.items.length === 0) {
      output.log("未发现可回写的资源。");
      return;
    }
    output.log("dry-run 发现项:");
    for (const item of data.plan.items) printItem(item, "将", output);
    return;
  }
  if (data.imported.length === 0) {
    output.log("无新资源入库(检查冲突策略与 --select)。");
    return;
  }
  for (const item of data.imported) printItem(item, "已", output);
  const refs = data.imported.flatMap((item) => item.secretRefs ?? []);
  if (refs.length > 0) {
    output.log(`\n🔑 检测到密钥引用(真值未入库):${[...new Set(refs)].join(", ")}`);
    output.log("   用 cellarer secret add <name> --stdin 存入 vault。");
  }
}

function printItem(
  it: ScanItem,
  verb: string,
  output: Pick<Console, "log" | "warn" | "error">,
): void {
  const tag = it.status === "conflict" ? " [冲突]" : "";
  const refs = it.secretRefs && it.secretRefs.length > 0 ? ` 🔑[${it.secretRefs.join(",")}]` : "";
  output.log(`  ${verb}导入 ${it.kind}/${it.name}${tag}${refs}  ← ${it.source}`);
}
