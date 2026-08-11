import {
  type CliError,
  type CliErrorCode,
  type CliWarning,
  ControlPlaneValidationError,
  clientErrorFromMutationConflict,
  InvalidConfigError,
  type MutationConflict,
  type OperationResult,
  type PresentedOperationResult,
  StoreMutationConflictError,
  serializeSafeObservable,
} from "@cellarer/core";
import { type Command, CommanderError } from "commander";
import { createSafeConsole } from "../output.js";
import { CliHandledError } from "./errors.js";
import { CLI_EXIT_CODE, type CliExitCode, exitCodeForError } from "./exit-mapper.js";
import { CliInputError, type CliInvocation, getCliInvocation } from "./input.js";
import {
  createProtocolRenderer,
  type ProtocolRenderer,
  safeInternalFailureDiagnostic,
} from "./renderer.js";

export type CliCommandOutcome<TData> =
  | {
      readonly ok: true;
      readonly data: TData;
      readonly warnings: readonly CliWarning[];
      readonly context: unknown;
    }
  | {
      readonly ok: false;
      readonly data?: TData;
      readonly warnings: readonly CliWarning[];
      readonly error: CliError;
      readonly context: unknown;
    };

export interface CliCommandExecution {
  readonly invocation: CliInvocation;
  event<TData>(code: string, data: TData): void;
}

type CliBoundaryErrorSnapshot =
  | {
      readonly kind: "commander";
      readonly exitCode: number;
      readonly code: string;
    }
  | {
      readonly kind: "handled";
      readonly cliError: CliError;
      readonly invocation?: CliInvocation;
    }
  | { readonly kind: "unclassified" };

const CLI_ERROR_CODES = new Set<CliErrorCode>([
  "INVALID_USAGE",
  "INVALID_INPUT",
  "INPUT_REQUIRED",
  "INPUT_AMBIGUITY",
  "POLICY_VIOLATION",
  "DOMAIN_VALIDATION_FAILED",
  "STALE_REVISION",
  "LOCK_CONFLICT",
  "TARGET_CONFLICT",
  "EXECUTION_FAILED",
  "PARTIAL_FAILURE",
  "RECOVERY_REQUIRED",
  "INTERNAL_ERROR",
]);

export function commandSuccess<TData>(
  data: TData,
  warnings: readonly CliWarning[] = [],
  context: unknown = data,
): CliCommandOutcome<TData> {
  return { ok: true, data, warnings, context };
}

export function commandFailure<TData>(
  error: CliError,
  data?: TData,
  warnings: readonly CliWarning[] = [],
  context: unknown = data ?? error,
): CliCommandOutcome<TData> {
  return {
    ok: false,
    ...(data === undefined ? {} : { data }),
    warnings,
    error,
    context,
  };
}

export function commandWarnings(
  messages: readonly string[],
  code = "COMMAND_WARNING",
): CliWarning[] {
  return messages.map((message) => ({ code, message }));
}

export async function executeCliCommand<TData>(
  command: Command,
  execute: (execution: CliCommandExecution) => Promise<CliCommandOutcome<TData>>,
  presentText: (outcome: CliCommandOutcome<TData>) => void,
): Promise<void> {
  const invocation = getCliInvocation(command);
  let renderer: ProtocolRenderer | undefined;

  try {
    if (invocation.output !== "text") {
      renderer = createProtocolRenderer({
        command: invocation.command,
        output: invocation.output,
        requestId: invocation.requestId,
      });
    }
    const execution: CliCommandExecution = {
      invocation,
      event(code, data) {
        if (renderer?.output === "jsonl") renderer.event({ code, data });
      },
    };
    const outcome = await execute(execution);

    if (renderer) {
      setExitCode(
        outcome.ok
          ? renderer.success(outcome.data, outcome.warnings, outcome.context)
          : renderer.failure(outcome.error, outcome.warnings, outcome.data, outcome.context),
      );
      return;
    }

    presentText(outcome);
    setExitCode(outcome.ok ? CLI_EXIT_CODE.SUCCESS : exitCodeForError(outcome.error));
  } catch (error) {
    const snapshot = snapshotCliBoundaryError(error);
    const cliError = snapshot.kind === "handled" ? snapshot.cliError : undefined;
    if (renderer) {
      setExitCode(cliError ? renderer.failure(cliError) : renderer.internalFailure(error));
      return;
    }

    const diagnostic = cliError?.message ?? safeInternalFailureDiagnostic(error);
    const output = createSafeConsole(cliError ? error : diagnostic);
    output.error(diagnostic);
    setExitCode(cliError ? exitCodeForError(cliError) : CLI_EXIT_CODE.INTERNAL);
  }
}

export function handleCliRunnerBoundaryError(
  error: unknown,
  fallbackInvocation: CliInvocation,
): void {
  const snapshot = snapshotCliBoundaryError(error);
  if (snapshot.kind === "commander") {
    if (snapshot.exitCode === 0) {
      setExitCode(CLI_EXIT_CODE.SUCCESS);
      return;
    }
    if (fallbackInvocation.output === "text") {
      setExitCode(CLI_EXIT_CODE.USAGE);
      return;
    }
    handleClassifiedBoundaryError(
      {
        code: "INVALID_USAGE",
        message: "Invalid command line usage",
        details: { parserCode: snapshot.code },
      },
      fallbackInvocation,
    );
    return;
  }
  handleCliBoundaryErrorSnapshot(error, snapshot, fallbackInvocation);
}

export function handleCliBoundaryError(error: unknown, fallbackInvocation?: CliInvocation): void {
  handleCliBoundaryErrorSnapshot(error, snapshotCliBoundaryError(error), fallbackInvocation);
}

function handleCliBoundaryErrorSnapshot(
  error: unknown,
  snapshot: CliBoundaryErrorSnapshot,
  fallbackInvocation?: CliInvocation,
): void {
  const cliError = snapshot.kind === "handled" ? snapshot.cliError : undefined;
  const invocation =
    snapshot.kind === "handled" ? (snapshot.invocation ?? fallbackInvocation) : fallbackInvocation;
  if (invocation && invocation.output !== "text") {
    const renderer = createProtocolRenderer({
      command: invocation.command,
      output: invocation.output,
      requestId: invocation.requestId,
    });
    setExitCode(cliError ? renderer.failure(cliError) : renderer.internalFailure(error));
    return;
  }
  const diagnostic = cliError?.message ?? safeInternalFailureDiagnostic(error);
  const output = createSafeConsole(cliError ? error : diagnostic);
  output.error(diagnostic);
  setExitCode(cliError ? exitCodeForError(cliError) : CLI_EXIT_CODE.INTERNAL);
}

function handleClassifiedBoundaryError(cliError: CliError, invocation: CliInvocation): void {
  if (invocation.output !== "text") {
    const renderer = createProtocolRenderer({
      command: invocation.command,
      output: invocation.output,
      requestId: invocation.requestId,
    });
    setExitCode(renderer.failure(cliError));
    return;
  }
  const output = createSafeConsole(cliError);
  output.error(cliError.message);
  setExitCode(exitCodeForError(cliError));
}

export function publicOperationResult(operation: OperationResult): PresentedOperationResult {
  return operation.ok ? operation : { ok: false, conflict: operation.conflict };
}

export function cliErrorFromOperation(operation: OperationResult): CliError | undefined {
  return operation.ok ? undefined : cliErrorFromMutationConflict(operation.conflict);
}

export function cliErrorFromMutationConflict(conflict: MutationConflict): CliError {
  return clientErrorFromMutationConflict(conflict);
}

function snapshotCliBoundaryError(error: unknown): CliBoundaryErrorSnapshot {
  try {
    if (error instanceof CommanderError) {
      const exitCode = error.exitCode;
      const code = error.code;
      if (
        typeof exitCode !== "number" ||
        !Number.isSafeInteger(exitCode) ||
        typeof code !== "string"
      ) {
        return { kind: "unclassified" };
      }
      return { kind: "commander", exitCode, code };
    }
    if (error instanceof CliInputError) {
      const cliError = snapshotCliError(error.cliError);
      const invocation = snapshotCliInvocation(error.invocation);
      return {
        kind: "handled",
        cliError,
        ...(invocation === undefined ? {} : { invocation }),
      };
    }
    if (error instanceof CliHandledError) {
      return { kind: "handled", cliError: snapshotCliError(error.cliError) };
    }
    if (error instanceof StoreMutationConflictError) {
      return { kind: "handled", cliError: cliErrorFromMutationConflict(error.conflict) };
    }
    if (error instanceof ControlPlaneValidationError) {
      const message = ownDataProperty(error, "message", true);
      const details = ownDataProperty(error, "details", true);
      if (typeof message !== "string") return { kind: "unclassified" };
      return {
        kind: "handled",
        cliError: snapshotCliError({
          code: "DOMAIN_VALIDATION_FAILED",
          message,
          details: details as Readonly<Record<string, unknown>>,
        }),
      };
    }
    if (error instanceof InvalidConfigError) {
      return {
        kind: "handled",
        cliError: {
          code: "DOMAIN_VALIDATION_FAILED",
          message: error.message,
          details: { configPath: error.configPath },
        },
      };
    }
    return { kind: "unclassified" };
  } catch {
    return { kind: "unclassified" };
  }
}

function snapshotCliError(error: CliError): CliError {
  const code = ownDataProperty(error, "code", true);
  const message = ownDataProperty(error, "message", true);
  const details = ownDataProperty(error, "details", false);
  if (
    typeof code !== "string" ||
    !CLI_ERROR_CODES.has(code as CliErrorCode) ||
    typeof message !== "string"
  ) {
    throw new TypeError("Invalid classified CLI error");
  }
  if (details !== undefined && (details === null || typeof details !== "object")) {
    throw new TypeError("Invalid classified CLI error details");
  }

  const candidate: Record<PropertyKey, unknown> = {
    code,
    message,
    ...(details === undefined ? {} : { details: cloneJsonSafeValue(details, new WeakSet()) }),
  };
  copyNonEnumerableSymbolData(error, candidate);
  const serialized = serializeSafeObservable("cli", candidate, {
    pretty: false,
    knownValueSources: details === undefined ? [] : [candidate.details],
  });
  const snapshot = JSON.parse(serialized) as unknown;
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot) ||
    (snapshot as { code?: unknown }).code !== code ||
    typeof (snapshot as { message?: unknown }).message !== "string"
  ) {
    throw new TypeError("Invalid classified CLI error snapshot");
  }
  const snapshotDetails = (snapshot as { details?: unknown }).details;
  if (
    snapshotDetails !== undefined &&
    (typeof snapshotDetails !== "object" ||
      snapshotDetails === null ||
      Array.isArray(snapshotDetails))
  ) {
    throw new TypeError("Invalid classified CLI error details snapshot");
  }
  return snapshot as CliError;
}

function ownDataProperty(value: object, key: PropertyKey, required: boolean): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    if (required) throw new TypeError("Missing classified CLI error property");
    return undefined;
  }
  if (!("value" in descriptor)) throw new TypeError("Accessor in classified CLI error");
  return descriptor.value;
}

function cloneJsonSafeValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite classified CLI error detail");
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("Unsupported classified CLI error detail");
  }
  if (ancestors.has(value)) throw new TypeError("Circular classified CLI error details");

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    (isArray && prototype !== Array.prototype) ||
    (!isArray && prototype !== Object.prototype && prototype !== null)
  ) {
    throw new TypeError("Non-plain classified CLI error detail");
  }

  ancestors.add(value);
  try {
    const stringEntries: Array<readonly [string, unknown]> = [];
    const symbolEntries: Array<readonly [symbol, unknown]> = [];
    let arrayLength: number | undefined;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined) {
        throw new TypeError("Unstable classified CLI error details");
      }
      if (typeof key === "symbol") {
        if (descriptor.enumerable || !("value" in descriptor)) {
          throw new TypeError("Unsupported symbol in classified CLI error details");
        }
        symbolEntries.push([key, descriptor.value]);
        continue;
      }
      if (isArray && key === "length") {
        if (!("value" in descriptor) || !Number.isSafeInteger(descriptor.value)) {
          throw new TypeError("Invalid classified CLI error detail array");
        }
        arrayLength = descriptor.value;
        continue;
      }
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) {
        throw new TypeError("Accessor in classified CLI error details");
      }
      if (key === "__proto__") {
        throw new TypeError("Unsupported classified CLI error detail key");
      }
      stringEntries.push([key, descriptor.value]);
    }

    if (isArray) {
      if (arrayLength === undefined || stringEntries.length !== arrayLength) {
        throw new TypeError("Sparse classified CLI error detail array");
      }
      const entriesByIndex = new Map(stringEntries);
      const clone: unknown[] = [];
      for (let index = 0; index < arrayLength; index += 1) {
        const key = String(index);
        if (!entriesByIndex.has(key)) {
          throw new TypeError("Invalid classified CLI error detail array index");
        }
        clone.push(cloneJsonSafeValue(entriesByIndex.get(key), ancestors));
      }
      copySymbolEntries(symbolEntries, clone);
      return clone;
    }

    const clone: Record<PropertyKey, unknown> = Object.create(null) as Record<PropertyKey, unknown>;
    for (const [key, child] of stringEntries) {
      Object.defineProperty(clone, key, {
        value: cloneJsonSafeValue(child, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    copySymbolEntries(symbolEntries, clone);
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function copyNonEnumerableSymbolData(source: object, target: object): void {
  const entries: Array<readonly [symbol, unknown]> = [];
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "symbol") continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor === undefined || descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Unsupported classified CLI error metadata");
    }
    entries.push([key, descriptor.value]);
  }
  copySymbolEntries(entries, target);
}

function copySymbolEntries(entries: readonly (readonly [symbol, unknown])[], target: object): void {
  for (const [key, value] of entries) {
    Object.defineProperty(target, key, { value });
  }
}

function snapshotCliInvocation(invocation: CliInvocation | undefined): CliInvocation | undefined {
  if (invocation === undefined) return undefined;
  const command = invocation.command;
  const output = invocation.output;
  const nonInteractive = invocation.nonInteractive;
  const inputSource = invocation.inputSource;
  const requestId = invocation.requestId;
  if (
    typeof command !== "string" ||
    (output !== "text" && output !== "json" && output !== "jsonl") ||
    typeof nonInteractive !== "boolean" ||
    (inputSource !== undefined && typeof inputSource !== "string") ||
    (requestId !== undefined && typeof requestId !== "string")
  ) {
    throw new TypeError("Invalid classified CLI invocation");
  }
  return {
    command,
    output,
    nonInteractive,
    ...(inputSource === undefined ? {} : { inputSource }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

function setExitCode(code: CliExitCode): void {
  process.exitCode = code === CLI_EXIT_CODE.SUCCESS ? undefined : code;
}
