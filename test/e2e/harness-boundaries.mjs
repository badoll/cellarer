import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const HARNESS_OWNER_MARKER = "cellarer-resource-e2e-v1\n";

export function assertInside(root, target, label = "path") {
  const canonicalRoot = resolve(root);
  const canonicalTarget = resolve(target);
  const path = relative(canonicalRoot, canonicalTarget);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`${label} escapes the isolated test root: ${canonicalTarget}`);
  }
  return canonicalTarget;
}

export function createHarnessLayout(repositoryRoot) {
  const canonicalRepositoryRoot = realpathSync(resolve(repositoryRoot));
  const testRootCandidate = join(canonicalRepositoryRoot, "test");
  const testRootStat = lstatSync(testRootCandidate);
  if (!testRootStat.isDirectory() || testRootStat.isSymbolicLink()) {
    throw new Error(`test root must be a real directory: ${testRootCandidate}`);
  }
  const testRoot = realpathSync(testRootCandidate);
  assertInside(canonicalRepositoryRoot, testRoot, "test root");

  const sandboxRoot = join(testRoot, ".sandbox");
  const reportsRoot = join(testRoot, ".reports");
  const layout = {
    repositoryRoot: canonicalRepositoryRoot,
    testRoot,
    sandboxRoot,
    ownerMarkerPath: join(sandboxRoot, "harness-owned-v1"),
    sourceRoot: join(sandboxRoot, "source"),
    stagedSkillsRoot: join(sandboxRoot, "source", "skills"),
    homeRoot: join(sandboxRoot, "home"),
    storeRoot: join(sandboxRoot, "store"),
    tempRoot: join(sandboxRoot, "tmp"),
    reportsRoot,
  };
  layout.cleanupPaths = [
    sandboxRoot,
    reportsRoot,
    join(testRoot, "CLAUDE.md"),
    join(testRoot, "AGENTS.md"),
    join(testRoot, ".mcp.json"),
    join(testRoot, ".gitignore"),
    join(testRoot, ".claude"),
    join(testRoot, ".agents"),
    join(testRoot, ".codex"),
    join(testRoot, ".codebuddy"),
  ];
  for (const [name, path] of Object.entries(layout)) {
    if (typeof path === "string" && name !== "repositoryRoot" && name !== "testRoot") {
      assertInside(testRoot, path, name);
    }
  }
  return layout;
}

export function assertIsolatedSourcePool(sourceRoot, layout) {
  const canonicalSource = realpathSync(resolve(sourceRoot));
  for (const candidate of layout.cleanupPaths) {
    if (isSameOrInside(canonicalSource, candidate) || isSameOrInside(candidate, canonicalSource)) {
      throw new Error(`source skill pool overlaps harness-owned mutable path: ${candidate}`);
    }
  }
  return canonicalSource;
}

export function createIsolatedEnvironment(baseEnvironment, layout, mutationAuthority) {
  for (const [name, path] of [
    ["home root", layout.homeRoot],
    ["store root", layout.storeRoot],
    ["temporary root", layout.tempRoot],
  ]) {
    assertInside(layout.testRoot, path, name);
  }
  if (typeof mutationAuthority !== "string" || mutationAuthority.length === 0) {
    throw new Error("mutation authority must be a non-empty string");
  }
  const inherited = {};
  for (const key of [
    "PATH",
    "Path",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "FORCE_COLOR",
    "TZ",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
  ]) {
    if (typeof baseEnvironment[key] === "string") inherited[key] = baseEnvironment[key];
  }
  return {
    ...inherited,
    HOME: layout.homeRoot,
    CELLARER_HOME: layout.storeRoot,
    TMPDIR: layout.tempRoot,
    XDG_CONFIG_HOME: join(layout.homeRoot, ".config"),
    XDG_DATA_HOME: join(layout.homeRoot, ".local", "share"),
    XDG_CACHE_HOME: join(layout.homeRoot, ".cache"),
    CELLARER_MUTATION_AUTHORITY: mutationAuthority,
    NODE_PATH: "",
    CI: "true",
  };
}

export async function fingerprintTree(root) {
  const entries = [];
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`skill pool root must be a real directory: ${root}`);
  }

  async function visit(directory, prefix) {
    const names = await fs.readdir(directory);
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const absolutePath = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`skill pool contains a symbolic link: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        entries.push({ path: relativePath, type: "directory" });
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`skill pool contains a non-regular entry: ${relativePath}`);
      }
      const bytes = await fs.readFile(absolutePath);
      entries.push({
        path: relativePath,
        type: "file",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }

  await visit(root, "");
  const hash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return { hash, entries };
}

export async function stageSkillsPool({ sourceRoot, destinationRoot, testRoot }) {
  const canonicalSource = realpathSync(resolve(sourceRoot));
  const resolvedTestRoot = resolve(testRoot);
  const resolvedDestination = assertInside(resolvedTestRoot, destinationRoot, "staged skill pool");
  const canonicalTestRoot = realpathSync(resolvedTestRoot);
  const canonicalDestination = assertInside(
    canonicalTestRoot,
    join(canonicalTestRoot, relative(resolvedTestRoot, resolvedDestination)),
    "canonical staged skill pool",
  );
  if (canonicalDestination === canonicalTestRoot) {
    throw new Error("staged skill pool cannot replace the test root");
  }
  if (
    isSameOrInside(canonicalSource, canonicalDestination) ||
    isSameOrInside(canonicalDestination, canonicalSource)
  ) {
    throw new Error("source and staged skill pools cannot overlap");
  }
  const sourceBefore = await fingerprintTree(canonicalSource);
  const temporaryDestination = join(
    dirname(canonicalDestination),
    `.${basename(canonicalDestination)}.staging-${process.pid}-${Date.now()}`,
  );
  assertInside(canonicalTestRoot, temporaryDestination, "temporary staged skill pool");

  async function copyDirectory(source, destination) {
    await fs.mkdir(destination, { recursive: true });
    const names = await fs.readdir(source);
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const sourcePath = join(source, name);
      const destinationPath = join(destination, name);
      const stat = await fs.lstat(sourcePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`skill pool contains a symbolic link: ${sourcePath}`);
      }
      if (stat.isDirectory()) {
        await copyDirectory(sourcePath, destinationPath);
      } else if (stat.isFile()) {
        await fs.copyFile(sourcePath, destinationPath);
      } else {
        throw new Error(`skill pool contains a non-regular entry: ${sourcePath}`);
      }
    }
  }

  await fs.mkdir(dirname(canonicalDestination), { recursive: true });
  await fs.rm(temporaryDestination, { recursive: true, force: true });
  try {
    await copyDirectory(canonicalSource, temporaryDestination);
    const staged = await fingerprintTree(temporaryDestination);
    const sourceAfter = await fingerprintTree(canonicalSource);
    if (sourceAfter.hash !== sourceBefore.hash) {
      throw new Error("source skill pool changed while it was being staged");
    }
    if (staged.hash !== sourceBefore.hash) {
      throw new Error("staged skill pool does not match the source fingerprint");
    }
    await fs.rm(canonicalDestination, { recursive: true, force: true });
    await fs.rename(temporaryDestination, canonicalDestination);
    return { sourceBefore, sourceAfter, staged };
  } catch (error) {
    await fs.rm(temporaryDestination, { recursive: true, force: true });
    throw error;
  }
}

function isSameOrInside(parent, target) {
  const path = relative(resolve(parent), resolve(target));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export async function cleanHarnessOutputs(layout) {
  const testRoot = resolve(layout.testRoot);
  const existing = [];
  for (const candidate of layout.cleanupPaths) {
    const target = assertInside(testRoot, candidate, "cleanup path");
    if (target === testRoot) throw new Error("cleanup path cannot be the test root");
    if ((await lstatOrNull(target)) !== null) existing.push(target);
  }
  if (existing.length > 0 && !(await hasValidOwnerMarker(layout))) {
    throw new Error(`refusing to clean unknown harness path: ${existing[0]}`);
  }
  for (const candidate of layout.cleanupPaths) {
    const target = assertInside(testRoot, candidate, "cleanup path");
    await fs.rm(target, { recursive: true, force: true });
  }
  await fs.mkdir(layout.sandboxRoot, { recursive: true });
  await fs.writeFile(layout.ownerMarkerPath, HARNESS_OWNER_MARKER, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function hasValidOwnerMarker(layout) {
  const sandboxStat = await lstatOrNull(layout.sandboxRoot);
  if (!sandboxStat?.isDirectory() || sandboxStat.isSymbolicLink()) return false;
  const markerStat = await lstatOrNull(layout.ownerMarkerPath);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) return false;
  return (await fs.readFile(layout.ownerMarkerPath, "utf8")) === HARNESS_OWNER_MARKER;
}

async function lstatOrNull(path) {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function runSubprocess({
  command,
  args = [],
  cwd,
  env,
  stdin,
  allowFailure = false,
  testRoot,
  maxOutputBytes = 4 * 1024 * 1024,
}) {
  if (testRoot) assertInside(testRoot, cwd, "subprocess working directory");
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let overflow;
    const capture = (chunks) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        overflow = new Error(`subprocess output exceeded ${maxOutputBytes} bytes`);
        child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", rejectResult);
    child.once("close", (code, signal) => {
      if (overflow) {
        rejectResult(overflow);
        return;
      }
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code !== 0 && !allowFailure) {
        const error = new Error(
          `subprocess failed with exit code ${String(code)}${signal ? ` (${signal})` : ""}`,
        );
        error.result = result;
        rejectResult(error);
        return;
      }
      resolveResult(result);
    });
    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin);
  });
}

export async function writeClosedReport({ layout, name, report, secretCanaries = [] }) {
  if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(name)) {
    throw new Error(`invalid report name: ${name}`);
  }
  const allowedKeys = new Set(["mode", "status", "phases", "assertions", "skips"]);
  const unexpectedKeys = Object.keys(report).filter((key) => !allowedKeys.has(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(`report contains unknown fields: ${unexpectedKeys.join(", ")}`);
  }
  if (!["fixture", "real-pool"].includes(report.mode)) throw new Error("invalid report mode");
  if (!["passed", "failed"].includes(report.status)) throw new Error("invalid report status");
  for (const key of ["phases", "assertions", "skips"]) {
    if (!Array.isArray(report[key])) throw new Error(`report ${key} must be an array`);
  }
  const closedReport = { schemaVersion: 1, ...report };
  const serialized = `${JSON.stringify(closedReport, null, 2)}\n`;
  for (const canary of secretCanaries) {
    if (typeof canary === "string" && canary.length > 0 && serialized.includes(canary)) {
      throw new Error("report contains a secret canary");
    }
  }
  const reportsRoot = assertInside(layout.testRoot, layout.reportsRoot, "reports root");
  const reportPath = assertInside(reportsRoot, join(reportsRoot, name), "report path");
  await fs.mkdir(reportsRoot, { recursive: true });
  await fs.writeFile(reportPath, serialized, { encoding: "utf8", flag: "wx" });
  return reportPath;
}
