import {
  CLI_PROTOCOL_VERSION,
  type CliError,
  type CliErrorResultEnvelope,
  type CliEvent,
  type CliEventEnvelope,
  type CliSuccessResultEnvelope,
  type CliWarning,
  redactSafeObservableText,
} from "@cellarer/core";
import { Command } from "commander";
import { serializeCliOutput } from "../output.js";
import type {
  CliCapabilities,
  CommandDefinition,
  CommandInputBinding,
  ProtocolSchemaBundle,
} from "./command-types.js";
import { CliHandledError } from "./errors.js";
import {
  type CliCommandExecution,
  type CliCommandOutcome,
  executeCliCommand,
} from "./execution.js";
import { CLI_EXIT_CODE, type CliExitCode, exitCodeForError } from "./exit-mapper.js";
import { validateJsonSchema } from "./input.js";
import { INTERNAL_FAILURE_DIAGNOSTIC, safeInternalFailureDiagnostic } from "./internal-failure.js";
import {
  isPublicProtocolSchemaBundle,
  registerPublicProtocolSchemaBundle,
} from "./protocol-schema-bundle.js";
import type { ProtocolRenderer, ProtocolRendererOptions } from "./renderer.js";
import { resolveRequestId } from "./request-id.js";
import {
  assertClosedJsonSchema,
  CLI_ERROR_SCHEMA,
  CLI_WARNING_SCHEMA,
  createCommandErrorResultSchema,
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
  readonly catalogOrder: number;
  createCommand(): Command;
  normalize(context: CommandNormalizationContext): TInput;
  execute(
    input: TInput,
    execution: CommandContractExecution<TEvent>,
  ): Promise<CliCommandOutcome<TOutput>>;
  presentText(outcome: CliCommandOutcome<TOutput>, input: TInput): void;
  mapError(error: unknown): CliError | undefined;
}

export interface CommandContractMetadata<TCommand extends string> {
  readonly command: TCommand;
  readonly catalogOrder: number;
  readonly mutability: CommandDefinition["mutability"];
  readonly streaming?: boolean;
  readonly requiredFeatures?: readonly string[];
  readonly input: JsonSchema;
  readonly bindings: readonly CommandInputBinding[];
  readonly output: JsonSchema;
  readonly event?: JsonSchema;
}

export interface CommandContractInput<TCommand extends string, TInput, TOutput, TEvent = never>
  extends CommandContractMetadata<TCommand> {
  createCommand(): Command;
  normalize(context: CommandNormalizationContext): TInput;
  execute(
    input: TInput,
    execution: CommandContractExecution<TEvent>,
  ): Promise<CliCommandOutcome<TOutput>>;
  presentText(outcome: CliCommandOutcome<TOutput>, input: TInput): void;
  mapError(error: unknown): CliError | undefined;
}

type CommandContractHandlers<TCommand extends string, TInput, TOutput, TEvent> = Pick<
  CommandContractInput<TCommand, TInput, TOutput, TEvent>,
  "createCommand" | "normalize" | "execute" | "presentText" | "mapError"
>;

export function defineContractMetadata<TCommand extends string>(
  metadata: CommandContractMetadata<TCommand>,
): CommandContractMetadata<TCommand> {
  return Object.freeze({
    ...metadata,
    requiredFeatures: Object.freeze([...(metadata.requiredFeatures ?? [])]),
    bindings: Object.freeze([...metadata.bindings]),
  });
}

export interface CommandDomain {
  readonly id: string;
  readonly contracts: readonly CommandContract[];
}

export type CommandContractRunner = (
  command: string,
  context: CommandNormalizationContext,
) => void | Promise<void>;

declare const EXECUTABLE_MATCH: unique symbol;

export interface ExecutableCommandMatch {
  readonly [EXECUTABLE_MATCH]: never;
}

export type ExecutableCommandResolution =
  | { readonly kind: "known"; readonly definition: CommandDefinition }
  | { readonly kind: "unknown" };

export interface CommandCatalog {
  readonly contracts: readonly CommandContract[];
  readonly definitions: readonly CommandDefinition[];
  registerCommander(program: Command, runner: CommandContractRunner): void;
  assertExecutableParity(executablePaths: readonly string[]): void;
  matchExecutable(command: string): ExecutableCommandMatch;
  resolveExecutableMatch(match: ExecutableCommandMatch): ExecutableCommandResolution;
  createProtocolRenderer(options: ProtocolRendererOptions): ProtocolRenderer;
  requireContract(command: string): CommandContract;
  requireDefinition(command: string): CommandDefinition;
  getCapabilities(): CliCapabilities;
  getSchemaBundle(schemaId?: string): ProtocolSchemaBundle | undefined;
}

const executableMatches = new WeakMap<
  object,
  {
    readonly catalog: CommandCatalog;
    readonly command: string;
    readonly definition?: CommandDefinition;
  }
>();

export function defineCommandContract<TCommand extends string, TInput, TOutput, TEvent = never>(
  metadata:
    | CommandContractMetadata<TCommand>
    | CommandContractInput<TCommand, TInput, TOutput, TEvent>,
  handlers?: CommandContractHandlers<TCommand, TInput, TOutput, TEvent>,
): CommandContract<TCommand, TInput, TOutput, TEvent> {
  const input = (handlers ? { ...metadata, ...handlers } : metadata) as CommandContractInput<
    TCommand,
    TInput,
    TOutput,
    TEvent
  >;
  const streaming = input.streaming ?? false;
  if (streaming !== (input.event !== undefined)) {
    throw new TypeError(
      `command ${input.command} must define an event schema exactly when streaming`,
    );
  }
  assertCommandPath(input.command);
  if (!Number.isSafeInteger(input.catalogOrder) || input.catalogOrder < 0) {
    throw new TypeError(`command ${input.command} has invalid catalog order`);
  }
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
    catalogOrder: input.catalogOrder,
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

  const contractByPath = new Map<string, CommandContract>();
  for (const contract of contracts) {
    assertCommandContract(contract);
    if (contractByPath.has(contract.command)) {
      throw new TypeError(`duplicate command path ${contract.command}`);
    }
    contractByPath.set(contract.command, contract);
  }

  const orderedContracts = [...contracts].sort(
    (left, right) => left.catalogOrder - right.catalogOrder,
  );
  const catalogOrders = new Set<number>();
  for (const contract of orderedContracts) {
    if (catalogOrders.has(contract.catalogOrder)) {
      throw new TypeError(`duplicate catalog order ${contract.catalogOrder}`);
    }
    catalogOrders.add(contract.catalogOrder);
  }

  const canonicalContracts = Object.freeze(
    orderedContracts.map(canonicalizeDefinition),
  ) as readonly CommandContract[];
  contractByPath.clear();
  for (const contract of canonicalContracts) contractByPath.set(contract.command, contract);

  const definitionByPath = new Map<string, CommandDefinition>();
  const schemaById = new Map<string, JsonSchema>();
  registerSchema(
    schemaById,
    requiredSchemaId(CLI_WARNING_SCHEMA),
    immutableJsonSnapshot(CLI_WARNING_SCHEMA),
  );
  registerSchema(
    schemaById,
    requiredSchemaId(CLI_ERROR_SCHEMA),
    immutableJsonSnapshot(CLI_ERROR_SCHEMA),
  );
  for (const definition of canonicalContracts) {
    assertCommandDefinition(definition);
    if (definitionByPath.has(definition.command)) {
      throw new TypeError(`duplicate command path ${definition.command}`);
    }
    definitionByPath.set(definition.command, definition);
    registerSchema(schemaById, definition.inputSchemaId, definition.inputSchema);
    registerSchema(schemaById, definition.outputSchemaId, definition.outputSchema);
    if (definition.eventSchemaId && definition.eventSchema) {
      registerSchema(schemaById, definition.eventSchemaId, definition.eventSchema);
    }
  }
  assertNoCommandPathPrefixes(definitionByPath.keys());

  const frozenContracts = canonicalContracts;
  const capabilities: CliCapabilities = Object.freeze({
    protocolVersions: Object.freeze([CLI_PROTOCOL_VERSION]),
    commands: Object.freeze(
      frozenContracts.map((definition) =>
        Object.freeze({
          command: definition.command,
          mutability: definition.mutability,
          streaming: definition.streaming,
          inputSchemaId: definition.inputSchemaId,
          outputSchemaId: definition.outputSchemaId,
          ...(definition.eventSchemaId ? { eventSchemaId: definition.eventSchemaId } : {}),
          requiredFeatures: definition.requiredFeatures,
        }),
      ),
    ),
  });
  const createSchemaBundle = (ids: readonly string[]): ProtocolSchemaBundle =>
    registerPublicProtocolSchemaBundle(
      Object.freeze({
        bundleVersion: 1,
        protocolVersion: CLI_PROTOCOL_VERSION,
        schemas: Object.freeze(
          ids.map((id) =>
            Object.freeze({ schemaId: id, schema: schemaById.get(id) as JsonSchema }),
          ),
        ),
      }),
    );
  const completeSchemaBundle = createSchemaBundle([...schemaById.keys()].sort());
  const catalog: CommandCatalog = {
    contracts: frozenContracts,
    definitions: frozenContracts,
    registerCommander(program, runner) {
      for (const contract of frozenContracts) {
        registerContract(program, contract, runner);
      }
    },
    assertExecutableParity(executablePaths) {
      const executableSet = new Set(executablePaths);
      const executableWithoutContract = [...executableSet]
        .filter((path) => !definitionByPath.has(path))
        .sort();
      if (executableWithoutContract.length > 0) {
        throw new TypeError(`executable command ${executableWithoutContract[0]} has no contract`);
      }
      const contractWithoutExecutable = [...definitionByPath.keys()]
        .filter((path) => !executableSet.has(path))
        .sort();
      if (contractWithoutExecutable.length > 0) {
        throw new TypeError(`contract ${contractWithoutExecutable[0]} has no executable command`);
      }
    },
    matchExecutable(command) {
      const match = Object.freeze({}) as ExecutableCommandMatch;
      executableMatches.set(match, {
        catalog,
        command,
        definition: definitionByPath.get(command),
      });
      return match;
    },
    resolveExecutableMatch(match) {
      const matched = executableMatches.get(match);
      if (!matched || matched.catalog !== catalog) {
        throw new TypeError("executable match was not issued by the active command composition");
      }
      return matched.definition
        ? { kind: "known", definition: matched.definition }
        : { kind: "unknown" };
    },
    createProtocolRenderer(options) {
      return createBoundProtocolRenderer(catalog, options);
    },
    requireContract(command) {
      const contract = contractByPath.get(command);
      if (!contract) throw new TypeError(`command ${command} is absent from the aggregate catalog`);
      return contract;
    },
    requireDefinition(command) {
      const definition = definitionByPath.get(command);
      if (!definition)
        throw new TypeError(`command ${command} is absent from the aggregate catalog`);
      return definition;
    },
    getCapabilities() {
      return capabilities;
    },
    getSchemaBundle(schemaId) {
      if (schemaId !== undefined && !schemaById.has(schemaId)) return undefined;
      return schemaId === undefined ? completeSchemaBundle : createSchemaBundle([schemaId]);
    },
  };
  return Object.freeze(catalog);
}

function createBoundProtocolRenderer(
  catalog: CommandCatalog,
  options: ProtocolRendererOptions,
): ProtocolRenderer {
  if (
    "authority" in options ||
    "definition" in options ||
    "allowUnknownCommand" in options ||
    "classification" in options ||
    "match" in options
  ) {
    throw new TypeError(
      "active command composition rejects caller-supplied authority or classification",
    );
  }
  const stdout = options.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = options.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const requestId = resolveRequestId(options.requestId, options.createUuid);
  let sequence = 0;
  let didEmitTerminal = false;
  const command = options.command;
  const matched = catalog.resolveExecutableMatch(catalog.matchExecutable(command));
  const definition: Pick<CommandDefinition, "command" | "outputSchema" | "eventSchema"> =
    matched.kind === "known"
      ? matched.definition
      : Object.freeze({
          command,
          outputSchema: immutableJsonSnapshot(createCommandErrorResultSchema(command)),
        });

  const ensureOpen = (): void => {
    if (didEmitTerminal) throw new Error("protocol terminal result has already been emitted");
  };

  const snapshotRecord = (
    record: unknown,
    context: unknown = record,
    trustedPublicSchema = false,
  ): unknown => {
    const encoded = trustedPublicSchema
      ? JSON.stringify(record)
      : serializeCliOutput(record, false, context);
    if (encoded === undefined) throw new TypeError("protocol record is not serializable");
    return JSON.parse(encoded) as unknown;
  };

  const isSchemaValid = (record: unknown, schema: JsonSchema | undefined): boolean => {
    if (!schema) return false;
    try {
      return validateJsonSchema(record, schema).length === 0;
    } catch {
      return false;
    }
  };

  const emitInternalTerminal = (): typeof CLI_EXIT_CODE.INTERNAL => {
    if (didEmitTerminal) return CLI_EXIT_CODE.INTERNAL;
    const fallback: CliErrorResultEnvelope = {
      protocolVersion: CLI_PROTOCOL_VERSION,
      command,
      requestId,
      status: "error",
      warnings: [],
      error: { code: "INTERNAL_ERROR", message: INTERNAL_FAILURE_DIAGNOSTIC },
    };
    didEmitTerminal = true;
    stdout(`${JSON.stringify(fallback)}\n`);
    return CLI_EXIT_CODE.INTERNAL;
  };

  const writeValidatedRecord = (
    record: unknown,
    schema: JsonSchema | undefined,
    context: unknown,
    trustedPublicSchema = false,
    terminal = false,
  ): boolean => {
    let snapshot: unknown;
    try {
      snapshot = snapshotRecord(record, context, trustedPublicSchema);
      if (!isSchemaValid(snapshot, schema)) return false;
    } catch {
      return false;
    }
    if (terminal) didEmitTerminal = true;
    stdout(`${JSON.stringify(snapshot)}\n`);
    return true;
  };

  return {
    command,
    output: options.output,
    requestId,
    get terminalEmitted() {
      return didEmitTerminal;
    },
    event<TData>(event: CliEvent<TData>): void {
      ensureOpen();
      if (options.output !== "jsonl") {
        throw new Error("protocol events require JSONL output");
      }
      const envelope: CliEventEnvelope<TData> = {
        protocolVersion: CLI_PROTOCOL_VERSION,
        command,
        requestId,
        sequence: ++sequence,
        event,
      };
      if (!writeValidatedRecord(envelope, definition.eventSchema, envelope)) {
        emitInternalTerminal();
      }
    },
    success<TData>(
      data: TData,
      warnings: readonly CliWarning[] = [],
      context: unknown = data,
    ): CliExitCode {
      if (didEmitTerminal) return CLI_EXIT_CODE.INTERNAL;
      ensureOpen();
      const envelope: CliSuccessResultEnvelope<TData> = {
        protocolVersion: CLI_PROTOCOL_VERSION,
        command,
        requestId,
        status: "success",
        data,
        warnings,
      };
      return writeValidatedRecord(
        envelope,
        definition.outputSchema,
        context,
        command === "schema" && isPublicProtocolSchemaBundle(data),
        true,
      )
        ? CLI_EXIT_CODE.SUCCESS
        : emitInternalTerminal();
    },
    failure<TData = never>(
      error: CliError,
      warnings: readonly CliWarning[] = [],
      data?: TData,
      context: unknown = data ?? error,
    ): CliExitCode {
      if (didEmitTerminal) return CLI_EXIT_CODE.INTERNAL;
      ensureOpen();
      const envelope: CliErrorResultEnvelope<TData> = {
        protocolVersion: CLI_PROTOCOL_VERSION,
        command,
        requestId,
        status: "error",
        ...(data === undefined ? {} : { data }),
        warnings,
        error,
      };
      return writeValidatedRecord(envelope, definition.outputSchema, context, false, true)
        ? exitCodeForError(error)
        : emitInternalTerminal();
    },
    internalFailure(error: unknown): typeof CLI_EXIT_CODE.INTERNAL {
      if (didEmitTerminal) return CLI_EXIT_CODE.INTERNAL;
      this.diagnostic(safeInternalFailureDiagnostic(error));
      return emitInternalTerminal();
    },
    diagnostic(message: string, context: unknown = message): void {
      stderr(`${redactSafeObservableText(context, message)}\n`);
    },
  };
}

export async function executeCommandContract(
  catalog: CommandCatalog,
  contract: CommandContract,
  context: CommandNormalizationContext,
): Promise<void> {
  let normalizedInput: unknown;
  await executeCliCommand(
    context.command,
    async (execution) => {
      try {
        normalizedInput = contract.normalize(context);
        return await contract.execute(normalizedInput, execution);
      } catch (error) {
        const mapped = contract.mapError(error);
        if (mapped) throw new CliHandledError(mapped);
        throw error;
      }
    },
    (outcome) => contract.presentText(outcome, normalizedInput),
    catalog,
    contract.command,
  );
}

export function commandFromCatalog(catalog: CommandCatalog, commandPath: string): Command {
  const contract = catalog.requireContract(commandPath);
  const command = contract.createCommand();
  command.action((...actionArguments: unknown[]) =>
    executeCommandContract(catalog, catalog.requireContract(commandPath), {
      command,
      actionArguments,
    }),
  );
  return command;
}

function canonicalizeDefinition<TDefinition extends CommandDefinition>(
  definition: TDefinition,
): TDefinition {
  return Object.freeze({
    ...definition,
    requiredFeatures: Object.freeze([...definition.requiredFeatures]),
    inputBindings: Object.freeze(
      definition.inputBindings.map((binding) => Object.freeze({ ...binding })),
    ),
    inputSchema: immutableJsonSnapshot(definition.inputSchema),
    outputSchema: immutableJsonSnapshot(definition.outputSchema),
    ...(definition.eventSchema
      ? { eventSchema: immutableJsonSnapshot(definition.eventSchema) }
      : {}),
  }) as TDefinition;
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
    runner(contract.command, { command: leaf, actionArguments }),
  );
  parent.addCommand(leaf);
}

function assertCommandContract(contract: CommandContract): void {
  assertCommandDefinition(contract);
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

function assertCommandDefinition(contract: CommandDefinition): void {
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
  schemas.set(schemaId, schema);
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
