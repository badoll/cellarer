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
import { serializeCliOutput } from "../output.js";
import { isPublicProtocolSchemaBundle } from "./command-registry.js";
import { CLI_EXIT_CODE, type CliExitCode, exitCodeForError } from "./exit-mapper.js";
import { resolveRequestId } from "./request-id.js";

export type MachineOutput = "json" | "jsonl";

export interface ProtocolRendererOptions {
  readonly command: string;
  readonly output: MachineOutput;
  readonly requestId?: string;
  readonly createUuid?: () => string;
  readonly stdout?: (chunk: string) => void;
  readonly stderr?: (chunk: string) => void;
}

export interface ProtocolRenderer {
  readonly command: string;
  readonly output: MachineOutput;
  readonly requestId: string;
  readonly terminalEmitted: boolean;
  event<TData>(event: CliEvent<TData>): void;
  success<TData>(
    data: TData,
    warnings?: readonly CliWarning[],
    context?: unknown,
  ): typeof CLI_EXIT_CODE.SUCCESS;
  failure<TData = never>(
    error: CliError,
    warnings?: readonly CliWarning[],
    data?: TData,
    context?: unknown,
  ): CliExitCode;
  internalFailure(error: unknown): typeof CLI_EXIT_CODE.INTERNAL;
  diagnostic(message: string, context?: unknown): void;
}

const INTERNAL_FAILURE_DIAGNOSTIC = "Unexpected internal failure";

export function safeInternalFailureDiagnostic(error: unknown): string {
  try {
    const diagnostic = diagnosticTextFromUnknown(error);
    const context = safeDiagnosticContext(error, diagnostic);
    return redactSafeObservableText(context, diagnostic);
  } catch {
    return INTERNAL_FAILURE_DIAGNOSTIC;
  }
}

export function createProtocolRenderer(options: ProtocolRendererOptions): ProtocolRenderer {
  const stdout = options.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = options.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const requestId = resolveRequestId(options.requestId, options.createUuid);
  let sequence = 0;
  let didEmitTerminal = false;

  const ensureOpen = (): void => {
    if (didEmitTerminal) throw new Error("protocol terminal result has already been emitted");
  };

  const writeRecord = (
    record: unknown,
    context: unknown = record,
    trustedPublicSchema = false,
  ): void => {
    stdout(
      `${trustedPublicSchema ? JSON.stringify(record) : serializeCliOutput(record, false, context)}\n`,
    );
  };

  return {
    command: options.command,
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
        command: options.command,
        requestId,
        sequence: ++sequence,
        event,
      };
      writeRecord(envelope);
    },
    success<TData>(
      data: TData,
      warnings: readonly CliWarning[] = [],
      context: unknown = data,
    ): typeof CLI_EXIT_CODE.SUCCESS {
      ensureOpen();
      const envelope: CliSuccessResultEnvelope<TData> = {
        protocolVersion: CLI_PROTOCOL_VERSION,
        command: options.command,
        requestId,
        status: "success",
        data,
        warnings,
      };
      writeRecord(
        envelope,
        context,
        options.command === "schema" && isPublicProtocolSchemaBundle(data),
      );
      didEmitTerminal = true;
      return CLI_EXIT_CODE.SUCCESS;
    },
    failure<TData = never>(
      error: CliError,
      warnings: readonly CliWarning[] = [],
      data?: TData,
      context: unknown = data ?? error,
    ): CliExitCode {
      ensureOpen();
      const envelope: CliErrorResultEnvelope<TData> = {
        protocolVersion: CLI_PROTOCOL_VERSION,
        command: options.command,
        requestId,
        status: "error",
        ...(data === undefined ? {} : { data }),
        warnings,
        error,
      };
      writeRecord(envelope, context);
      didEmitTerminal = true;
      return exitCodeForError(error);
    },
    internalFailure(error: unknown): typeof CLI_EXIT_CODE.INTERNAL {
      this.diagnostic(safeInternalFailureDiagnostic(error));
      return this.failure({
        code: "INTERNAL_ERROR",
        message: INTERNAL_FAILURE_DIAGNOSTIC,
      }) as typeof CLI_EXIT_CODE.INTERNAL;
    },
    diagnostic(message: string, context: unknown = message): void {
      stderr(`${redactSafeObservableText(context, message)}\n`);
    },
  };
}

function diagnosticTextFromUnknown(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack;
    if (typeof stack === "string" && stack.length > 0) return stack;
    const message = error.message;
    return typeof message === "string" && message.length > 0
      ? message
      : INTERNAL_FAILURE_DIAGNOSTIC;
  }
  const diagnostic = String(error);
  return diagnostic.length > 0 ? diagnostic : INTERNAL_FAILURE_DIAGNOSTIC;
}

function safeDiagnosticContext(error: unknown, diagnostic: string): unknown {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") {
    return diagnostic;
  }
  const context: Record<PropertyKey, unknown> = {};
  for (const key of Object.getOwnPropertySymbols(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (!descriptor || !("value" in descriptor)) continue;
    Object.defineProperty(context, key, { value: descriptor.value });
  }
  return context;
}
