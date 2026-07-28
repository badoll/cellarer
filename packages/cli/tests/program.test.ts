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

  it("apply exposes ownership acknowledgement, snapshot, and JSON flags", () => {
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
    expect(flags).toContain("--replace-unowned");
    expect(flags).toContain("--override-drift");
    expect(flags).toContain("--snapshot-passphrase");
    expect(flags).toContain("--json");
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
    const revert = program.commands.find((c) => c.name() === "revert");
    const revertFlags = revert?.options.map((o) => o.long) ?? [];
    expect(revertFlags).toContain("--acknowledge");
    expect(revertFlags).toContain("--snapshot-passphrase");
    expect(revertFlags).toContain("--json");
  });

  it("apply JSON reports blocked conflicts, exits nonzero, and accepts exact replacement inputs", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-cli-test-")));
    const storeRoot = join(root, "cellarer-home");
    const project = join(root, "project");
    const target = join(project, "CLAUDE.md");
    const oldHome = process.env.CELLARER_HOME;
    const oldExit = process.exitCode;
    const oldLog = console.log;
    const oldError = console.error;
    const oldWarn = console.warn;
    let logs: string[] = [];
    try {
      process.env.CELLARER_HOME = storeRoot;
      console.log = (message?: unknown) => logs.push(String(message));
      console.error = () => {};
      console.warn = () => {};
      await fs.mkdir(join(storeRoot, "store", "rules"), { recursive: true });
      await fs.mkdir(join(storeRoot, "store", "mcp"), { recursive: true });
      await fs.mkdir(join(storeRoot, "store", "skills"), { recursive: true });
      await fs.mkdir(project, { recursive: true });
      await fs.writeFile(join(storeRoot, "store", "rules", "style.md"), "# managed", "utf8");
      await fs.writeFile(target, "user-owned", "utf8");

      process.exitCode = undefined;
      await buildProgram().parseAsync(
        [
          "node",
          "cellarer",
          "apply",
          "--agent",
          "claude-code",
          "--dir",
          project,
          "--rules",
          "--dry-run",
          "--json",
        ],
        { from: "node" },
      );
      expect(process.exitCode).toBe(1);
      const blocked = JSON.parse(logs.join("\n"));
      expect(blocked.plan.conflicts[0]).toMatchObject({
        code: "UNOWNED_TARGET",
        acknowledgement: { kind: "replace-unowned" },
      });
      const replacement = blocked.plan.conflicts[0].acknowledgement.token as string;

      logs = [];
      process.exitCode = undefined;
      await buildProgram().parseAsync(
        [
          "node",
          "cellarer",
          "apply",
          "--agent",
          "claude-code",
          "--dir",
          project,
          "--rules",
          "--replace-unowned",
          replacement,
          "--snapshot-passphrase",
          "cli-snapshot-passphrase",
          "--json",
        ],
        { from: "node" },
      );
      expect(process.exitCode).toBeUndefined();
      expect(JSON.parse(logs.join("\n")).entries).toHaveLength(1);
      expect(await fs.readFile(target, "utf8")).toContain("# managed");

      await fs.writeFile(target, "user drift", "utf8");
      logs = [];
      process.exitCode = undefined;
      await buildProgram().parseAsync(
        [
          "node",
          "cellarer",
          "apply",
          "--agent",
          "claude-code",
          "--dir",
          project,
          "--rules",
          "--dry-run",
          "--json",
        ],
        { from: "node" },
      );
      expect(process.exitCode).toBe(1);
      const drifted = JSON.parse(logs.join("\n"));
      expect(drifted.plan.conflicts[0].code).toBe("OWNED_TARGET_DRIFTED");
      const override = drifted.plan.conflicts[0].acknowledgement.token as string;

      logs = [];
      process.exitCode = undefined;
      await buildProgram().parseAsync(
        [
          "node",
          "cellarer",
          "apply",
          "--agent",
          "claude-code",
          "--dir",
          project,
          "--rules",
          "--override-drift",
          override,
          "--snapshot-passphrase",
          "cli-snapshot-passphrase",
          "--json",
        ],
        { from: "node" },
      );
      expect(process.exitCode).toBeUndefined();
      expect(JSON.parse(logs.join("\n")).entries).toHaveLength(1);
    } finally {
      console.log = oldLog;
      console.error = oldError;
      console.warn = oldWarn;
      process.exitCode = oldExit;
      if (oldHome === undefined) delete process.env.CELLARER_HOME;
      else process.env.CELLARER_HOME = oldHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("apply --json does not print an ownership-blocked MCP merge containing existing secrets", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-cli-test-")));
    const storeRoot = join(root, "cellarer-home");
    const project = join(root, "project");
    const oldHome = process.env.CELLARER_HOME;
    const oldExit = process.exitCode;
    const oldLog = console.log;
    const oldError = console.error;
    const oldWarn = console.warn;
    const logs: string[] = [];
    try {
      process.env.CELLARER_HOME = storeRoot;
      process.exitCode = undefined;
      console.log = (message?: unknown) => logs.push(String(message));
      console.error = () => {};
      console.warn = () => {};
      await fs.mkdir(join(storeRoot, "store", "rules"), { recursive: true });
      await fs.mkdir(join(storeRoot, "store", "mcp"), { recursive: true });
      await fs.mkdir(join(storeRoot, "store", "skills"), { recursive: true });
      await fs.mkdir(project, { recursive: true });
      await fs.writeFile(
        join(storeRoot, "store", "mcp", "managed.json"),
        JSON.stringify({ kind: "stdio", command: "managed" }),
        "utf8",
      );
      await fs.writeFile(
        join(project, ".mcp.json"),
        JSON.stringify({
          password: "ordinary-password",
          mcpServers: {
            existing: {
              command: "existing",
              metadata: { credentials: { token: "nested-ordinary-token" } },
            },
          },
        }),
        "utf8",
      );

      await buildProgram().parseAsync(
        [
          "node",
          "cellarer",
          "apply",
          "--agent",
          "claude-code",
          "--dir",
          project,
          "--mcp",
          "--dry-run",
          "--json",
        ],
        { from: "node" },
      );

      const output = logs.join("\n");
      expect(process.exitCode).toBe(1);
      expect(output).not.toContain("ordinary-password");
      expect(output).not.toContain("nested-ordinary-token");
      const body = JSON.parse(output);
      expect(body.plan.actions[0]).toMatchObject({
        op: "skip",
        ownership: { classification: "unowned-existing" },
      });
      expect(body.plan.actions[0].preview).toBeUndefined();
    } finally {
      console.log = oldLog;
      console.error = oldError;
      console.warn = oldWarn;
      process.exitCode = oldExit;
      if (oldHome === undefined) delete process.env.CELLARER_HOME;
      else process.env.CELLARER_HOME = oldHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("apply and revert JSON keep duplicate-owner state blocked and unchanged", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-cli-test-")));
    const storeRoot = join(root, "cellarer-home");
    const project = join(root, "project");
    const target = join(project, "CLAUDE.md");
    const statePath = join(storeRoot, "state.json");
    const oldHome = process.env.CELLARER_HOME;
    const oldExit = process.exitCode;
    const oldLog = console.log;
    const oldError = console.error;
    const oldWarn = console.warn;
    let logs: string[] = [];
    try {
      process.env.CELLARER_HOME = storeRoot;
      console.log = (message?: unknown) => logs.push(String(message));
      console.error = () => {};
      console.warn = () => {};
      for (const sub of ["rules", "mcp", "skills"]) {
        await fs.mkdir(join(storeRoot, "store", sub), { recursive: true });
      }
      await fs.mkdir(project, { recursive: true });
      await fs.writeFile(join(storeRoot, "store", "rules", "style.md"), "# managed", "utf8");

      process.exitCode = undefined;
      await buildProgram().parseAsync(
        [
          "node",
          "cellarer",
          "apply",
          "--agent",
          "claude-code",
          "--dir",
          project,
          "--rules",
          "--json",
        ],
        { from: "node" },
      );
      expect(process.exitCode).toBeUndefined();
      const targetBefore = await fs.readFile(target, "utf8");
      const ledger = JSON.parse(await fs.readFile(statePath, "utf8"));
      const owner = ledger.owners[0];
      ledger.owners.push({ ...owner, artifactIds: ["rules/duplicate"] });
      const duplicateState = JSON.stringify(ledger);
      await fs.writeFile(statePath, duplicateState, "utf8");

      logs = [];
      process.exitCode = undefined;
      await buildProgram().parseAsync(
        [
          "node",
          "cellarer",
          "apply",
          "--agent",
          "claude-code",
          "--dir",
          project,
          "--rules",
          "--json",
        ],
        { from: "node" },
      );
      expect(process.exitCode).toBe(1);
      const applyBody = JSON.parse(logs.join("\n"));
      expect(applyBody.entries).toEqual([]);
      expect(applyBody.plan.conflicts[0]).toMatchObject({ code: "INVALID_TARGET_OWNER" });
      expect(await fs.readFile(target, "utf8")).toBe(targetBefore);
      expect(await fs.readFile(statePath, "utf8")).toBe(duplicateState);

      logs = [];
      process.exitCode = undefined;
      await buildProgram().parseAsync(["node", "cellarer", "revert", "--dir", project, "--json"], {
        from: "node",
      });
      expect(process.exitCode).toBe(1);
      const revertBody = JSON.parse(logs.join("\n"));
      expect(revertBody.reverted).toEqual([]);
      expect(revertBody.plan.conflicts[0]).toMatchObject({ code: "INVALID_TARGET_OWNER" });
      expect(await fs.readFile(target, "utf8")).toBe(targetBefore);
      expect(await fs.readFile(statePath, "utf8")).toBe(duplicateState);
    } finally {
      console.log = oldLog;
      console.error = oldError;
      console.warn = oldWarn;
      process.exitCode = oldExit;
      if (oldHome === undefined) delete process.env.CELLARER_HOME;
      else process.env.CELLARER_HOME = oldHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("blocks apply on an unselected duplicate but selectively reverts a valid owner in JSON", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-cli-test-")));
    const storeRoot = join(root, "cellarer-home");
    const project = join(root, "project");
    const statePath = join(storeRoot, "state.json");
    const oldHome = process.env.CELLARER_HOME;
    const oldExit = process.exitCode;
    const oldLog = console.log;
    const oldError = console.error;
    const oldWarn = console.warn;
    let logs: string[] = [];
    try {
      process.env.CELLARER_HOME = storeRoot;
      console.log = (message?: unknown) => logs.push(String(message));
      console.error = () => {};
      console.warn = () => {};
      for (const sub of ["rules", "mcp", "skills"]) {
        await fs.mkdir(join(storeRoot, "store", sub), { recursive: true });
      }
      await fs.mkdir(project, { recursive: true });
      await fs.writeFile(join(storeRoot, "store", "rules", "style.md"), "# managed", "utf8");
      await fs.mkdir(join(storeRoot, "store", "skills", "demo"), { recursive: true });
      await fs.writeFile(
        join(storeRoot, "store", "skills", "demo", "SKILL.md"),
        "# managed skill",
        "utf8",
      );

      process.exitCode = undefined;
      await buildProgram().parseAsync(
        [
          "node",
          "cellarer",
          "apply",
          "--agent",
          "claude-code",
          "--dir",
          project,
          "--rules",
          "--json",
        ],
        { from: "node" },
      );
      logs = [];
      process.exitCode = undefined;
      await buildProgram().parseAsync(
        ["node", "cellarer", "apply", "--agent", "codex", "--dir", project, "--skills", "--json"],
        { from: "node" },
      );
      const ledger = JSON.parse(await fs.readFile(statePath, "utf8"));
      const ruleOwner = ledger.owners.find(
        (owner: { capability: string }) => owner.capability === "rules",
      );
      const skillOwner = ledger.owners.find(
        (owner: { capability: string }) => owner.capability === "skills",
      );
      if (!ruleOwner || !skillOwner) throw new Error("expected Rules and Skill owners");
      const duplicateRule = { ...ruleOwner, artifactIds: ["rules/duplicate"] };
      const duplicateState = JSON.stringify({
        ...ledger,
        owners: [ruleOwner, duplicateRule, skillOwner],
      });
      await fs.writeFile(statePath, duplicateState, "utf8");

      logs = [];
      process.exitCode = undefined;
      await buildProgram().parseAsync(
        ["node", "cellarer", "apply", "--agent", "codex", "--dir", project, "--skills", "--json"],
        { from: "node" },
      );
      expect(process.exitCode).toBe(1);
      const applyBody = JSON.parse(logs.join("\n"));
      expect(applyBody.entries).toEqual([]);
      expect(applyBody.plan.invalidLedger).toBe(true);
      expect(applyBody.plan.actions[0]).toMatchObject({
        capability: "skills",
        ownership: { classification: "owned-current" },
      });
      expect(applyBody.plan.conflicts).toContainEqual(
        expect.objectContaining({ code: "INVALID_TARGET_OWNER", target: ruleOwner.target }),
      );
      expect(await fs.readFile(statePath, "utf8")).toBe(duplicateState);

      logs = [];
      process.exitCode = undefined;
      await buildProgram().parseAsync(
        ["node", "cellarer", "revert", "--agent", "codex", "--dir", project, "--dry-run", "--json"],
        { from: "node" },
      );
      const dryRun = JSON.parse(logs.join("\n"));
      expect(dryRun.reverted).toEqual([skillOwner]);
      expect(await fs.readFile(statePath, "utf8")).toBe(duplicateState);

      logs = [];
      process.exitCode = undefined;
      await buildProgram().parseAsync(
        ["node", "cellarer", "revert", "--agent", "codex", "--dir", project, "--json"],
        { from: "node" },
      );
      expect(process.exitCode).toBeUndefined();
      const reverted = JSON.parse(logs.join("\n"));
      expect(reverted.reverted).toEqual([skillOwner]);
      expect(JSON.parse(await fs.readFile(statePath, "utf8")).owners).toEqual([
        ruleOwner,
        duplicateRule,
      ]);
    } finally {
      console.log = oldLog;
      console.error = oldError;
      console.warn = oldWarn;
      process.exitCode = oldExit;
      if (oldHome === undefined) delete process.env.CELLARER_HOME;
      else process.env.CELLARER_HOME = oldHome;
      await fs.rm(root, { recursive: true, force: true });
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
