import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { optionalKeychainInstalled } from "./artifact-release-gate-helpers.mjs";

const exec = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packOnly = process.argv.slice(2).includes("--pack-only");
const offlineRegistry = execFileSync("pnpm", ["config", "get", "registry"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const packages = ["core", "web", "cli"];
const secretCanaries = [
  "CELLARER_ARTIFACT_SECRET_CANARY_DO_NOT_SHIP",
  "cellarer-plaintext-secret-canary",
];
const temporaryRoot = await fs.mkdtemp(join(tmpdir(), "cellarer-artifact-gate-"));
const resultRoot = join(repositoryRoot, "artifacts", "release-readiness");

try {
  await run("pnpm", ["build"], repositoryRoot, process.env);
  const first = await packSet("first");
  const second = await packSet("second");
  await inspectPackSet(first, second);
  if (!packOnly) {
    const installed = await installPackedSet(first, {
      name: "with-optional",
      includeOptionalDependencies: true,
    });
    assert(
      optionalKeychainInstalled(installed),
      "optional native keychain package was not installed",
    );
    await exerciseInstalledRelease(installed);
    const withoutOptional = await installPackedSet(first, {
      name: "without-optional",
      includeOptionalDependencies: false,
    });
    assert(
      !optionalKeychainInstalled(withoutOptional),
      "no-optional install unexpectedly contains native keychain package",
    );
    await exerciseNativeUnavailableRelease(withoutOptional);
  }
  await writeLocalResults(first, packOnly ? "pack" : "readiness");
  process.stdout.write(
    `${packOnly ? "artifact pack inspection" : "artifact release gate"} passed\n`,
  );
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

async function packSet(round) {
  const destination = join(temporaryRoot, "artifacts", round);
  await fs.mkdir(destination, { recursive: true });
  const result = new Map();
  for (const name of packages) {
    const { stdout } = await run(
      "pnpm",
      ["pack", "--json", "--pack-destination", destination],
      join(repositoryRoot, "packages", name),
      process.env,
    );
    const report = JSON.parse(stdout);
    const filename = report.filename ?? report[0]?.filename;
    if (typeof filename !== "string") throw new Error(`pnpm pack did not report ${name} tarball`);
    result.set(name, resolve(join(repositoryRoot, "packages", name), filename));
  }
  return result;
}

async function inspectPackSet(first, second) {
  const manifests = new Map();
  for (const name of packages) {
    const tarball = required(first, name);
    const repeated = required(second, name);
    const [digest, repeatedDigest] = await Promise.all([sha512(tarball), sha512(repeated)]);
    assert(digest === repeatedDigest, `${name} tarball is not deterministic`);

    const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const entry of entries) assertAllowedEntry(name, entry);
    const requiredEntries = {
      core: [
        "package/README.md",
        "package/LICENSE",
        "package/package.json",
        "package/dist/index.js",
        "package/dist/index.d.ts",
        "package/config.json",
      ],
      web: [
        "package/README.md",
        "package/LICENSE",
        "package/package.json",
        "package/dist/index.js",
        "package/dist/index.d.ts",
        "package/client/dist/index.html",
      ],
      cli: ["package/README.md", "package/LICENSE", "package/package.json", "package/dist/bin.js"],
    }[name];
    for (const entry of requiredEntries) {
      assert(entries.includes(entry), `${name} tarball is missing required entry: ${entry}`);
    }
    const content = execFileSync("tar", ["-xOzf", tarball], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    for (const canary of secretCanaries) {
      assert(!content.includes(canary), `${name} tarball contains secret canary`);
    }
    const manifestText = execFileSync("tar", ["-xOzf", tarball, "package/package.json"], {
      encoding: "utf8",
    });
    const manifest = JSON.parse(manifestText);
    assertPublicManifest(name, manifest);
    manifests.set(name, manifest);
  }

  const versions = new Set(packages.map((name) => required(manifests, name).version));
  assert(versions.size === 1, "release package versions are not synchronized");
  const [version] = versions;
  assert(
    typeof version === "string" && isStableSemver(version),
    `stable release package version is invalid or prerelease: ${String(version)}`,
  );
  assert(
    required(manifests, "web").dependencies?.["@cellarer/core"] ===
      required(manifests, "core").version,
    "Web Core dependency is not publishable and synchronized",
  );
  assert(
    required(manifests, "cli").dependencies?.["@cellarer/core"] ===
      required(manifests, "core").version,
    "CLI Core dependency is not publishable and synchronized",
  );
  assert(
    required(manifests, "cli").dependencies?.["@cellarer/web"] ===
      required(manifests, "web").version,
    "CLI Web dependency is not publishable and synchronized",
  );
  for (const name of packages) {
    const manifest = required(manifests, name);
    assert(manifest.private !== true, `${name} artifact remains private`);
    assert(
      !JSON.stringify(manifest).includes("workspace:"),
      `${name} artifact leaks workspace protocol`,
    );
  }
}

function assertPublicManifest(name, manifest) {
  assert(manifest.license === "MIT", `${name} manifest license is not MIT`);
  assert(manifest.engines?.node === ">=20.19", `${name} manifest Node engine is incorrect`);
  assert(manifest.publishConfig?.access === "public", `${name} publish access is not public`);
  const expected = {
    core: {
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      files: ["dist", "config.json"],
    },
    web: {
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      files: ["dist", "client/dist"],
    },
    cli: {
      bin: { cellarer: "./dist/bin.js" },
      files: ["dist"],
    },
  }[name];
  for (const [field, value] of Object.entries(expected)) {
    assert(
      JSON.stringify(manifest[field]) === JSON.stringify(value),
      `${name} manifest ${field} is incorrect`,
    );
  }
  if (name === "cli") {
    assert(
      manifest.exports?.["./package.json"] === "./package.json",
      "CLI package.json export is missing",
    );
  } else {
    assert(
      manifest.exports?.["."]?.types === "./dist/index.d.ts",
      `${name} types export is incorrect`,
    );
    assert(
      manifest.exports?.["."]?.import === "./dist/index.js",
      `${name} import export is incorrect`,
    );
    assert(
      manifest.exports?.["."]?.default === "./dist/index.js",
      `${name} default export is incorrect`,
    );
    assert(
      manifest.exports?.["./package.json"] === "./package.json",
      `${name} package.json export is missing`,
    );
  }
}

function assertAllowedEntry(name, entry) {
  const common = /^package\/(?:LICENSE|README\.md|package\.json)$/;
  const allowed = {
    core: /^package\/(?:dist\/.*|config\.json)$/,
    web: /^package\/(?:dist\/.*|client\/dist\/.*)$/,
    cli: /^package\/dist\/.*$/,
  }[name];
  assert(
    common.test(entry) || allowed.test(entry),
    `${name} tarball contains forbidden file: ${entry}`,
  );
  assert(
    !/(?:^|\/)(?:src|tests?|\.cache|\.cellarer)(?:\/|$)/.test(entry),
    `${name} tarball contains development/local state: ${entry}`,
  );
}

async function installPackedSet(tarballs, { name, includeOptionalDependencies }) {
  const projectRoot = join(temporaryRoot, `clean-project-${name}`);
  const home = join(temporaryRoot, `home-${name}`);
  const store = join(temporaryRoot, `cellarer-store-${name}`);
  const pnpmHome = join(temporaryRoot, `pnpm-home-${name}`);
  const pnpmStore = join(temporaryRoot, `pnpm-store-${name}`);
  await Promise.all([
    fs.mkdir(projectRoot, { recursive: true }),
    fs.mkdir(home),
    fs.mkdir(pnpmHome),
  ]);
  const localArtifacts = Object.fromEntries(
    packages.map((name) => [`@cellarer/${name}`, `file:${required(tarballs, name)}`]),
  );
  await fs.writeFile(
    join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "artifact-consumer", private: true, dependencies: localArtifacts, pnpm: { overrides: localArtifacts } }, null, 2)}\n`,
  );
  const env = isolatedEnv({ home, store, pnpmHome });
  await run(
    "pnpm",
    [
      "install",
      "--ignore-scripts",
      ...(includeOptionalDependencies ? [] : ["--no-optional"]),
      "--store-dir",
      pnpmStore,
    ],
    projectRoot,
    env,
  );
  const realProjectRoot = await fs.realpath(projectRoot);
  const realRepositoryRoot = await fs.realpath(repositoryRoot);
  for (const name of packages) {
    const installedRoot = await fs.realpath(join(projectRoot, "node_modules", "@cellarer", name));
    assert(
      isInside(realProjectRoot, installedRoot),
      `${name} resolves outside clean install: ${installedRoot}`,
    );
    assert(
      !isInside(realRepositoryRoot, installedRoot),
      `${name} resolves into workspace: ${installedRoot}`,
    );
  }
  const binDirectory = join(projectRoot, "node_modules", ".bin");
  const binPath = join(binDirectory, "cellarer");
  const jsBin = join(projectRoot, "node_modules", "@cellarer", "cli", "dist", "bin.js");
  const realBin = await fs.realpath(binPath);
  const realJsBin = await fs.realpath(jsBin);
  assert(
    isInside(realProjectRoot, realBin),
    `installed cellarer command resolves outside clean install: ${realBin}`,
  );
  assert(
    !isInside(realRepositoryRoot, realBin),
    `installed cellarer command resolves into workspace: ${realBin}`,
  );
  assert(
    !(await fs.readFile(binPath, "utf8")).includes(realRepositoryRoot),
    "installed cellarer command shim points into workspace",
  );
  assert(
    isInside(realProjectRoot, realJsBin),
    `CLI JavaScript entry resolves outside clean install: ${realJsBin}`,
  );
  assert(
    !isInside(realRepositoryRoot, realJsBin),
    `CLI JavaScript entry resolves into workspace: ${realJsBin}`,
  );
  prependCommandPath(env, binDirectory);
  return { projectRoot, home, store, pnpmHome, env, bin: "cellarer", binPath, jsBin };
}

async function writeLocalResults(tarballs, gate) {
  await fs.mkdir(resultRoot, { recursive: true });
  const files = {};
  for (const name of packages) {
    const source = required(tarballs, name);
    const destination = join(resultRoot, source.split(/[\\/]/).at(-1));
    await fs.copyFile(source, destination);
    files[name] = relative(repositoryRoot, destination);
  }
  await fs.writeFile(
    join(resultRoot, "readiness.json"),
    `${JSON.stringify({ gate, status: "passed", node: process.versions.node, platform: process.platform, files }, null, 2)}\n`,
  );
}

async function exerciseInstalledRelease(installed) {
  const manifest = JSON.parse(
    await fs.readFile(
      join(installed.projectRoot, "node_modules", "@cellarer", "cli", "package.json"),
      "utf8",
    ),
  );
  assert(
    (await cli(installed, ["--version"])).stdout.trim() === manifest.version,
    "installed version mismatch",
  );
  const capabilities = jsonOutput(await cli(installed, ["--output", "json", "capabilities"]));
  assert(
    capabilities.status === "success" && capabilities.data?.protocolVersions?.includes("1.0"),
    "capabilities failed",
  );
  const schema = jsonOutput(await cli(installed, ["--output", "json", "schema"]));
  assert(
    schema.status === "success" && schema.data?.schemas?.length > 0,
    "schema discovery failed",
  );

  const dryRun = jsonOutput(await cli(installed, ["--output", "json", "init", "--dry-run"]));
  assert(dryRun.data?.dryRun === true, "installed init --dry-run did not return a preview");
  assert(!(await exists(installed.store)), "installed init --dry-run mutated isolated state");
  const initialized = jsonOutput(await cli(installed, ["--output", "json", "init"]));
  assert(
    initialized.data?.confirmation?.status === "not-offered" &&
      initialized.data?.confirmation?.reason === "non-interactive" &&
      initialized.data?.import?.status === "not-started",
    "installed init did not follow the non-interactive Inventory contract",
  );
  const doctor = jsonOutput(await cli(installed, ["--output", "json", "doctor"]));
  assert(doctor.command === "doctor", "doctor did not return its protocol envelope");
  assertTypedKeychainCapability(doctor, "optional-installed");
  const fixture = join(temporaryRoot, "resource", "team-rule.md");
  await fs.mkdir(dirname(fixture), { recursive: true });
  await fs.writeFile(fixture, "# Packed artifact journey\n");
  jsonOutput(
    await cli(installed, ["--output", "json", "add", fixture, "--collection", "release-gate"]),
  );
  const listing = jsonOutput(
    await cli(installed, ["--output", "json", "ls", "--collection", "release-gate"]),
  );
  assert(
    listing.data?.artifacts?.some((item) => item.id === "rules/team-rule"),
    "resource journey did not persist rule",
  );
  const agents = jsonOutput(await cli(installed, ["--output", "json", "agents"]));
  assert(
    ["codex", "claude-code"].every((id) => agents.data?.agents?.some((agent) => agent.id === id)),
    "registered agents were not discoverable after initialization",
  );

  await assertUnsupportedNodeDoesNotMutate(installed);
  await assertVaultFallback(installed);
  await assertInstalledUi(installed);
  await assertNoPlaintext(installed.store, secretCanaries);
}

async function exerciseNativeUnavailableRelease(installed) {
  jsonOutput(await cli(installed, ["--output", "json", "init"]));
  const doctor = jsonOutput(await cli(installed, ["--output", "json", "doctor"]));
  assertTypedKeychainCapability(doctor, "module-unavailable");
  await assertVaultFallback(installed);
}

function assertTypedKeychainCapability(doctor, expectedBranch) {
  const limitation = doctor.data?.limitations?.find(
    (item) => item.capability === "native-keychain",
  );
  if (expectedBranch === "module-unavailable") {
    assert(
      limitation?.code === "KEYCHAIN_MODULE_UNAVAILABLE" &&
        limitation?.reason === "module-unavailable",
      "doctor did not report typed native keychain limitation",
    );
    return;
  }
  assert(
    (limitation?.code === "KEYCHAIN_SMOKE_ISOLATION_UNAVAILABLE" &&
      limitation?.reason === "credential-store-not-isolated") ||
      (limitation?.code === "KEYCHAIN_MODULE_UNAVAILABLE" &&
        limitation?.reason === "module-unavailable"),
    "optional install did not exercise a typed native-loaded-unprobed or module-unavailable branch",
  );
}

async function assertUnsupportedNodeDoesNotMutate(installed) {
  const store = join(temporaryRoot, "unsupported-store");
  const preload = join(temporaryRoot, "unsupported-node.cjs");
  await fs.writeFile(
    preload,
    'Object.defineProperty(process.versions, "node", { value: "18.0.0" });\n',
  );
  const result = await run(
    process.execPath,
    ["--require", preload, installed.jsBin, "init"],
    installed.projectRoot,
    { ...installed.env, CELLARER_HOME: store },
    true,
  );
  assert(result.exitCode === 1, "unsupported Node did not fail with startup status 1");
  assert(
    /Node\.js >=20\.19 is required.*18\.0\.0/i.test(result.stderr),
    "unsupported Node diagnostic is unclear",
  );
  assert(!(await exists(store)), "unsupported Node mutated isolated store");
}

async function assertVaultFallback(installed) {
  const canary = "cellarer-vault-smoke-plaintext";
  const passphrase = "cellarer-vault-smoke-passphrase";
  await cliWithDescriptors(
    installed,
    [
      "--output",
      "json",
      "secret",
      "add",
      "release-gate",
      "--provider",
      "vault",
      "--fd",
      "3",
      "--passphrase-fd",
      "4",
    ],
    [canary, passphrase],
  );
  const names = await cliWithDescriptors(
    installed,
    ["--output", "json", "secret", "ls", "--passphrase-fd", "3"],
    [passphrase],
  );
  assert(
    jsonOutput(names).data?.names?.includes("release-gate"),
    "vault fallback did not store secret name",
  );
  await assertNoPlaintext(installed.store, [canary, passphrase]);
}

async function assertInstalledUi(installed) {
  await assertInstalledSidecarMode(installed, "browser-session");
  await assertInstalledSidecarMode(installed, "bearer");
}

async function assertInstalledSidecarMode(installed, authMode) {
  const token = "cellarer-installed-sidecar-token-canary";
  const bearer = authMode === "bearer";
  const lifetimeFd = bearer ? 4 : 3;
  const args = [
    "--output",
    "json",
    "ui",
    "--port",
    "0",
    "--lifetime-fd",
    String(lifetimeFd),
    ...(bearer ? ["--token-fd", "3"] : []),
  ];
  const child = spawn(installed.bin, args, {
    cwd: installed.projectRoot,
    env: installed.env,
    stdio: ["ignore", "pipe", "pipe", "pipe", ...(bearer ? ["pipe"] : [])],
  });
  const exit = childExit(child);
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  if (bearer) child.stdio[3].end(`${token}\n`);
  try {
    const readyEnvelope = await waitForJsonOutput(child);
    assert(readyEnvelope.status === "success", `${authMode} sidecar did not publish success`);
    const ready = readyEnvelope.data;
    assert(
      ready?.schemaVersion === 1 &&
        ready.apiVersion === "1.0" &&
        ready.contractId === "cellarer-local-client-api-v1" &&
        ready.lifecycle === "owned-v1" &&
        ready.authMode === authMode &&
        Number.isInteger(ready.pid) &&
        /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(ready.baseUrl),
      `${authMode} sidecar ready record is invalid`,
    );
    const dashboard = await fetch(`${ready.baseUrl}/`);
    assert(
      dashboard.ok && (await dashboard.text()).includes('<div id="root"></div>'),
      `${authMode} installed dashboard asset failed`,
    );
    const asset = (
      await fs.readdir(
        join(installed.projectRoot, "node_modules", "@cellarer", "web", "client", "dist", "assets"),
      )
    ).find((name) => name.endsWith(".js"));
    assert(asset, "packed Web JavaScript asset is missing");
    const staticResponse = await fetch(`${ready.baseUrl}/assets/${asset}`);
    assert(
      staticResponse.ok && (await staticResponse.text()).length > 100,
      "installed static asset failed",
    );
    const authHeaders = bearer
      ? { authorization: `Bearer ${token}` }
      : await bootstrapInstalledBrowserSession(ready.baseUrl);
    const version = await fetch(`${ready.baseUrl}/api/v1/version`, { headers: authHeaders });
    const versionBody = await version.json();
    assert(
      version.ok &&
        versionBody.status === "success" &&
        versionBody.data?.contractId === "cellarer-local-client-api-v1",
      `${authMode} installed version discovery failed`,
    );
    const openApi = await fetch(`${ready.baseUrl}/api/v1/openapi.json`, {
      headers: authHeaders,
    });
    const openApiBody = await openApi.json();
    assert(
      openApi.ok &&
        openApiBody.status === "success" &&
        openApiBody.data?.openapi === "3.1.0" &&
        openApiBody.data?.paths?.["/api/v1/auth/session"]?.post &&
        openApiBody.data?.paths?.["/api/v1/mutations/apply"]?.post,
      `${authMode} installed OpenAPI contract failed`,
    );

    child.stdio[lifetimeFd].end();
    assert(
      await settlesWithin(exit, 3_000),
      `${authMode} sidecar did not close after lifetime EOF`,
    );
    const result = await exit;
    assert(
      result.code === 0 && result.signal === null,
      `${authMode} sidecar lifetime exit was not clean`,
    );
    const observedStdout = Buffer.concat(stdout).toString().trim();
    const observedStderr = Buffer.concat(stderr).toString();
    assert(observedStdout.split("\n").length === 1, `${authMode} stdout was not one record`);
    assert(!observedStdout.includes(token), `${authMode} stdout exposed bearer material`);
    assert(!observedStderr.includes(token), `${authMode} stderr exposed bearer material`);
  } finally {
    await terminateChild(child, exit);
  }
}

async function bootstrapInstalledBrowserSession(baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/auth/session`, {
    method: "POST",
    headers: {
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  const body = await response.json();
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(
    response.ok && body.status === "success" && cookie,
    "installed browser-session bootstrap failed",
  );
  return { cookie };
}

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const onError = (error) => {
      child.off("exit", onExit);
      reject(error);
    };
    const onExit = (code, signal) => {
      child.off("error", onError);
      resolveExit({ code, signal });
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function terminateChild(child, exit) {
  if (child.exitCode !== null || child.signalCode !== null) {
    await exit;
    return;
  }
  child.kill("SIGTERM");
  if (await settlesWithin(exit, 3_000)) return;

  child.kill("SIGKILL");
  if (await settlesWithin(exit, 3_000)) return;
  throw new Error(`UI process ${child.pid ?? "unknown"} did not exit after SIGKILL`);
}

async function settlesWithin(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function isolatedEnv({ home, store, pnpmHome }) {
  return {
    ...process.env,
    CI: "true",
    HOME: home,
    CELLARER_HOME: store,
    CELLARER_MUTATION_AUTHORITY: `v1:1:${Buffer.alloc(32, 0x35).toString("base64url")}`,
    PNPM_HOME: pnpmHome,
    npm_config_registry: offlineRegistry,
    NODE_PATH: "",
  };
}

function prependCommandPath(env, directory) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = [directory, env[pathKey]].filter(Boolean).join(delimiter);
}

async function cli(installed, args, options = {}) {
  return run(installed.bin, args, installed.projectRoot, installed.env, options.allowFailure);
}

async function cliWithDescriptors(installed, args, values) {
  const child = spawn(installed.bin, args, {
    cwd: installed.projectRoot,
    env: installed.env,
    stdio: ["ignore", "pipe", "pipe", ...values.map(() => "pipe")],
  });
  values.forEach((value, index) => {
    child.stdio[index + 3].end(`${value}\n`);
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  const result = {
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
    exitCode,
  };
  assert(exitCode === 0, `installed CLI failed: ${result.stderr}`);
  return result;
}

async function run(command, args, cwd, env, allowFailure = false) {
  try {
    const { stdout, stderr } = await exec(command, args, { cwd, env, maxBuffer: 32 * 1024 * 1024 });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const result = {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
      exitCode: error.code ?? 1,
    };
    if (allowFailure) return result;
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.exitCode}):\n${result.stderr}${result.stdout}`,
    );
  }
}

function jsonOutput(result) {
  const parsed = JSON.parse(result.stdout);
  assert(parsed.status === "success", `CLI protocol failure: ${result.stdout}`);
  return parsed;
}

async function assertNoPlaintext(root, values) {
  if (!(await exists(root))) return;
  for (const path of await walk(root)) {
    const content = await fs.readFile(path);
    for (const value of values)
      assert(!content.includes(Buffer.from(value)), `plaintext secret found in ${path}`);
  }
}

async function walk(root) {
  const files = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function waitForJsonOutput(child) {
  return new Promise((resolveReady, reject) => {
    let stdout = "";
    let stderr = "";
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onStdout = (chunk) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(stdout.slice(0, newline));
        cleanup();
        resolveReady(parsed);
      } catch (error) {
        fail(new Error(`UI emitted invalid ready JSON: ${String(error)}`));
      }
    };
    const onStderr = (chunk) => {
      stderr += chunk.toString();
    };
    const onExit = (code) => {
      fail(new Error(`UI exited before readiness (${code}): ${stderr}${stdout}`));
    };
    const timeout = setTimeout(
      () => fail(new Error(`UI startup timed out: ${stderr}${stdout}`)),
      10_000,
    );
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

async function sha512(path) {
  return createHash("sha512")
    .update(await fs.readFile(path))
    .digest("hex");
}

async function exists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function isStableSemver(value) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    value,
  );
}

function required(map, key) {
  const value = map.get(key);
  if (value === undefined) throw new Error(`missing ${key}`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
