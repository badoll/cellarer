#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePaths = [
  "packages/core/package.json",
  "packages/web/package.json",
  "packages/cli/package.json",
];
const internalDependencies = new Set(["@cellarer/core", "@cellarer/web"]);
const args = process.argv.slice(2).filter((argument) => argument !== "--");
const checkOnly = args[0] === "--check";
const requestedVersion = checkOnly ? args[1] : args[0];

if (args.length > (checkOnly ? 2 : 1)) fail("unexpected arguments");

const rootPath = resolve(repositoryRoot, "package.json");
const root = await readJson(rootPath);
if (root.private !== true) fail("the workspace root must remain private");

const packages = await Promise.all(
  packagePaths.map(async (relativePath) => ({
    relativePath,
    path: resolve(repositoryRoot, relativePath),
    manifest: await readJson(resolve(repositoryRoot, relativePath)),
  })),
);

const version = requestedVersion ?? packages[0]?.manifest.version;
if (typeof version !== "string" || !isSemver(version)) {
  fail(`invalid release version: ${String(version)}`);
}

for (const entry of packages) {
  const next = structuredClone(entry.manifest);
  next.version = version;
  for (const dependencyGroup of ["dependencies", "optionalDependencies"]) {
    const dependencies = next[dependencyGroup];
    if (!dependencies || typeof dependencies !== "object") continue;
    for (const dependency of internalDependencies) {
      if (dependency in dependencies) dependencies[dependency] = version;
    }
  }

  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  const current = await readFile(entry.path, "utf8");
  if (checkOnly && current !== serialized) {
    fail(`${entry.relativePath} is not prepared for ${version}`);
  }
  if (!checkOnly && current !== serialized) await writeFile(entry.path, serialized, "utf8");
}

process.stdout.write(`${checkOnly ? "verified" : "prepared"} Core, Web, and CLI at ${version}\n`);

function isSemver(value) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    value,
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
