import type { CliErrorCode } from "./client-types.js";

export type { CliErrorCode } from "./client-types.js";

export const CLI_PROTOCOL_VERSION = "1.0" as const;

export type CliProtocolVersion = typeof CLI_PROTOCOL_VERSION;

export interface CliWarning {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CliError {
  readonly code: CliErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CliCommandRequest<TInput = unknown> {
  readonly protocolVersion: CliProtocolVersion;
  readonly command: string;
  readonly requestId?: string;
  readonly input: TInput;
}

interface CliResultEnvelopeBase {
  readonly protocolVersion: CliProtocolVersion;
  readonly command: string;
  readonly requestId: string;
  readonly warnings: readonly CliWarning[];
}

export interface CliSuccessResultEnvelope<TData = unknown> extends CliResultEnvelopeBase {
  readonly status: "success";
  readonly data: TData;
  readonly error?: never;
}

export interface CliErrorResultEnvelope<TData = never> extends CliResultEnvelopeBase {
  readonly status: "error";
  readonly data?: TData;
  readonly error: CliError;
}

export type CliResultEnvelope<TData = unknown, TErrorData = never> =
  | CliSuccessResultEnvelope<TData>
  | CliErrorResultEnvelope<TErrorData>;

export interface CliEvent<TData = unknown> {
  readonly code: string;
  readonly data: TData;
}

export interface CliEventEnvelope<TData = unknown> {
  readonly protocolVersion: CliProtocolVersion;
  readonly command: string;
  readonly requestId: string;
  readonly sequence: number;
  readonly event: CliEvent<TData>;
}

export type CliProtocolRecord<TData = unknown, TErrorData = never> =
  | CliEventEnvelope
  | CliResultEnvelope<TData, TErrorData>;
