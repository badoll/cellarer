import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRealEnv } from "../../packages/core/dist/index.js";
import { initStore } from "../../packages/core/dist/store/store.js";
import { startServer, WEB_CLIENT_ASSET_ROOT } from "../../packages/web/dist/index.js";
import { deterministicMutationAuthority } from "../fixtures/web-selection/authority.mjs";

// Supply an installed Playwright entry point when it is not a local dependency.
const playwrightModule = process.env.CELLARER_PLAYWRIGHT_MODULE;
let chromium;
try {
  ({ chromium } = await import(
    playwrightModule ? pathToFileURL(playwrightModule).href : "playwright"
  ));
} catch {
  console.error(
    "NOT RUN: Playwright unavailable. Set CELLARER_PLAYWRIGHT_MODULE to its installed entry point.",
  );
  process.exit(2);
}
const root = await realpath(await mkdtemp(join(tmpdir(), "cellarer-web-selection-")));
let server;
let browser;
let page;
try {
  const home = join(root, "home");
  const project = join(root, "project");
  const storeRoot = join(home, ".cellarer");
  await mkdir(project, { recursive: true });
  const env = {
    ...createRealEnv(),
    homedir: () => home,
    cwd: () => project,
    env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: "" },
    mutationAuthority: deterministicMutationAuthority(),
  };
  await initStore(env, storeRoot);
  const configPath = join(storeRoot, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.defaults.method = "copy";
  config.collections.work = {};
  config.collections.personal = {};
  for (const collection of ["work", "personal", "default"]) {
    const name = `${collection}-skill`;
    const directory = join(storeRoot, "store", "skills", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${collection} fixture\n---\n\n# ${collection} selection marker\n`,
    );
    config.artifacts[`skills/${name}`] = { collections: [collection] };
  }
  await writeFile(configPath, JSON.stringify(config));
  const untouched = join(project, ".agents", "skills", "personal-skill", "SKILL.md");
  await mkdir(join(project, ".agents", "skills", "personal-skill"), { recursive: true });
  await writeFile(untouched, "Personal target must remain untouched.\n");
  const untouchedBefore = await readFile(untouched, "utf8");
  const defaultTarget = join(project, ".agents", "skills", "default-skill");
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CELLARER_BROWSER_EXECUTABLE || undefined,
    });
  } catch (error) {
    console.error(`NOT RUN: Chromium unavailable: ${error.message}`);
    process.exitCode = 2;
  }
  if (browser) {
    server = await startServer({
      env,
      storeRoot,
      staticRoot: WEB_CLIENT_ASSET_ROOT,
      port: 0,
      auth: { mode: "browser-session" },
    });
    page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const requests = [];
    page.on("request", (request) => {
      if (/\/api\/v1\/sync\/(plan|apply)$/.test(request.url()))
        requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    });
    await page.goto(server.ready.baseUrl);
    await page.getByRole("button", { name: /Skills.*Library/s }).click();
    const filter = page.getByRole("combobox", { name: "Collection", exact: true });
    await filter.fill("work");
    await page.getByRole("button", { name: "Sync to Agents", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Sync to Agents" });
    await dialog.getByText("Project-level", { exact: true }).click();
    await dialog.getByRole("textbox", { name: "Project root" }).fill(project);
    const previewResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/sync/plan"),
    );
    await dialog.getByRole("button", { name: "Preview", exact: true }).click();
    const preview = await (await previewResponse).json();
    assert.equal(preview.status, "success", JSON.stringify(preview));
    assert.deepEqual(requests[0].body.resources.collections, ["work"]);
    assert(preview.data.plan.actions.length > 0);
    assert(preview.data.plan.actions.every((action) => action.artifact === "skills/work-skill"));
    const applyResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/sync/apply"),
    );
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    const applied = await (await applyResponse).json();
    assert.equal(applied.status, "success", JSON.stringify(applied));
    assert.equal(applied.data.operation.ok, true);
    assert.deepEqual(requests[1].body, { mutationPlan: preview.data.mutationPlan });
    await dialog.waitFor({ state: "hidden" });
    assert.equal(
      await readFile(join(project, ".agents", "skills", "work-skill", "SKILL.md"), "utf8"),
      await readFile(join(storeRoot, "store", "skills", "work-skill", "SKILL.md"), "utf8"),
    );
    assert.equal(await readFile(untouched, "utf8"), untouchedBefore);
    await assert.rejects(readFile(join(defaultTarget, "SKILL.md")), { code: "ENOENT" });

    // A closed preview cannot be reused after the actual resource filter changes.
    await page.getByRole("button", { name: "Sync to Agents", exact: true }).click();
    assert.equal(
      await dialog.getByRole("button", { name: "Apply", exact: true }).isDisabled(),
      true,
    );
    await dialog.getByRole("button", { name: "Preview", exact: true }).click();
    await dialog.getByRole("button", { name: "Apply", exact: true }).click({ trial: true });
    assert.equal(
      await dialog.getByRole("button", { name: "Apply", exact: true }).isEnabled(),
      true,
    );
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await filter.fill("personal");
    await page.getByRole("button", { name: "Sync to Agents", exact: true }).click();
    assert.equal(
      await dialog.getByRole("button", { name: "Apply", exact: true }).isDisabled(),
      true,
    );
    assert((await dialog.textContent()).includes("personal"));
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await filter.fill("");
    await page.getByRole("button", { name: "Sync to Agents", exact: true }).click();
    assert((await dialog.textContent()).includes("Store defaults"));
    const defaultResponse = page.waitForResponse((response) =>
      response.url().endsWith("/api/v1/sync/plan"),
    );
    await dialog.getByRole("button", { name: "Preview", exact: true }).click();
    const defaults = await (await defaultResponse).json();
    assert.equal(defaults.status, "success", JSON.stringify(defaults));
    assert.equal(requests.at(-1).body.resources.collections, undefined);
    assert(defaults.data.plan.actions.length > 0);
    assert(
      defaults.data.plan.actions.every((action) => action.artifact === "skills/default-skill"),
    );
    assert.equal(requests.filter((request) => request.path.endsWith("/apply")).length, 1);
    assert.equal(await readFile(untouched, "utf8"), untouchedBefore);
    await assert.rejects(readFile(join(defaultTarget, "SKILL.md")), { code: "ENOENT" });
    assert.deepEqual(errors, []);
    const entry = await readFile(join(WEB_CLIENT_ASSET_ROOT, "index.html"), "utf8");
    const asset = entry.match(/src="([^"]+\.js)"/)?.[1];
    assert(asset, "built script asset is required");
    const assetBytes = await readFile(join(WEB_CLIENT_ASSET_ROOT, asset));
    console.log(
      JSON.stringify(
        {
          status: "passed",
          browser: browser.version(),
          playwrightModule: playwrightModule || "playwright",
          staticRoot: WEB_CLIENT_ASSET_ROOT,
          serverModule: fileURLToPath(new URL("../../packages/web/dist/index.js", import.meta.url)),
          asset,
          sha256: createHash("sha256").update(assetBytes).digest("hex"),
          checks: [
            "filtered request",
            "exact apply plan",
            "selected target bytes",
            "unselected targets unchanged",
            "close and refilter invalidation",
            "Store default preview",
            "no page errors",
          ],
          isolation: "temporary HOME/Store/project with in-memory test authority",
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  if (page) console.error((await page.locator("body").innerText()).slice(0, 6000));
  throw error;
} finally {
  await browser?.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
