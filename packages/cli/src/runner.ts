import type { Command } from "commander";
import { buildProgram } from "./program.js";
import { commandRegistry } from "./protocol/command-registry.js";
import { handleCliRunnerBoundaryError } from "./protocol/execution.js";
import type { CliInvocation, CliOutput } from "./protocol/input.js";

export async function runCli(argv: readonly string[] = process.argv): Promise<void> {
  let invocation = fallbackInvocationFromArgv(argv);

  try {
    invocation = invocationFromArgv(argv);
    const program = buildProgram();
    configureParseBoundary(program, invocation.output !== "text");
    await program.parseAsync([...argv], { from: "node" });
  } catch (error) {
    handleCliRunnerBoundaryError(error, invocation);
  }
}

function configureParseBoundary(command: Command, machine: boolean): void {
  command.exitOverride();
  if (machine) command.configureOutput({ writeErr: () => {} });
  for (const child of command.commands) {
    configureParseBoundary(child, machine);
  }
}

function invocationFromArgv(argv: readonly string[]): CliInvocation {
  return invocationFromArgs(argv.slice(2), !process.stdin.isTTY);
}

function fallbackInvocationFromArgv(argv: readonly string[]): CliInvocation {
  try {
    return invocationFromArgs(argv.slice(2), false);
  } catch {
    return { command: "cellarer", output: "text", nonInteractive: false };
  }
}

function invocationFromArgs(
  args: readonly string[],
  stdinIsNonInteractive: boolean,
): CliInvocation {
  const transportArgs = args.slice(0, args.indexOf("--") === -1 ? args.length : args.indexOf("--"));
  const explicitOutput = outputFromArgv(transportArgs);
  const output = explicitOutput ?? (transportArgs.includes("--json") ? "json" : "text");
  return {
    command: commandFromArgv(transportArgs),
    output,
    nonInteractive:
      output !== "text" || transportArgs.includes("--non-interactive") || stdinIsNonInteractive,
  };
}

function outputFromArgv(args: readonly string[]): CliOutput | undefined {
  let output: CliOutput | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const candidate =
      arg === "--output"
        ? args[index + 1]
        : arg?.startsWith("--output=")
          ? arg.slice(9)
          : undefined;
    if (candidate === "text" || candidate === "json" || candidate === "jsonl") output = candidate;
  }
  return output;
}

function commandFromArgv(args: readonly string[]): string {
  const rootPosition = findRootCommandPosition(args);
  if (rootPosition === undefined) return "cellarer";
  const root = args[rootPosition] as string;
  const candidates = commandRegistry
    .map(({ command }) => command.split("."))
    .filter(([candidateRoot]) => candidateRoot === root);
  if (candidates.length === 0) return root;
  if (candidates.some((parts) => parts.length === 1)) return root;

  const identity = [root];
  let index = rootPosition + 1;
  while (index < args.length) {
    const skipped = skipTransportOption(args, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    const part = args[index] as string;
    if (part.startsWith("-")) break;
    const nextIdentity = [...identity, part];
    const matching = candidates.filter((parts) =>
      nextIdentity.every((value, partIndex) => parts[partIndex] === value),
    );
    if (matching.length === 0) break;
    identity.push(part);
    if (matching.some((parts) => parts.length === identity.length)) break;
    index += 1;
  }
  return identity.join(".");
}

function findRootCommandPosition(args: readonly string[]): number | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const skipped = skipTransportOption(args, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    const arg = args[index] as string;
    if (!arg.startsWith("-")) return index;
  }
  return undefined;
}

function skipTransportOption(args: readonly string[], index: number): number {
  const arg = args[index];
  if (arg === "--output" || arg === "--input") return Math.min(index + 2, args.length);
  if (
    arg === "--non-interactive" ||
    arg === "--json" ||
    arg?.startsWith("--output=") ||
    arg?.startsWith("--input=")
  ) {
    return index + 1;
  }
  return index;
}
