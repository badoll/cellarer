import { readFileSync } from "node:fs";
import type { CliCommandRequest, CliError, CliErrorCode } from "@cellarer/core";
import type { Command } from "commander";
import { getCommandDefinition } from "./command-registry.js";
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
      "INVALID_USAGE" | "INVALID_INPUT" | "INPUT_REQUIRED" | "INPUT_AMBIGUITY"
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
  io: CliInputBoundaryIo = defaultInputIo(),
): void {
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
        inputSource === "-" ||
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
    const request = await readAndValidateRequest(inputSource, command, io, invocation);
    invocation = {
      ...invocation,
      ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
    };
    invocations.set(actionCommand, invocation);
    applyStructuredInput(actionCommand, command, request.input, invocation);
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

  const definition = getCommandDefinition(command);
  if (!definition) {
    throw new CliInputError(
      "INVALID_USAGE",
      "Structured input is not supported for this command",
      { command },
      invocation,
    );
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

function applyStructuredInput(
  actionCommand: Command,
  command: string,
  input: Record<string, unknown>,
  invocation: CliInvocation,
): void {
  const bindings = getCommandDefinition(command)?.inputBindings ?? [];
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

function validateJsonSchema(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const issues: string[] = [];
  if (schema.const !== undefined && value !== schema.const) issues.push(`${path}: const`);
  if (schema.enum && !schema.enum.includes(value)) issues.push(`${path}: enum`);

  if (schema.type === "object") {
    if (!isObject(value)) return [...issues, `${path}: object`];
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!(required in value)) issues.push(`${path}.${required}: required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) issues.push(`${path}: unexpected property`);
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value)
        issues.push(...validateJsonSchema(value[key], propertySchema, `${path}.${key}`));
    }
    return issues;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [...issues, `${path}: array`];
    if (schema.items) {
      value.forEach((item, index) => {
        issues.push(...validateJsonSchema(item, schema.items as JsonSchema, `${path}[${index}]`));
      });
    }
    return issues;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return [...issues, `${path}: string`];
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push(`${path}: minLength`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) issues.push(`${path}: pattern`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    issues.push(`${path}: boolean`);
  } else if (
    schema.type === "integer" &&
    (!Number.isSafeInteger(value) ||
      (schema.minimum !== undefined && (value as number) < schema.minimum) ||
      (schema.maximum !== undefined && (value as number) > schema.maximum))
  ) {
    issues.push(`${path}: integer`);
  }
  return issues;
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
