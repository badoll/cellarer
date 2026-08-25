import type { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { createCliCommandCatalog } from "../src/commands/command-catalog.js";
import {
  readProtectedDescriptorInput,
  readProtectedPassphraseInput,
  readProtectedSecretInput,
} from "../src/commands/secret.js";
import { buildProgram } from "../src/program.js";
import { commandRegistry } from "../src/protocol/command-registry.js";
import { CliInputError } from "../src/protocol/input.js";

const SECURITY_COMMANDS = [
  "authority.rotate",
  "secret.add",
  "secret.ls",
  "secret.rm",
  "operation.recover",
] as const;

function secretCommand(): Command {
  return findLeaf(buildProgram(), "secret");
}

describe("secret command protected input", () => {
  it("drives secret, authority, and recovery leaves from parity-preserving contracts", () => {
    const catalog = createCliCommandCatalog();
    const contracts = catalog.contracts.filter(({ command }) =>
      SECURITY_COMMANDS.includes(command as (typeof SECURITY_COMMANDS)[number]),
    );

    expect(contracts.map(({ command }) => command)).toEqual(SECURITY_COMMANDS);
    const program = buildProgram();
    for (const contract of contracts) {
      const published = commandRegistry.find(({ command }) => command === contract.command);
      expect(published).toBeDefined();
      expect(protocolProjection(contract)).toEqual(
        protocolProjection(published as NonNullable<typeof published>),
      );
      expect(commanderProjection(findLeaf(program, contract.command))).toEqual(
        commanderProjection(contract.createCommand()),
      );
    }

    const add = contracts.find(({ command }) => command === "secret.add");
    const addInput = add?.inputSchema.properties?.input;
    const addOutput = add?.outputSchema.properties?.data;
    expect(addInput?.properties).not.toHaveProperty("value");
    expect(addInput?.properties).not.toHaveProperty("passphrase");
    expect(addOutput?.properties).not.toHaveProperty("value");
    expect(addOutput?.properties).not.toHaveProperty("passphrase");
    expect(
      findLeaf(program, "secret.add").registeredArguments.map((argument) => argument.name()),
    ).toEqual(["name"]);
  });

  it("does not register a positional value or value-bearing option", () => {
    const add = secretCommand().commands.find((command) => command.name() === "add");
    expect(add?.registeredArguments.map((argument) => argument.name())).toEqual(["name"]);
    expect(add?.options.map((option) => option.long)).not.toContain("--value");
    expect(add?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--stdin", "--fd", "--passphrase-fd"]),
    );
    expect(
      secretCommand().commands.flatMap((command) => command.options.map((option) => option.long)),
    ).not.toContain("--passphrase");
  });

  it("reads passphrases only from a hidden prompt or inherited descriptor", async () => {
    const io = {
      isInteractive: false,
      readDescriptor: vi.fn(async () => "protected-passphrase\n"),
      readHidden: vi.fn(async () => "hidden-passphrase"),
    };
    await expect(readProtectedPassphraseInput("5", io)).resolves.toBe("protected-passphrase");
    expect(io.readDescriptor).toHaveBeenCalledWith(5);
    await expect(readProtectedPassphraseInput(undefined, io)).rejects.toThrow(
      /inherited descriptor/,
    );

    const interactive = { ...io, isInteractive: true };
    await expect(readProtectedPassphraseInput(undefined, interactive)).resolves.toBe(
      "hidden-passphrase",
    );
    expect(interactive.readHidden).toHaveBeenCalledWith(false);
  });

  it.each([
    [
      "passphrase",
      (value: string, io: Parameters<typeof readProtectedPassphraseInput>[1]) =>
        readProtectedPassphraseInput(value, io),
    ],
    [
      "UI token",
      (value: string, io: Parameters<typeof readProtectedDescriptorInput>[2]) =>
        readProtectedDescriptorInput(value, { field: "tokenFd", label: "UI token" }, io),
    ],
  ] as const)("accepts only safe inherited descriptor numbers for %s input", async (_label, read) => {
    const io = {
      isInteractive: false,
      readDescriptor: vi.fn(async () => "protected-value\n"),
      readHidden: vi.fn(async () => "unused"),
    };

    await expect(read("3", io)).resolves.toBe("protected-value");
    await expect(read("2147483647", io)).resolves.toBe("protected-value");
    expect(io.readDescriptor).toHaveBeenNthCalledWith(1, 3);
    expect(io.readDescriptor).toHaveBeenNthCalledWith(2, 2_147_483_647);

    for (const value of ["2", "2147483648", "NaN", "Infinity", "3.5"]) {
      const error = await read(value, io).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(CliInputError);
      expect(error).toMatchObject({ cliError: { code: "INVALID_INPUT" } });
    }
    expect(io.readDescriptor).toHaveBeenCalledTimes(2);
  });

  it("reads an explicit stdin channel without echoing or returning it through diagnostics", async () => {
    const readDescriptor = vi.fn(async () => "  secret with spaces  \n");
    const readHidden = vi.fn(async () => "unused");
    const value = await readProtectedSecretInput(
      { stdin: true },
      { isInteractive: false, readDescriptor, readHidden },
    );
    expect(value).toBe("  secret with spaces  ");
    expect(readDescriptor).toHaveBeenCalledWith(0);
    expect(readHidden).not.toHaveBeenCalled();
  });

  it("reads an inherited descriptor and rejects ambiguous or unsafe descriptors", async () => {
    const io = {
      isInteractive: false,
      readDescriptor: vi.fn(async (fd: number) => (fd === 4 ? "fd-secret\r\n" : "unexpected")),
      readHidden: vi.fn(async () => "unused"),
    };
    await expect(readProtectedSecretInput({ fd: "4" }, io)).resolves.toBe("fd-secret");
    await expect(readProtectedSecretInput({ stdin: true, fd: "4" }, io)).rejects.toThrow(
      "exactly one",
    );
    await expect(readProtectedSecretInput({ fd: "0" }, io)).rejects.toThrow("inherited descriptor");
  });

  it("maps an expected descriptor read failure to typed invalid input", async () => {
    const descriptorError = Object.assign(new Error("descriptor-canary"), { code: "EBADF" });
    const io = {
      isInteractive: false,
      readDescriptor: vi.fn(async () => {
        throw descriptorError;
      }),
      readHidden: vi.fn(async () => "unused"),
    };

    const error = await readProtectedSecretInput({ fd: "9999" }, io).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(CliInputError);
    expect(error).toMatchObject({ cliError: { code: "INVALID_INPUT" } });
    expect(error).not.toHaveProperty("cliError.details.cause");
  });

  it("does not misclassify an unknown descriptor failure as invalid input", async () => {
    const unknownError = new Error("unknown-descriptor-failure");
    const io = {
      isInteractive: false,
      readDescriptor: vi.fn(async () => {
        throw unknownError;
      }),
      readHidden: vi.fn(async () => "unused"),
    };

    await expect(readProtectedSecretInput({ fd: "4" }, io)).rejects.toBe(unknownError);
  });

  it.each([
    [
      "passphrase",
      (io: Parameters<typeof readProtectedPassphraseInput>[1]) =>
        readProtectedPassphraseInput("4", io),
    ],
    [
      "UI token",
      (io: Parameters<typeof readProtectedDescriptorInput>[2]) =>
        readProtectedDescriptorInput("4", { field: "tokenFd", label: "UI token" }, io),
    ],
  ])("maps an expected %s descriptor failure to invalid input", async (_label, read) => {
    const descriptorError = Object.assign(new Error("descriptor-canary"), { code: "EBADF" });
    const io = {
      isInteractive: false,
      readDescriptor: vi.fn(async () => {
        throw descriptorError;
      }),
      readHidden: vi.fn(async () => "unused"),
    };

    const error = await read(io).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(CliInputError);
    expect(error).toMatchObject({ cliError: { code: "INVALID_INPUT" } });
    expect(error).not.toHaveProperty("cliError.details.cause");
  });

  it.each([
    [
      "passphrase",
      (io: Parameters<typeof readProtectedPassphraseInput>[1]) =>
        readProtectedPassphraseInput("4", io),
    ],
    [
      "UI token",
      (io: Parameters<typeof readProtectedDescriptorInput>[2]) =>
        readProtectedDescriptorInput("4", { field: "tokenFd", label: "UI token" }, io),
    ],
  ])("does not misclassify an unknown %s descriptor failure", async (_label, read) => {
    const unknownError = new Error("unknown-descriptor-failure");
    const io = {
      isInteractive: false,
      readDescriptor: vi.fn(async () => {
        throw unknownError;
      }),
      readHidden: vi.fn(async () => "unused"),
    };

    await expect(read(io)).rejects.toBe(unknownError);
  });

  it("uses hidden confirmed input only on an interactive terminal", async () => {
    const readHidden = vi.fn(async () => "interactive-secret");
    await expect(
      readProtectedSecretInput({}, { isInteractive: true, readDescriptor: vi.fn(), readHidden }),
    ).resolves.toBe("interactive-secret");
    expect(readHidden).toHaveBeenCalledWith(true);

    await expect(
      readProtectedSecretInput({}, { isInteractive: false, readDescriptor: vi.fn(), readHidden }),
    ).rejects.toThrow("--stdin or --fd");
  });

  it("never opens hidden prompts when non-interactive execution is explicit", async () => {
    const readHidden = vi.fn(async () => "must-not-be-read");
    const io = { isInteractive: true, readDescriptor: vi.fn(), readHidden };

    const secretError = await readProtectedSecretInput({}, io, { nonInteractive: true }).catch(
      (reason: unknown) => reason,
    );
    const passphraseError = await readProtectedPassphraseInput(undefined, io, {
      nonInteractive: true,
    }).catch((reason: unknown) => reason);

    expect(secretError).toBeInstanceOf(CliInputError);
    expect(secretError).toMatchObject({ cliError: { code: "INPUT_REQUIRED" } });
    expect(passphraseError).toBeInstanceOf(CliInputError);
    expect(passphraseError).toMatchObject({ cliError: { code: "INPUT_REQUIRED" } });
    expect(readHidden).not.toHaveBeenCalled();
  });
});

function protocolProjection(definition: (typeof commandRegistry)[number]) {
  return {
    command: definition.command,
    mutability: definition.mutability,
    streaming: definition.streaming,
    requiredFeatures: definition.requiredFeatures,
    inputSchemaId: definition.inputSchemaId,
    outputSchemaId: definition.outputSchemaId,
    eventSchemaId: definition.eventSchemaId,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    eventSchema: definition.eventSchema,
    inputBindings: definition.inputBindings,
  };
}

function commanderProjection(command: Command) {
  return {
    name: command.name(),
    description: command.description(),
    arguments: command.registeredArguments.map((argument) => ({
      name: argument.name(),
      description: argument.description,
      required: argument.required,
      variadic: argument.variadic,
    })),
    options: command.options.map((option) => ({
      flags: option.flags,
      description: option.description,
      mandatory: option.mandatory,
      variadic: option.variadic,
    })),
  };
}

function findLeaf(program: Command, path: string): Command {
  let current = program;
  for (const segment of path.split(".")) {
    const child = current.commands.find((candidate) => candidate.name() === segment);
    if (!child) throw new Error(`missing Commander path ${path}`);
    current = child;
  }
  return current;
}
