import { CLI_PROTOCOL_VERSION, type CliError } from "@cellarer/core";
import { Command } from "commander";
import type {
  CliCapabilities,
  CommandDefinition,
  CommandInputBinding,
  ProtocolSchemaBundle,
} from "./command-registry.js";
import type { CliCommandExecution, CliCommandOutcome } from "./execution.js";
import {
  assertClosedJsonSchema,
  CLI_ERROR_SCHEMA,
  CLI_WARNING_SCHEMA,
  createCommandProtocolSchemas,
  immutableJsonSnapshot,
  type JsonSchema,
} from "./schemas.js";

export interface CommandNormalizationContext {
  readonly command: Command;
  readonly actionArguments: readonly unknown[];
}

export interface CommandContractExecution<TEvent> {
  readonly invocation: CliCommandExecution["invocation"];
  event(code: string, data: TEvent): void;
}

export interface CommandContract<
  TCommand extends string = string,
  TInput = unknown,
  TOutput = unknown,
  TEvent = unknown,
> extends CommandDefinition<TCommand> {
  createCommand(): Command;
  normalize(context: CommandNormalizationContext): TInput;
  execute(
    input: TInput,
    execution: CommandContractExecution<TEvent>,
  ): Promise<CliCommandOutcome<TOutput>>;
  presentText(outcome: CliCommandOutcome<TOutput>): void;
  mapError(error: unknown): CliError | undefined;
}

export interface CommandContractInput<TCommand extends string, TInput, TOutput, TEvent = never> {
  readonly command: TCommand;
  readonly mutability: CommandDefinition["mutability"];
  readonly streaming?: boolean;
  readonly requiredFeatures?: readonly string[];
  readonly input: JsonSchema;
  readonly bindings: readonly CommandInputBinding[];
  readonly output: JsonSchema;
  readonly event?: JsonSchema;
  createCommand(): Command;
  normalize(context: CommandNormalizationContext): TInput;
  execute(
    input: TInput,
    execution: CommandContractExecution<TEvent>,
  ): Promise<CliCommandOutcome<TOutput>>;
  presentText(outcome: CliCommandOutcome<TOutput>): void;
  mapError(error: unknown): CliError | undefined;
}

export interface CommandDomain {
  readonly id: string;
  readonly contracts: readonly CommandContract[];
}

export interface CommandRendererMetadata {
  readonly command: string;
  readonly streaming: boolean;
  readonly outputSchema: JsonSchema;
  readonly eventSchema?: JsonSchema;
}

export type CommandContractRunner = (
  contract: CommandContract,
  context: CommandNormalizationContext,
) => void | Promise<void>;

export interface CommandCatalog {
  readonly contracts: readonly CommandContract[];
  registerCommander(program: Command, runner: CommandContractRunner): void;
  assertExecutableParity(executablePaths: readonly string[]): void;
  getCapabilities(): CliCapabilities;
  getSchemaBundle(schemaId?: string): ProtocolSchemaBundle | undefined;
  getInputBindings(command: string): readonly CommandInputBinding[] | undefined;
  getRendererMetadata(command: string): CommandRendererMetadata | undefined;
}

export function defineCommandContract<TCommand extends string, TInput, TOutput, TEvent = never>(
  input: CommandContractInput<TCommand, TInput, TOutput, TEvent>,
): CommandContract<TCommand, TInput, TOutput, TEvent> {
  const streaming = input.streaming ?? false;
  if (streaming !== (input.event !== undefined)) {
    throw new TypeError(
      `command ${input.command} must define an event schema exactly when streaming`,
    );
  }
  assertCommandPath(input.command);
  assertInputBindings(input.command, input.input, input.bindings);
  const schemas = createCommandProtocolSchemas(
    input.command,
    input.input,
    input.output,
    input.event,
  );
  assertClosedJsonSchema(schemas.inputSchema, `${input.command}.input`);
  assertClosedJsonSchema(schemas.outputSchema, `${input.command}.output`);
  if (schemas.eventSchema) assertClosedJsonSchema(schemas.eventSchema, `${input.command}.event`);

  return Object.freeze({
    command: input.command,
    mutability: input.mutability,
    streaming,
    requiredFeatures: Object.freeze([...(input.requiredFeatures ?? [])]),
    inputBindings: Object.freeze([...input.bindings]),
    ...schemas,
    createCommand: input.createCommand,
    normalize: input.normalize,
    execute: input.execute,
    presentText: input.presentText,
    mapError: input.mapError,
  });
}

export function defineCommandDomain(input: {
  readonly id: string;
  readonly contracts: readonly CommandContract[];
}): CommandDomain {
  if (input.id.trim().length === 0) throw new TypeError("command domain id must not be empty");
  return Object.freeze({ id: input.id, contracts: Object.freeze([...input.contracts]) });
}

export function createCommandCatalog(domains: readonly CommandDomain[]): CommandCatalog {
  const domainIds = new Set<string>();
  const contracts: CommandContract[] = [];
  for (const domain of domains) {
    if (domainIds.has(domain.id)) throw new TypeError(`duplicate command domain ${domain.id}`);
    domainIds.add(domain.id);
    contracts.push(...domain.contracts);
  }

  const commandByPath = new Map<string, CommandContract>();
  const schemaById = new Map<string, JsonSchema>();
  registerSchema(schemaById, requiredSchemaId(CLI_WARNING_SCHEMA), CLI_WARNING_SCHEMA);
  registerSchema(schemaById, requiredSchemaId(CLI_ERROR_SCHEMA), CLI_ERROR_SCHEMA);
  for (const contract of contracts) {
    assertCommandContract(contract);
    if (commandByPath.has(contract.command)) {
      throw new TypeError(`duplicate command path ${contract.command}`);
    }
    commandByPath.set(contract.command, contract);
    registerSchema(schemaById, contract.inputSchemaId, contract.inputSchema);
    registerSchema(schemaById, contract.outputSchemaId, contract.outputSchema);
    if (contract.eventSchemaId && contract.eventSchema) {
      registerSchema(schemaById, contract.eventSchemaId, contract.eventSchema);
    }
  }
  assertNoCommandPathPrefixes(commandByPath.keys());

  const frozenContracts = Object.freeze([...contracts]);
  const catalog: CommandCatalog = {
    contracts: frozenContracts,
    registerCommander(program, runner) {
      for (const contract of frozenContracts) registerContract(program, contract, runner);
    },
    assertExecutableParity(executablePaths) {
      const executableSet = new Set(executablePaths);
      const executableWithoutContract = [...executableSet]
        .filter((path) => !commandByPath.has(path))
        .sort();
      if (executableWithoutContract.length > 0) {
        throw new TypeError(`executable command ${executableWithoutContract[0]} has no contract`);
      }
      const contractWithoutExecutable = [...commandByPath.keys()]
        .filter((path) => !executableSet.has(path))
        .sort();
      if (contractWithoutExecutable.length > 0) {
        throw new TypeError(`contract ${contractWithoutExecutable[0]} has no executable command`);
      }
    },
    getCapabilities() {
      return {
        protocolVersions: [CLI_PROTOCOL_VERSION],
        commands: frozenContracts.map((contract) => ({
          command: contract.command,
          mutability: contract.mutability,
          streaming: contract.streaming,
          inputSchemaId: contract.inputSchemaId,
          outputSchemaId: contract.outputSchemaId,
          ...(contract.eventSchemaId ? { eventSchemaId: contract.eventSchemaId } : {}),
          requiredFeatures: [...contract.requiredFeatures],
        })),
      };
    },
    getSchemaBundle(schemaId) {
      if (schemaId !== undefined && !schemaById.has(schemaId)) return undefined;
      const ids = schemaId === undefined ? [...schemaById.keys()].sort() : [schemaId];
      return Object.freeze({
        bundleVersion: 1,
        protocolVersion: CLI_PROTOCOL_VERSION,
        schemas: Object.freeze(
          ids.map((id) =>
            Object.freeze({ schemaId: id, schema: schemaById.get(id) as JsonSchema }),
          ),
        ),
      });
    },
    getInputBindings(command) {
      return commandByPath.get(command)?.inputBindings;
    },
    getRendererMetadata(command) {
      const contract = commandByPath.get(command);
      if (!contract) return undefined;
      return {
        command: contract.command,
        streaming: contract.streaming,
        outputSchema: contract.outputSchema,
        ...(contract.eventSchema ? { eventSchema: contract.eventSchema } : {}),
      };
    },
  };
  return Object.freeze(catalog);
}

function registerContract(
  program: Command,
  contract: CommandContract,
  runner: CommandContractRunner,
): void {
  const segments = contract.command.split(".");
  const leafName = segments.pop() as string;
  let parent = program;
  for (const segment of segments) {
    const existing = parent.commands.find((child) => child.name() === segment);
    if (existing) {
      parent = existing;
      continue;
    }
    const created = new Command(segment);
    parent.addCommand(created);
    parent = created;
  }

  if (parent.commands.some((child) => child.name() === leafName)) {
    throw new TypeError(`Commander tree already contains ${contract.command}`);
  }
  const leaf = contract.createCommand();
  if (leaf.name() !== leafName) {
    throw new TypeError(
      `contract ${contract.command} created Commander leaf ${leaf.name() || "<empty>"}`,
    );
  }
  if (leaf.commands.length > 0) {
    throw new TypeError(`contract ${contract.command} must create one executable leaf`);
  }
  leaf.action((...actionArguments: unknown[]) =>
    runner(contract, { command: leaf, actionArguments }),
  );
  parent.addCommand(leaf);
}

function assertCommandContract(contract: CommandContract): void {
  assertCommandPath(contract.command);
  if (!(["read", "write", "service"] as const).includes(contract.mutability)) {
    throw new TypeError(`command ${contract.command} has invalid mutability`);
  }
  if (
    contract.streaming !==
    (contract.eventSchema !== undefined && contract.eventSchemaId !== undefined)
  ) {
    throw new TypeError(
      `command ${contract.command} must define an event schema exactly when streaming`,
    );
  }
  assertSchemaIdentity(contract.command, "input", contract.inputSchemaId, contract.inputSchema);
  assertSchemaIdentity(contract.command, "output", contract.outputSchemaId, contract.outputSchema);
  if (contract.eventSchemaId && contract.eventSchema) {
    assertSchemaIdentity(contract.command, "event", contract.eventSchemaId, contract.eventSchema);
  }
  assertClosedJsonSchema(contract.inputSchema, `${contract.command}.input`);
  assertClosedJsonSchema(contract.outputSchema, `${contract.command}.output`);
  if (contract.eventSchema)
    assertClosedJsonSchema(contract.eventSchema, `${contract.command}.event`);
  const inputDataSchema = contract.inputSchema.properties?.input;
  if (!inputDataSchema) throw new TypeError(`command ${contract.command} has no input data schema`);
  assertInputBindings(contract.command, inputDataSchema, contract.inputBindings);
  assertUniqueStrings(contract.command, "required feature", contract.requiredFeatures);
  for (const handler of [
    contract.createCommand,
    contract.normalize,
    contract.execute,
    contract.presentText,
    contract.mapError,
  ]) {
    if (typeof handler !== "function") {
      throw new TypeError(`command ${contract.command} has an invalid handler`);
    }
  }
}

function assertSchemaIdentity(
  command: string,
  kind: "input" | "output" | "event",
  schemaId: string,
  schema: JsonSchema,
): void {
  if (schema.$id !== schemaId) {
    throw new TypeError(`command ${command} ${kind} schema ID does not match its schema`);
  }
  if (schema.properties?.command?.const !== command) {
    throw new TypeError(`command ${command} ${kind} schema does not bind the command path`);
  }
}

function assertInputBindings(
  command: string,
  inputSchema: JsonSchema,
  bindings: readonly CommandInputBinding[],
): void {
  const schemaFields = Object.keys(inputSchema.properties ?? {}).sort();
  const bindingFields = [...new Set(bindings.map(({ field }) => field))].sort();
  if (schemaFields.join("\0") !== bindingFields.join("\0")) {
    throw new TypeError(`command ${command} input bindings do not match its input schema`);
  }

  const optionNames = new Set<string>();
  const positionalIndexes = new Set<number>();
  for (const binding of bindings) {
    const hasOption = typeof binding.option === "string" && binding.option.length > 0;
    const hasPositional =
      typeof binding.positional === "number" &&
      Number.isSafeInteger(binding.positional) &&
      binding.positional >= 0;
    if (hasOption === hasPositional) {
      throw new TypeError(
        `command ${command} input bindings must select one option or positional source`,
      );
    }
    if (hasOption) {
      if (optionNames.has(binding.option as string)) {
        throw new TypeError(`command ${command} has duplicate option input binding`);
      }
      optionNames.add(binding.option as string);
    } else {
      if (positionalIndexes.has(binding.positional as number)) {
        throw new TypeError(`command ${command} has duplicate positional input binding`);
      }
      positionalIndexes.add(binding.positional as number);
    }
  }
}

function assertCommandPath(command: string): void {
  if (!/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/.test(command)) {
    throw new TypeError(`invalid command path ${command}`);
  }
}

function assertUniqueStrings(command: string, label: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) {
      throw new TypeError(`command ${command} has invalid ${label}: ${value || "<empty>"}`);
    }
    seen.add(value);
  }
}

function registerSchema(
  schemas: Map<string, JsonSchema>,
  schemaId: string,
  schema: JsonSchema,
): void {
  if (schemas.has(schemaId)) throw new TypeError(`duplicate schema ID ${schemaId}`);
  schemas.set(schemaId, immutableJsonSnapshot(schema));
}

function requiredSchemaId(schema: JsonSchema): string {
  if (!schema.$id) throw new TypeError("protocol schema is missing its ID");
  return schema.$id;
}

function assertNoCommandPathPrefixes(paths: Iterable<string>): void {
  const pathSet = new Set(paths);
  for (const path of pathSet) {
    const segments = path.split(".");
    while (segments.length > 1) {
      segments.pop();
      const parent = segments.join(".");
      if (pathSet.has(parent)) {
        throw new TypeError(`command path ${parent} is both executable and a parent`);
      }
    }
  }
}
