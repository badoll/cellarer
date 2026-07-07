import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("add exposes remote import selection flags", () => {
    const program = buildProgram();
    const addCmd = program.commands.find((c) => c.name() === "add");
    expect(addCmd).toBeDefined();
    const flags = addCmd?.options.map((o) => o.long) ?? [];
    expect(flags).toContain("--force");
    expect(flags).toContain("--list");
    expect(flags).toContain("--skill");
    expect(flags).toContain("--all");
    expect(flags).toContain("--collection");
    expect(flags.some((flag) => /^--c(?:hannel)$/.test(flag))).toBe(false);
    expect(flags).toContain("--yes");
    expect(flags).toContain("--json");
  });

  it("add --list --json prints parseable candidates without writing store", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-cli-test-")));
    const oldHome = process.env.CELLARER_HOME;
    const oldExit = process.exitCode;
    const logs: string[] = [];
    const oldLog = console.log;
    const oldError = console.error;
    try {
      process.exitCode = undefined;
      process.env.CELLARER_HOME = join(root, "cellarer-home");
      console.log = (message?: unknown) => {
        logs.push(String(message));
      };
      console.error = (message?: unknown) => {
        logs.push(String(message));
      };
      await writeSkill(root, "repo/skills/alpha", "alpha", "Alpha skill");

      const program = buildProgram();
      await program.parseAsync(
        ["node", "cellarer", "add", join(root, "repo"), "--list", "--json"],
        {
          from: "node",
        },
      );

      const report = JSON.parse(logs.join("\n"));
      expect(report.candidates.map((c: { name: string }) => c.name)).toEqual(["alpha"]);
      await expect(
        fs.stat(join(root, "cellarer-home", "store", "skills", "alpha")),
      ).rejects.toThrow();
    } finally {
      console.log = oldLog;
      console.error = oldError;
      process.exitCode = oldExit;
      if (oldHome === undefined) delete process.env.CELLARER_HOME;
      else process.env.CELLARER_HOME = oldHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("add reports conflicting --skill/--all flags", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-cli-test-")));
    const oldHome = process.env.CELLARER_HOME;
    const oldExit = process.exitCode;
    const errors: string[] = [];
    const oldError = console.error;
    const oldLog = console.log;
    try {
      process.exitCode = undefined;
      process.env.CELLARER_HOME = join(root, "cellarer-home");
      console.error = (message?: unknown) => {
        errors.push(String(message));
      };
      console.log = () => {};
      await writeSkill(root, "repo/skills/alpha", "alpha", "Alpha skill");

      const program = buildProgram();
      await program.parseAsync(
        ["node", "cellarer", "add", join(root, "repo"), "--skill", "alpha", "--all"],
        { from: "node" },
      );

      expect(process.exitCode).toBe(1);
      expect(errors.join("\n")).toMatch(/--skill and --all are mutually exclusive/);
    } finally {
      console.error = oldError;
      console.log = oldLog;
      process.exitCode = oldExit;
      if (oldHome === undefined) delete process.env.CELLARER_HOME;
      else process.env.CELLARER_HOME = oldHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("scan exposes conflict/select/dry-run/json flags", () => {
    const program = buildProgram();
    const scan = program.commands.find((c) => c.name() === "scan");
    const flags = scan?.options.map((o) => o.long) ?? [];
    const shortFlags = scan?.options.map((o) => o.short) ?? [];
    expect(flags).toContain("--agent");
    expect(shortFlags).toContain("-a");
    expect(flags).toContain("--conflict");
    expect(flags).toContain("--into-collection");
    expect(flags.some((flag) => /^--into-c(?:hannel)$/.test(flag))).toBe(false);
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

async function writeSkill(
  root: string,
  rel: string,
  name: string,
  description: string,
): Promise<void> {
  const dir = join(root, rel);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
    "utf8",
  );
}
