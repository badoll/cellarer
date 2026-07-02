import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/program.js";

describe("cli program wiring", () => {
  it("registers all commands (M4 + add)", () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual(
      [
        "add",
        "agents",
        "apply",
        "doctor",
        "init",
        "ls",
        "revert",
        "scan",
        "secret",
        "status",
        "ui",
      ].sort(),
    );
  });

  it("add exposes source arg and --force flag", () => {
    const program = buildProgram();
    const addCmd = program.commands.find((c) => c.name() === "add");
    expect(addCmd).toBeDefined();
    expect(addCmd?.options.map((o) => o.long)).toContain("--force");
  });

  it("scan exposes conflict/select/dry-run/json flags", () => {
    const program = buildProgram();
    const scan = program.commands.find((c) => c.name() === "scan");
    const flags = scan?.options.map((o) => o.long) ?? [];
    const shortFlags = scan?.options.map((o) => o.short) ?? [];
    expect(flags).toContain("--agent");
    expect(shortFlags).toContain("-a");
    expect(flags).toContain("--conflict");
    expect(flags).toContain("--select");
    expect(flags).toContain("--dry-run");
    expect(flags).toContain("--json");
  });

  it("apply exposes mcp/skills/secret-mode flags", () => {
    const program = buildProgram();
    const apply = program.commands.find((c) => c.name() === "apply");
    const flags = apply?.options.map((o) => o.long) ?? [];
    const shortFlags = apply?.options.map((o) => o.short) ?? [];
    expect(flags).toContain("--agent");
    expect(shortFlags).toContain("-a");
    expect(flags).toContain("--mcp");
    expect(flags).toContain("--skills");
    expect(flags).toContain("--mcp-overwrite");
    expect(flags).toContain("--secret-mode");
  });

  it("status/revert expose -a agent aliases", () => {
    const program = buildProgram();
    for (const name of ["status", "revert"]) {
      const command = program.commands.find((c) => c.name() === name);
      const flags = command?.options.map((o) => o.long) ?? [];
      const shortFlags = command?.options.map((o) => o.short) ?? [];
      expect(flags).toContain("--agent");
      expect(shortFlags).toContain("-a");
    }
  });

  it("agents and doctor expose agent/dir/json flags", () => {
    const program = buildProgram();
    for (const name of ["agents", "doctor"]) {
      const command = program.commands.find((c) => c.name() === name);
      const flags = command?.options.map((o) => o.long) ?? [];
      const shortFlags = command?.options.map((o) => o.short) ?? [];
      expect(flags).toContain("--agent");
      expect(flags).toContain("--dir");
      expect(flags).toContain("--json");
      expect(shortFlags).toContain("-a");
    }
  });

  it("secret subcommand has add/ls/rm", () => {
    const program = buildProgram();
    const secret = program.commands.find((c) => c.name() === "secret");
    const subs = secret?.commands.map((c) => c.name()).sort() ?? [];
    expect(subs).toEqual(["add", "ls", "rm"]);
  });
});
