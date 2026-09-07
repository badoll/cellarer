import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function runCompatibilityFixtures(coreRoot = join(repository, "packages/core")) {
  const core = await import(pathToFileURL(join(coreRoot, "dist/index.js")).href);
  const env = core.createRealEnv();
  const { loadCompatibility } = await import(
    pathToFileURL(join(coreRoot, "dist/adapters/compatibility.js")).href
  );
  const matrix = await loadCompatibility(env);
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cellarer-compatibility-")));
  try {
    const isolated = {
      ...env,
      homedir: () => join(root, "home"),
      cwd: () => join(root, "project"),
      env: {},
    };
    const registry = await core.loadRegistry(isolated, join(root, "store"));
    const examples = JSON.parse(
      await fs.readFile(join(coreRoot, "compatibility/fixtures/mcp-examples.json"), "utf8"),
    );
    const fixtureRoot = join(coreRoot, "compatibility/fixtures");
    const rules = await fs.readFile(join(fixtureRoot, "rules.md"), "utf8");
    const mdc = await fs.readFile(join(fixtureRoot, "rules.mdc"), "utf8");
    const skill = await fs.readFile(join(fixtureRoot, "skill.md"), "utf8");
    assert.match(skill, /^---\nname: sample\ndescription: .+\n---\n/);
    for (const directory of ["home", "project", "store/store/rules", "store/store/skills/sample"])
      await fs.mkdir(join(root, directory), { recursive: true });
    await fs.writeFile(join(root, "store/store/rules/sample.md"), rules);
    await fs.writeFile(join(root, "store/store/skills/sample/SKILL.md"), skill);
    const results = [];
    for (const cell of matrix.cells) {
      const adapter = registry.get(cell.agent);
      assert(adapter, `missing adapter ${cell.agent}`);
      const actual = adapter.paths(isolated, cell.scope)[
        cell.capability === "skills" ? "skillsDir" : cell.capability
      ];
      const expected = cell.location
        ?.replace("~/", `${isolated.homedir()}/`)
        .replace("{dir}", isolated.cwd());
      assert.equal(actual, expected, `${cell.agent}/${cell.capability}/${cell.scope}`);
      assert.equal(
        adapter.capabilities[cell.capability].includes(cell.scope),
        cell.evidence !== "unsupported",
      );
      if (cell.capability === "mcp" && cell.location) {
        const example =
          cell.agent === "codex"
            ? examples.codex
            : JSON.stringify(
                examples[
                  cell.agent === "opencode"
                    ? "opencode"
                    : cell.agent === "claude-code"
                      ? "claudeUser"
                      : "standard"
                ],
              );
        const decoded = adapter.mcp.codec.decode(example, adapter.mcp.serversKey);
        assert.equal(decoded.servers.sample.command, "sample-not-executed");
        assert.throws(() => adapter.mcp.codec.decode("{invalid", adapter.mcp.serversKey));
      }
      if (cell.capability === "rules" && cell.location) {
        const planned = await core.plan(
          isolated,
          {
            storeRoot: join(root, "store"),
            scope: cell.scope,
            dir: cell.scope === "project" ? isolated.cwd() : undefined,
            agents: [cell.agent],
            capabilities: ["rules"],
          },
          { providerAccess: "forbidden" },
        );
        assert.equal(planned.actions.length, 1);
        assert.equal(
          planned.actions[0].op,
          "write",
          `${cell.agent}/${cell.scope}: ${planned.actions[0].reason}`,
        );
        const rendered = planned.actions[0].preview.after;
        assert(rendered.includes(rules.trim()));
        if (cell.location.endsWith(".mdc"))
          assert(rendered.startsWith(mdc.slice(0, mdc.indexOf("# Project"))));
      }
      results.push({
        agent: cell.agent,
        capability: cell.capability,
        scope: cell.scope,
        fixture: "passed",
        native: "unknown",
        reason: "not-run",
      });
    }
    return { contractVersion: matrix.contractVersion, mode: "fixture-only", results };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

// Only this bounded parser probe has a reviewed execution recipe. It does not connect to MCP.
// No arbitrary command, cwd, environment, HOME or helper is accepted from fixture content.
export async function runNativeProbe({ agent, capability, scope, binary, version }) {
  const unavailable = (reason) => ({
    mode: "native",
    agent,
    capability,
    scope,
    native: "unknown",
    status: "unavailable",
    reason,
  });
  if (agent !== "codex" || capability !== "mcp" || !["global", "project"].includes(scope))
    return unavailable("no-isolated-recipe");
  if (!binary || !version) return unavailable("explicit-binary-and-version-required");
  if (process.platform !== "linux")
    return unavailable("filesystem-network-credential-isolation-unavailable");
  const sandbox = "/usr/bin/bwrap";
  try {
    await fs.access(sandbox);
    await fs.access(binary);
  } catch {
    return unavailable("binary-or-sandbox-unavailable");
  }
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cellarer-native-")));
  try {
    for (const dir of ["home/.codex", "project/.codex", "store", "bin"])
      await fs.mkdir(join(root, dir), { recursive: true });
    // Copy only the selected binary, never its installation directory or user configuration.
    await fs.copyFile(resolve(binary), join(root, "bin/agent"));
    await fs.chmod(join(root, "bin/agent"), 0o700);
    const fixture = await fs.readFile(
      join(repository, "test/fixtures/native-agent-compatibility/codex-mcp.toml"),
      "utf8",
    );
    await fs.writeFile(
      join(root, scope === "global" ? "home/.codex/config.toml" : "project/.codex/config.toml"),
      fixture,
    );
    if (scope === "project")
      await fs.writeFile(
        join(root, "home/.codex/config.toml"),
        '[projects."/probe/project"]\ntrust_level = "trusted"\n',
      );
    const args = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--tmpfs",
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
    ];
    for (const directory of ["/usr", "/bin", "/lib", "/lib64"]) {
      try {
        await fs.access(directory);
        args.push("--ro-bind", directory, directory);
      } catch {
        /* optional runtime directory */
      }
    }
    args.push(
      "--bind",
      root,
      "/probe",
      "--chdir",
      "/probe/project",
      "--setenv",
      "HOME",
      "/probe/home",
      "--setenv",
      "CODEX_HOME",
      "/probe/home/.codex",
      "--setenv",
      "XDG_CONFIG_HOME",
      "/probe/home/.config",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "--",
    );
    const execute = (command) =>
      spawnSync(sandbox, [...args, "/probe/bin/agent", ...command], {
        env: {},
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
    const detected = execute(["--version"]);
    if (detected.status !== 0) return unavailable("isolated-binary-unavailable");
    const actualVersion = detected.stdout.trim().replace(/^codex(?:-cli)?\s+/, "");
    if (actualVersion !== version) return unavailable("version-mismatch");
    const probe = execute(["mcp", "list", "--json"]);
    if (probe.status !== 0) return unavailable("native-read-failed");
    let servers;
    try {
      servers = JSON.parse(probe.stdout);
    } catch {
      return unavailable("unrecognized-native-output");
    }
    const observed =
      Array.isArray(servers) &&
      servers.some(
        (server) =>
          server.name === "cellarer_probe" &&
          server.transport?.command === "cellarer-probe-never-executed",
      );
    return {
      mode: "native",
      agent,
      capability,
      scope,
      version,
      native: observed ? "native-verified" : "unknown",
      status: observed ? "recognized" : "unavailable",
      reason: observed ? "configuration-recognized; server-not-started" : "fixture-not-observed",
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const result = args.includes("--native")
    ? await runNativeProbe({
        agent: value("--agent"),
        capability: value("--capability"),
        scope: value("--scope"),
        binary: value("--binary"),
        version: value("--version"),
      })
    : await runCompatibilityFixtures(value("--core-root"));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "unavailable") process.exitCode = 3;
}
