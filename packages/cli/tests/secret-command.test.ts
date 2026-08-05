import { describe, expect, it, vi } from "vitest";
import {
  readProtectedPassphraseInput,
  readProtectedSecretInput,
  secretCommand,
} from "../src/commands/secret.js";

describe("secret command protected input", () => {
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
});
