import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const webRequire = createRequire(join(repositoryRoot, "packages/web/package.json"));
const { chromium } = webRequire("playwright-core");
const evidenceRoot = join(repositoryRoot, "docs/dev/acceptance/human-resource-workflows");

export async function runHumanResourceWorkflows(installed) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "cellarer-human-browser-")));
  const home = join(root, "home");
  const store = join(root, "store");
  const workspace = join(root, "project");
  const target = join(workspace, ".mcp.json");
  const untouched = join(workspace, "untouched.txt");
  const env = {
    ...process.env,
    HOME: home,
    CELLARER_HOME: store,
    CELLARER_MUTATION_AUTHORITY: `v1:1:${Buffer.alloc(32, 0x36).toString("base64url")}`,
    CI: "true",
    NODE_PATH: "",
  };
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(workspace);
  await fs.mkdir(evidenceRoot, { recursive: true });
  await fs.writeFile(untouched, "unselected user file\n");
  await fs.writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: Object.fromEntries(
        ["alpha", "beta", "gamma", "unselected"].map((name) => [
          name,
          { command: `fixture-${name}` },
        ]),
      ),
    }),
  );
  const command = installed.binPath;
  const runCli = async (args) =>
    exec(command, ["--output", "json", ...args], {
      cwd: workspace,
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
  await runCli(["init"]);
  const core = await import(
    pathToFileURL(join(installed.projectRoot, "node_modules/@cellarer/core/dist/index.js")).href
  );
  const requests = [],
    phases = [],
    errors = [];
  const clean = (value) =>
    JSON.parse(
      JSON.stringify(value)
        .replaceAll(root, "<fixture>")
        .replaceAll(installed.projectRoot, "<installed>"),
    );
  const fingerprint = async (path) => {
    try {
      return createHash("sha256")
        .update(await fs.readFile(path))
        .digest("hex");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const before = {
    target: await fingerprint(target),
    untouched: await fingerprint(untouched),
    source: await fingerprint(join(home, ".claude.json")),
  };
  const child = spawn(command, ["--output", "json", "ui", "--port", "0", "--lifetime-fd", "3"], {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  let browser, page;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const ready = await new Promise((done, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(Error(`UI startup: ${stderr}`)), 15000);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(Error(`UI exited ${code}: ${stderr}`));
      });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("\n")) {
          clearTimeout(timeout);
          try {
            done(JSON.parse(output.split("\n")[0]));
          } catch (error) {
            reject(error);
          }
        }
      });
    });
    assert.equal(ready.status, "success");
    browser = await chromium.launch({
      channel: process.env.CELLARER_BROWSER_CHANNEL ?? "chrome",
      headless: true,
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        !request.url().includes("/api/v1/") ||
        request.method() !== "POST" ||
        request.url().endsWith("/auth/session")
      )
        return;
      let input;
      try {
        input = request.postDataJSON();
      } catch {
        input = null;
      }
      if (input?.snapshotPassphrase) input.snapshotPassphrase = "[synthetic fixture omitted]";
      if (input?.mutationPlan)
        input = {
          ...input,
          mutationPlan: { planId: input.mutationPlan.planId, digest: input.mutationPlan.digest },
        };
      requests.push(clean({ path: new URL(request.url()).pathname, input }));
    });
    await page.goto(ready.data.baseUrl);
    const fixturePost = async (path, input) =>
      page.evaluate(
        async ({ path, input }) => {
          const response = await fetch(path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          });
          const body = await response.json();
          if (body.status !== "success") throw new Error(JSON.stringify(body.error));
          return body.data;
        },
        { path, input },
      );
    const fixtureGet = async (path) =>
      page.evaluate(async (path) => (await (await fetch(path)).json()).data, path);
    const nav = (name) =>
      page
        .getByRole("navigation", { name: "Primary navigation" })
        .getByRole("button", { name: new RegExp(`^${name}`) })
        .click();
    const dialog = () => page.getByRole("dialog");
    const preview = async () => {
      await dialog().getByRole("button", { name: "Preview", exact: true }).click();
      await dialog().locator(".sync-plan, [role=alert]").first().waitFor();
      assert.equal(await dialog().getByRole("alert").count(), 0, await dialog().innerText());
    };
    const confirm = async () => {
      assert.equal(
        await dialog().getByRole("button", { name: "Confirm", exact: true }).isEnabled(),
        true,
        await dialog().innerText(),
      );
      await dialog().getByRole("button", { name: "Confirm", exact: true }).click();
      await dialog().waitFor({ state: "hidden" });
    };
    const reviewConfirm = async (name) => {
      await page.getByRole("button", { name, exact: true }).click();
      await preview();
      await confirm();
    };
    const saveProfile = async (name, ids, project = workspace) => {
      await page.getByRole("button", { name: "New Profile", exact: true }).click();
      await page.getByLabel("Profile ID", { exact: true }).fill(name);
      await page.getByLabel("Workspace root", { exact: true }).fill(project);
      await page.getByRole("checkbox", { name: "Target claude-code", exact: true }).check();
      for (const id of ids) await page.getByRole("checkbox", { name: id, exact: true }).check();
      await reviewConfirm("Review Profile");
      await page.getByRole("button", { name, exact: true }).click();
    };
    await page.getByRole("button", { name: /^Review import/ }).waitFor();
    for (const name of ["alpha", "beta", "gamma"])
      await page.getByRole("checkbox", { name: `Select ${name}`, exact: true }).check();
    await page.getByRole("checkbox", { name: "Select unselected", exact: true }).uncheck();
    await page.getByRole("button", { name: /^Review import/ }).click();
    await page.getByRole("button", { name: "Confirm Store import", exact: true }).click();
    await page
      .getByRole("region", { name: "Inventory import next actions" })
      .waitFor()
      .catch(async () => page.getByText("Store import completed", { exact: false }).waitFor());
    assert.equal(await fingerprint(target), null, "import wrote target");
    await nav("MCP");
    await page.getByRole("checkbox", { name: "Select mcp/alpha", exact: true }).check();
    await page.getByRole("checkbox", { name: "Select mcp/beta", exact: true }).check();
    await page.getByRole("button", { name: "Sync to Agents", exact: true }).click();
    await dialog().getByRole("textbox").first().fill("claude-code");
    await dialog().getByText("Project-level", { exact: true }).click();
    await dialog().getByPlaceholder("Project root absolute path").fill(workspace);
    await dialog().getByRole("button", { name: "Preview", exact: true }).click();
    await dialog().getByRole("button", { name: "Apply", exact: true }).waitFor();
    assert.equal(await fingerprint(target), null);
    // Close without applying to prove exact ID preview is disposable. J1 deployment is a Profile consumer.
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    assert.deepEqual(
      requests.findLast((request) => request.path === "/api/v1/sync/plan").input.resources.ids,
      ["mcp/alpha", "mcp/beta"],
    );
    await nav("Profiles");
    await saveProfile("daily", ["mcp/alpha", "mcp/beta"]);
    assert.equal(await fingerprint(target), null, "Profile save wrote target");
    await reviewConfirm("Preview reconciliation");
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(target, "utf8")).mcpServers).sort(), [
      "alpha",
      "beta",
    ]);
    phases.push({
      id: "J1",
      status: "passed",
      before,
      after: { target: await fingerprint(target), untouched: await fingerprint(untouched) },
      exactImportCount: 3,
      exactSyncIds: ["mcp/alpha", "mcp/beta"],
    });
    await page.screenshot({ path: join(evidenceRoot, "J1.png"), fullPage: true });
    console.log("J1 passed");

    // Fixture preparation only: adopt a user-added server under an explicit Core drift acknowledgement.
    const document = JSON.parse(await fs.readFile(target, "utf8"));
    document.mcpServers.user = { command: "fixture-user-owned" };
    await fs.writeFile(target, JSON.stringify(document));
    const first = await fixturePost("/api/v1/profiles/daily/sync/plan", {
      workspaceRoot: workspace,
    });
    const token = first.plan.conflicts.find((conflict) => conflict.acknowledgement)?.acknowledgement
      .token;
    assert.ok(token, "fixture drift acknowledgement missing");
    const options = {
      workspaceRoot: workspace,
      overrideDrift: [token],
      snapshotPassphrase: "synthetic-browser-fixture-passphrase",
    };
    const adopted = await fixturePost("/api/v1/profiles/daily/sync/plan", options);
    assert.equal(
      (
        await fixturePost("/api/v1/profiles/daily/sync/apply", {
          ...options,
          mutationPlan: adopted.mutationPlan,
        })
      ).operation.ok,
      true,
    );
    const j2Before = await fingerprint(target);
    await nav("MCP");
    await page.getByLabel("Collection name", { exact: true }).fill("travel");
    await reviewConfirm("Review new Collection");
    await page.getByLabel("Collection name", { exact: true }).fill("travel");
    await page.getByRole("checkbox", { name: "mcp/alpha", exact: true }).check();
    await page.getByRole("checkbox", { name: "mcp/beta", exact: true }).check();
    await reviewConfirm("Review membership");
    await nav("Profiles");
    await page.getByRole("button", { name: "daily", exact: true }).click();
    await page.getByLabel("Workspace root", { exact: true }).fill(workspace);
    await page
      .getByRole("combobox", { name: /^Profile selection mode/ })
      .selectOption("collections");
    await page.getByRole("checkbox", { name: "travel", exact: true }).check();
    await reviewConfirm("Review Profile");
    await nav("MCP");
    await page.getByLabel("Collection name", { exact: true }).fill("travel");
    await page.getByRole("checkbox", { name: "mcp/beta", exact: true }).uncheck();
    await page.getByRole("checkbox", { name: "mcp/gamma", exact: true }).check();
    await reviewConfirm("Review membership");
    await nav("Profiles");
    await page.getByRole("button", { name: "daily", exact: true }).click();
    await page.getByLabel("Workspace root", { exact: true }).fill(workspace);
    assert.equal(await fingerprint(target), j2Before, "Profile update changed targets");
    assert.equal(
      await page
        .getByRole("button", { name: "Preview historical revert", exact: true })
        .isEnabled(),
      false,
      "Collection selection must not widen historical revert",
    );
    await page.getByText("Historical revert resources", { exact: true }).click();
    await page.getByRole("checkbox", { name: "Revert mcp/alpha", exact: true }).check();
    await page.getByRole("button", { name: "Preview historical revert", exact: true }).click();
    await dialog().getByRole("button", { name: "Preview", exact: true }).click();
    await dialog().locator(".sync-plan, [role=alert]").waitFor();
    assert.deepEqual(
      requests.filter((request) => request.path === "/api/v1/revert/plan").at(-1).input.artifactIds,
      ["mcp/alpha"],
    );
    await dialog().getByRole("button", { name: "Close", exact: true }).click();

    await page.getByRole("button", { name: "Verify deployment", exact: true }).click();
    await page.getByText("Pending deployment: Yes", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Preview reconciliation", exact: true }).click();
    await preview();
    const changes = await dialog().innerText();
    assert.match(changes, /remove.*beta/s);
    assert.match(changes, /add.*gamma/s);
    assert.match(changes, /User content preserved/);
    await confirm();
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(target, "utf8")).mcpServers).sort(), [
      "alpha",
      "gamma",
      "user",
    ]);
    phases.push({
      id: "J2",
      status: "passed",
      fixturePreparation:
        "Explicit Core drift acknowledgement adopted user server; no UI force persisted",
      before: j2Before,
      after: await fingerprint(target),
      userEntryPreserved: true,
    });
    await page.screenshot({ path: join(evidenceRoot, "J2.png"), fullPage: true });
    console.log("J2 passed");

    const stable = await fs.readFile(target);
    await page.getByRole("button", { name: "Preview reconciliation", exact: true }).click();
    await preview();
    const storeChange = await fixturePost("/api/v1/profiles/plan", {
      action: "create",
      profileId: "stale-trigger",
      desired: (await fixtureGet("/api/v1/profiles/daily")).profile.desired,
    });
    assert.equal(
      (await fixturePost("/api/v1/profiles/apply", { mutationPlan: storeChange.plan })).operation
        .ok,
      true,
    );
    const appliesBefore = requests.filter((request) => request.path.endsWith("/sync/apply")).length;
    await dialog().getByRole("button", { name: "Confirm", exact: true }).click();
    await dialog().getByRole("alert").waitFor();
    const staleRejection = await dialog().getByRole("alert").innerText();
    assert.match(
      staleRejection,
      /STALE_REVISION|DOMAIN_VALIDATION_FAILED: mutation plan is invalid/,
    );
    assert.match(staleRejection, /new preview/);
    assert.equal(
      await dialog().getByRole("button", { name: "Confirm", exact: true }).isEnabled(),
      false,
    );
    assert.equal(
      requests.filter((request) => request.path.endsWith("/sync/apply")).length,
      appliesBefore + 1,
    );
    assert.deepEqual(await fs.readFile(target), stable);
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await fs.writeFile(target, Buffer.concat([stable, Buffer.from("\n ")]));
    await page.getByRole("button", { name: "Preview uninstall", exact: true }).click();
    await preview();
    assert.match(await dialog().innerText(), /DRIFTED|drift/i);
    assert.equal(
      await dialog().getByRole("button", { name: "Confirm", exact: true }).isEnabled(),
      false,
    );
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await fs.writeFile(target, stable);
    await page.getByRole("button", { name: "Preview reconciliation", exact: true }).click();
    await preview();
    await page.reload();
    await nav("Profiles");
    await page.getByRole("button", { name: "daily", exact: true }).click();
    await page.getByLabel("Workspace root", { exact: true }).fill(workspace);
    await page.getByRole("button", { name: "Preview reconciliation", exact: true }).click();
    assert.equal(
      await dialog().getByRole("button", { name: "Confirm", exact: true }).isEnabled(),
      false,
    );
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Preview reconciliation", exact: true }).click();
    await preview();
    const recovery = core.recoveryLockPath(store);
    await fs.writeFile(
      recovery,
      `${JSON.stringify({ operationId: "human-recovery-fixture", processId: 4242, hostname: "fixture", acquiredAt: new Date().toISOString() })}\n`,
    );
    await dialog().getByRole("button", { name: "Confirm", exact: true }).click();
    await dialog()
      .getByRole("alert")
      .filter({ hasText: /RECOVERY_REQUIRED/ })
      .waitFor();
    assert.equal(
      await dialog().getByRole("button", { name: "Confirm", exact: true }).isEnabled(),
      false,
    );
    await page.screenshot({ path: join(evidenceRoot, "J3.png"), fullPage: true });
    await dialog().getByRole("button", { name: "Close", exact: true }).click();
    await fs.rm(recovery);
    phases.push({
      id: "J3",
      status: "passed",
      staleRejectedOnce: true,
      staleRejection,
      driftBlocked: true,
      reloadInvalidated: true,
      recoveryBlocked: true,
      targetUnchanged:
        (await fingerprint(target)) === createHash("sha256").update(stable).digest("hex"),
    });
    console.log("J3 passed");

    const sharedProject = join(root, "shared-project");
    await fs.mkdir(sharedProject);
    const sharedTarget = join(sharedProject, ".mcp.json");
    const sharedUntouched = join(sharedProject, "user.txt");
    await fs.writeFile(sharedUntouched, "independent user file");
    const userFileBefore = await fingerprint(sharedUntouched);
    await saveProfile("shared-a", ["mcp/alpha", "mcp/gamma"], sharedProject);
    await reviewConfirm("Preview reconciliation");
    await saveProfile("shared-b", ["mcp/alpha", "mcp/gamma"], sharedProject);
    await reviewConfirm("Preview reconciliation");
    const shared = await fingerprint(sharedTarget);
    await page.getByRole("button", { name: "shared-a", exact: true }).click();
    await page.getByRole("button", { name: "Preview uninstall", exact: true }).click();
    await preview();
    assert.match(await dialog().innerText(), /detach-consumer/);
    await confirm();
    assert.equal(await fingerprint(sharedTarget), shared);
    await page.getByRole("button", { name: "shared-b", exact: true }).click();
    await page.getByRole("button", { name: "Preview uninstall", exact: true }).click();
    await preview();
    assert.match(await dialog().innerText(), /prune-mcp/);
    await confirm();
    assert.deepEqual(JSON.parse(await fs.readFile(sharedTarget, "utf8")).mcpServers, {});
    const finalLedger = JSON.parse(await fs.readFile(join(store, "state.json"), "utf8"));
    assert.deepEqual(
      finalLedger.deployments.filter((deployment) => deployment.target === sharedTarget),
      [],
    );
    assert.equal(await fingerprint(sharedUntouched), userFileBefore);
    assert.deepEqual(await fs.readFile(target), stable);
    phases.push({
      id: "J4",
      status: "passed",
      before: shared,
      after: await fingerprint(sharedTarget),
      middleDetachUnchanged: true,
      finalAction: "prune-mcp",
      finalManagedEntriesRemoved: true,
      finalConsumersRemoved: true,
      userFilePreserved: true,
      j2UserEntryPreserved: true,
    });
    await page.screenshot({ path: join(evidenceRoot, "J4.png"), fullPage: true });
    console.log("J4 passed");
    assert.equal(await fingerprint(untouched), before.untouched);
    assert.equal(await fingerprint(join(home, ".claude.json")), before.source);
    assert.deepEqual(errors, []);
    const report = clean({
      status: "passed",
      browser: await browser.version(),
      installedEntry: installed.jsBin ?? command,
      staticUi: true,
      phases,
      requests,
      unselectedPathsUnchanged: true,
      browserErrors: errors,
      humanStudy: {
        status: "not-run",
        participants: 0,
        activeTime: null,
        completionRate: null,
        mistakes: null,
      },
    });
    await fs.writeFile(
      join(evidenceRoot, "browser-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    return report;
  } catch (error) {
    await page
      ?.screenshot({ path: join(evidenceRoot, "failure.png"), fullPage: true })
      .catch(() => {});
    await fs.writeFile(
      join(evidenceRoot, "browser-failure.json"),
      `${JSON.stringify(clean({ status: "failed", phases, requests, errors, message: error.message }), null, 2)}\n`,
    );
    throw error;
  } finally {
    await browser?.close();
    child.stdio[3].end();
    await new Promise((done) => {
      if (child.exitCode !== null) return done();
      child.once("exit", done);
      setTimeout(() => {
        child.kill();
        done();
      }, 5000).unref();
    });
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function standalone() {
  const installRoot = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "cellarer-human-install-")),
  );
  try {
    const artifactRoot = join(repositoryRoot, "artifacts/release-readiness");
    const manifest = JSON.parse(await fs.readFile(join(artifactRoot, "readiness.json"), "utf8"));
    const dependencies = Object.fromEntries(
      ["core", "web", "cli"].map((name) => {
        const tar = manifest.files[name];
        assert.ok(tar, `Run pnpm artifact:pack first (${name})`);
        return [`@cellarer/${name}`, `file:${join(repositoryRoot, tar)}`];
      }),
    );
    await fs.writeFile(
      join(installRoot, "package.json"),
      JSON.stringify({ private: true, dependencies, pnpm: { overrides: dependencies } }),
    );
    await exec("pnpm", ["install", "--ignore-scripts", "--no-optional"], {
      cwd: installRoot,
      env: { ...process.env, CI: "true" },
      maxBuffer: 16 * 1024 * 1024,
    });
    const report = await runHumanResourceWorkflows({
      projectRoot: installRoot,
      binPath: join(installRoot, "node_modules/.bin/cellarer"),
      jsBin: join(installRoot, "node_modules/@cellarer/cli/dist/bin.js"),
    });
    console.log(
      `Human resource browser journeys: ${report.status} (${report.phases.length}/4). Human study: not-run.`,
    );
  } finally {
    await fs.rm(installRoot, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await standalone();
