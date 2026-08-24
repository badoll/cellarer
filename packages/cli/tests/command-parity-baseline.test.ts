import { readFileSync } from "node:fs";
import type { CliErrorCode } from "@cellarer/core";
import type { Argument, Command, Option } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/program.js";
import { type CommandDefinition, commandRegistry } from "../src/protocol/command-registry.js";
import { CLI_EXIT_CODE, exitCodeForError } from "../src/protocol/exit-mapper.js";

describe("generated CLI parity baseline", () => {
  it("freezes the current executable and protocol leaf surface", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("./fixtures/command-surface-v1.json", import.meta.url), "utf8"),
    ) as unknown;

    expect(projectCommandSurface(buildProgram())).toEqual(fixture);
  });

  it("freezes typed error codes to public exit classes", () => {
    const expected = {
      INVALID_USAGE: CLI_EXIT_CODE.USAGE,
      INVALID_INPUT: CLI_EXIT_CODE.USAGE,
      INPUT_REQUIRED: CLI_EXIT_CODE.USAGE,
      INPUT_AMBIGUITY: CLI_EXIT_CODE.USAGE,
      POLICY_VIOLATION: CLI_EXIT_CODE.POLICY,
      DOMAIN_VALIDATION_FAILED: CLI_EXIT_CODE.POLICY,
      STALE_REVISION: CLI_EXIT_CODE.CONFLICT,
      LOCK_CONFLICT: CLI_EXIT_CODE.CONFLICT,
      TARGET_CONFLICT: CLI_EXIT_CODE.CONFLICT,
      EXECUTION_FAILED: CLI_EXIT_CODE.EXECUTION,
      PARTIAL_FAILURE: CLI_EXIT_CODE.EXECUTION,
      RECOVERY_REQUIRED: CLI_EXIT_CODE.RECOVERY,
      INTERNAL_ERROR: CLI_EXIT_CODE.INTERNAL,
    } as const satisfies Record<CliErrorCode, number>;

    expect(
      Object.fromEntries(
        Object.keys(expected).map((code) => [
          code,
          exitCodeForError({ code: code as CliErrorCode }),
        ]),
      ),
    ).toEqual(expected);
  });
});

function projectCommandSurface(program: Command) {
  const definitions = new Map<string, CommandDefinition>(
    commandRegistry.map((definition) => [definition.command, definition]),
  );
  const leaves = collectLeaves(program).sort((left, right) => left.path.localeCompare(right.path));

  return {
    fixtureVersion: 1,
    program: {
      name: program.name(),
      description: program.description(),
      version: program.version(),
      rootOrder: program.commands.map((command) => command.name()),
      options: program.options.map(projectOption),
    },
    protocolOrder: commandRegistry.map((definition) => definition.command),
    commands: leaves.map(({ path, command }) => {
      const definition = definitions.get(path);
      if (!definition) throw new Error(`missing protocol definition for ${path}`);
      return {
        path,
        aliases: command.aliases(),
        description: command.description(),
        arguments: command.registeredArguments.map(projectArgument),
        options: command.options.map(projectOption),
        protocol: {
          mutability: definition.mutability,
          streaming: definition.streaming,
          requiredFeatures: [...definition.requiredFeatures],
          inputSchemaId: definition.inputSchemaId,
          outputSchemaId: definition.outputSchemaId,
          eventSchemaId: definition.eventSchemaId ?? null,
          inputBindings: definition.inputBindings.map((binding) => ({
            field: binding.field,
            option: binding.option ?? null,
            positional: binding.positional ?? null,
            encoded: binding.encode !== undefined,
          })),
        },
      };
    }),
  };
}

function collectLeaves(
  command: Command,
  prefix = "",
): Array<{ readonly path: string; readonly command: Command }> {
  const leaves: Array<{ readonly path: string; readonly command: Command }> = [];
  for (const child of command.commands) {
    const path = prefix ? `${prefix}.${child.name()}` : child.name();
    if (child.commands.length === 0) leaves.push({ path, command: child });
    else leaves.push(...collectLeaves(child, path));
  }
  return leaves;
}

function projectArgument(argument: Argument) {
  return {
    name: argument.name(),
    description: argument.description,
    required: argument.required,
    variadic: argument.variadic,
    choices: argument.argChoices ?? null,
  };
}

function projectOption(option: Option) {
  return {
    flags: option.flags,
    attributeName: option.attributeName(),
    description: option.description,
    short: option.short ?? null,
    long: option.long ?? null,
    required: option.required,
    optional: option.optional,
    variadic: option.variadic,
    mandatory: option.mandatory,
    negate: option.negate,
    hidden: option.hidden,
    choices: option.argChoices ?? null,
  };
}
