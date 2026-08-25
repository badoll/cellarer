import { readFileSync } from "node:fs";
import type { CliCommandRequest, CliError, CliErrorCode, MutationPlan } from "@cellarer/core";
import type { Command } from "commander";
import type { CommandCatalog } from "./command-contract.js";
import type { CommandDefinition } from "./command-types.js";
import type { JsonSchema } from "./schemas.js";

export type CliOutput = "text" | "json" | "jsonl";

export interface CliInvocation {
  readonly command: string;
  readonly output: CliOutput;
  readonly nonInteractive: boolean;
  readonly inputSource?: string;
  readonly requestId?: string;
}

export interface CliInputBoundaryIo {
  readonly stdinIsTTY: boolean;
  readonly readInput: (source: string) => Promise<string>;
}

export interface NonInteractiveMutationInput {
  readonly agents?: readonly string[];
  readonly agent?: string;
  readonly capabilities?: readonly string[];
  readonly dir?: string;
  readonly all?: boolean;
  readonly dryRun?: boolean;
}

export class CliInputError extends Error {
  readonly cliError: CliError;
  readonly invocation?: CliInvocation;

  constructor(
    code: Extract<
      CliErrorCode,
      | "INVALID_USAGE"
      | "INVALID_INPUT"
      | "INPUT_REQUIRED"
      | "INPUT_AMBIGUITY"
      | "DOMAIN_VALIDATION_FAILED"
    >,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    invocation?: CliInvocation,
  ) {
    super(message);
    this.name = "CliInputError";
    this.cliError = { code, message, ...(details ? { details } : {}) };
    this.invocation = invocation;
  }
}

const invocations = new WeakMap<Command, CliInvocation>();

export function installCliInputBoundary(
  program: Command,
  io: CliInputBoundaryIo | undefined,
  catalog: CommandCatalog,
): void {
  io ??= defaultInputIo();
  program
    .option("--output <format>", "输出格式:text | json | jsonl")
    .option("--non-interactive", "禁止交互提示;缺少必需输入时失败")
    .option("--input <path|->", "从 JSON 文件或标准输入读取结构化命令请求");

  program.hook("preAction", async (_rootCommand, actionCommand) => {
    const command = commandIdentity(actionCommand);
    const globals = program.opts<{
      output?: string;
      nonInteractive?: boolean;
      input?: string;
    }>();
    const explicitOutput = program.getOptionValueSource("output") === "cli";
    const legacyJson = actionCommand.getOptionValueSource("json") === "cli";
    const output = explicitOutput
      ? parseOutput(globals.output, command)
      : legacyJson
        ? "json"
        : "text";
    const inputSource = globals.input;
    let invocation: CliInvocation = {
      command,
      output,
      nonInteractive:
        globals.nonInteractive === true ||
        output !== "text" ||
        inputSource !== undefined ||
        !io.stdinIsTTY,
      ...(inputSource === undefined ? {} : { inputSource }),
    };
    invocations.set(actionCommand, invocation);

    // Until command rendering is migrated, keep existing --json branches aligned with the
    // explicit global transport selection. The shared renderer consumes the same invocation.
    if (actionCommand.options.some((option) => option.long === "--json") && explicitOutput) {
      actionCommand.setOptionValueWithSource("json", output !== "text", "implied");
    }

    if (inputSource === undefined) return;
    const matched = catalog.resolveExecutableMatch(catalog.matchExecutable(command));
    if (matched.kind !== "known") {
      throw new TypeError(
        `known executable command ${command} is absent from the active command composition`,
      );
    }
    const definition = matched.definition;
    const request = await readAndValidateRequest(inputSource, command, io, invocation, definition);
    invocation = {
      ...invocation,
      ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
    };
    invocations.set(actionCommand, invocation);
    applyStructuredInput(actionCommand, command, request.input, invocation, definition);
  });
}

export function getCliInvocation(command: Command): CliInvocation {
  const prepared = invocations.get(command);
  if (prepared) return prepared;
  return {
    command: commandIdentity(command),
    output: command.getOptionValueSource("json") === "cli" ? "json" : "text",
    nonInteractive: process.stdin.isTTY !== true,
  };
}

export function assertNonInteractiveMutationInput(
  command: "apply" | "scan" | "revert",
  input: NonInteractiveMutationInput,
  invocation: Pick<CliInvocation, "output" | "nonInteractive">,
): void {
  if (!invocation.nonInteractive) return;

  const missing: string[] = [];
  if (command === "apply") {
    if (!input.agents || input.agents.length === 0) missing.push("agents");
    if (!input.dryRun && (!input.capabilities || input.capabilities.length === 0)) {
      missing.push("capabilities");
    }
  } else if (command === "scan") {
    if (!input.agent) missing.push("agent");
    if (!input.dryRun && (!input.capabilities || input.capabilities.length === 0)) {
      missing.push("capabilities");
    }
  } else if (
    !input.dryRun &&
    !input.all &&
    !input.dir &&
    (!input.agents || input.agents.length === 0)
  ) {
    missing.push("agents|dir|all");
  }

  if (missing.length > 0) {
    throw new CliInputError(
      "INPUT_REQUIRED",
      "Non-interactive mutation requires explicit selection input",
      { fields: missing },
      "command" in invocation ? (invocation as CliInvocation) : undefined,
    );
  }
}

async function readAndValidateRequest(
  source: string,
  command: string,
  io: CliInputBoundaryIo,
  invocation: CliInvocation,
  definition: CommandDefinition,
): Promise<CliCommandRequest<Record<string, unknown>>> {
  let serialized: string;
  try {
    serialized = await io.readInput(source);
  } catch {
    throw new CliInputError(
      "INVALID_INPUT",
      "Unable to read structured command request",
      { source: source === "-" ? "stdin" : "file" },
      invocation,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new CliInputError(
      "INVALID_INPUT",
      "Structured command request is not valid JSON",
      undefined,
      invocation,
    );
  }

  if (command === "apply" && isObject(parsed) && isObject(parsed.input)) {
    const plan = parsed.input.plan;
    const planSchema = definition.inputSchema.properties?.input?.properties?.plan;
    if (plan !== undefined) assertExternalMutationPlanInput(plan, invocation, planSchema);
  }
  const issues = validateJsonSchema(parsed, definition.inputSchema);
  if (issues.length > 0) {
    throw new CliInputError(
      "INVALID_INPUT",
      "Structured command request does not match its schema",
      { issues },
      invocation,
    );
  }
  return parsed as CliCommandRequest<Record<string, unknown>>;
}

export function assertExternalMutationPlanInput(
  value: unknown,
  invocation: CliInvocation,
  schema: JsonSchema | undefined,
): asserts value is MutationPlan {
  if (!schema) throw new TypeError("apply contract does not define a plan schema");
  const issues = validateJsonSchema(value, schema, "$.input.plan");
  if (issues.length === 0) return;
  throw new CliInputError(
    "DOMAIN_VALIDATION_FAILED",
    "The sealed plan is invalid",
    { coreCode: "INVALID_PLAN", issues },
    invocation,
  );
}

function applyStructuredInput(
  actionCommand: Command,
  command: string,
  input: Record<string, unknown>,
  invocation: CliInvocation,
  definition: CommandDefinition,
): void {
  const bindings = definition.inputBindings;
  const suppliedFields = new Set(Object.keys(input));
  const ambiguous = new Set<string>();

  for (const binding of bindings) {
    if (!suppliedFields.has(binding.field)) continue;
    if (
      (binding.option !== undefined &&
        actionCommand.getOptionValueSource(binding.option) === "cli") ||
      (binding.positional !== undefined &&
        actionCommand.processedArgs[binding.positional] !== undefined)
    ) {
      ambiguous.add(binding.field);
    }
  }
  if (invocation.inputSource === "-" && command === "secret.add" && input.stdin === true) {
    ambiguous.add("stdin");
  }
  if (ambiguous.size > 0) {
    throw new CliInputError(
      "INPUT_AMBIGUITY",
      "Command-domain input was supplied in both argv and the structured request",
      { fields: [...ambiguous].sort() },
      invocation,
    );
  }

  for (const binding of bindings) {
    if (!suppliedFields.has(binding.field)) continue;
    const value = input[binding.field];
    if (binding.positional !== undefined) {
      actionCommand.processedArgs[binding.positional] = value;
      continue;
    }
    if (binding.option === undefined) continue;
    const encoded =
      binding.field === "capabilities"
        ? (value as readonly string[]).includes(binding.option)
        : (binding.encode?.(value) ?? value);
    actionCommand.setOptionValueWithSource(binding.option, encoded, "config");
  }
}

export function validateJsonSchema(value: unknown, schema: JsonSchema, path = "$"): string[] {
  try {
    return validateJsonSchemaUnchecked(value, schema, path);
  } catch {
    return [`${path}: validation failed`];
  }
}

function validateJsonSchemaUnchecked(value: unknown, schema: JsonSchema, path: string): string[] {
  const issues: string[] = [];
  if (schema["x-cellarer-opaque"] === true) return issues;
  if ("const" in schema && !Object.is(value, schema.const)) issues.push(`${path}: const`);
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    issues.push(`${path}: enum`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(
      (member) => validateJsonSchema(value, member, path).length === 0,
    ).length;
    if (matches !== 1) issues.push(`${path}: oneOf (matched ${matches})`);
  }
  if (schema.anyOf) {
    const matches = schema.anyOf.filter(
      (member) => validateJsonSchema(value, member, path).length === 0,
    ).length;
    if (matches === 0) issues.push(`${path}: anyOf (matched 0)`);
  }
  for (const member of schema.allOf ?? []) {
    issues.push(...validateJsonSchema(value, member, path));
  }
  if (schema.not && validateJsonSchema(value, schema.not, path).length === 0) {
    issues.push(`${path}: not`);
  }
  if (schema.if && schema.then && validateJsonSchema(value, schema.if, path).length === 0) {
    issues.push(...validateJsonSchema(value, schema.then, path));
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((type) => matchesJsonType(value, type))) {
    return [...issues, `${path}: type ${types.join(",")}`];
  }

  if (isObject(value) && (types.includes("object") || schema.properties || schema.required)) {
    const properties = schema.properties ?? {};
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      issues.push(`${path}: minProperties`);
    }
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) issues.push(`${path}.${required}: required`);
    }
    for (const key of Object.keys(value)) {
      if (schema.propertyNames) {
        issues.push(...validateJsonSchema(key, schema.propertyNames, `${path}.${key}`));
      }
      if (Object.hasOwn(properties, key)) continue;
      if (schema.additionalProperties === false) {
        issues.push(`${path}: unexpected property ${key}`);
      } else if (typeof schema.additionalProperties === "object") {
        issues.push(
          ...validateJsonSchema(value[key], schema.additionalProperties, `${path}.${key}`),
        );
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        issues.push(...validateJsonSchema(value[key], propertySchema, `${path}.${key}`));
      }
    }
    return issues;
  }
  if (Array.isArray(value) && types.includes("array")) {
    if (schema.items) {
      value.forEach((item, index) => {
        issues.push(...validateJsonSchema(item, schema.items as JsonSchema, `${path}[${index}]`));
      });
    }
    return issues;
  }
  if (typeof value === "string" && types.includes("string")) {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push(`${path}: minLength`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) issues.push(`${path}: pattern`);
  } else if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${path}: minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${path}: maximum`);
  }
  return issues;
}

function matchesJsonType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "object") return isObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isSafeInteger(value);
  return false;
}

function commandIdentity(command: Command): string {
  if (!command.parent) return command.name();
  const names: string[] = [];
  let current: Command | null = command;
  while (current?.parent) {
    names.unshift(current.name());
    current = current.parent;
  }
  return names.join(".");
}

function parseOutput(value: string | undefined, command: string): CliOutput {
  if (value === "text" || value === "json" || value === "jsonl") return value;
  throw new CliInputError(
    "INVALID_USAGE",
    "Invalid --output format; expected text, json, or jsonl",
    { option: "output", command },
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defaultInputIo(): CliInputBoundaryIo {
  return {
    stdinIsTTY: process.stdin.isTTY === true,
    readInput: async (source) => readFileSync(source === "-" ? 0 : source, "utf8"),
  };
}
