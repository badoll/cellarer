import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/program.js";

describe("cli program wiring", () => {
  it("registers all M3 commands", () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["apply", "init", "ls", "revert", "scan", "secret", "status"].sort());
  });

  it("scan exposes conflict/select/dry-run/json flags", () => {
    const program = buildProgram();
    const scan = program.commands.find((c) => c.name() === "scan");
    const flags = scan?.options.map((o) => o.long) ?? [];
    expect(flags).toContain("--conflict");
    expect(flags).toContain("--select");
    expect(flags).toContain("--dry-run");
    expect(flags).toContain("--json");
  });

  it("apply exposes mcp/skills/secret-mode flags", () => {
    const program = buildProgram();
    const apply = program.commands.find((c) => c.name() === "apply");
    const flags = apply?.options.map((o) => o.long) ?? [];
    expect(flags).toContain("--mcp");
    expect(flags).toContain("--skills");
    expect(flags).toContain("--mcp-overwrite");
    expect(flags).toContain("--secret-mode");
  });

  it("secret subcommand has add/ls/rm", () => {
    const program = buildProgram();
    const secret = program.commands.find((c) => c.name() === "secret");
    const subs = secret?.commands.map((c) => c.name()).sort() ?? [];
    expect(subs).toEqual(["add", "ls", "rm"]);
  });
});
