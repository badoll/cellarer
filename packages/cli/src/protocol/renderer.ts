import type { CliError, CliEvent, CliWarning } from "@cellarer/core";
import { getDefaultCliCommandCatalog } from "../commands/command-catalog.js";
import type { CommandDefinition } from "./command-types.js";
import type { CLI_EXIT_CODE, CliExitCode } from "./exit-mapper.js";

export { safeInternalFailureDiagnostic } from "./internal-failure.js";

export type MachineOutput = "json" | "jsonl";

export type CommandRendererDefinition = Pick<
  CommandDefinition,
  "command" | "outputSchema" | "eventSchema"
>;

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
  success<TData>(data: TData, warnings?: readonly CliWarning[], context?: unknown): CliExitCode;
  failure<TData = never>(
    error: CliError,
    warnings?: readonly CliWarning[],
    data?: TData,
    context?: unknown,
  ): CliExitCode;
  internalFailure(error: unknown): typeof CLI_EXIT_CODE.INTERNAL;
  diagnostic(message: string, context?: unknown): void;
}

export function createProtocolRenderer(options: ProtocolRendererOptions): ProtocolRenderer {
  return getDefaultCliCommandCatalog().createProtocolRenderer(options);
}
