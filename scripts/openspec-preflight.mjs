#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const riskLevels = new Set(["mechanical", "integration", "high"]);
const proofHeading = /^##\s+(?:Proof Obligations|Attack Matrix|State Matrix)\s*$/im;
const numberedSliceHeading = /^##\s+\d+(?:\.\d+)*\.?\s+(.+)$/gm;
const unboundedScope = /\b(?:all|every|entire)\b|whole[- ]repository/i;
const fullGateCommand = /\bpnpm\s+(?:build|test|lint|typecheck)\b/g;

export function analyzePreflight({
  changeName,
  artifactComplete,
  proposal,
  design,
  tasks,
  dependencyStates,
  overlappingCapabilities,
  validationError,
}) {
  const errors = [];
  const warnings = [];
  const contract = parseExecutionContract(proposal);
  const slices = parseTaskSlices(tasks);

  if (validationError) {
    errors.push(
      finding("openspec-invalid", `Strict OpenSpec validation failed: ${validationError}`),
    );
  }
  if (!artifactComplete) {
    errors.push(
      finding("artifacts-incomplete", `${changeName} has incomplete planning artifacts.`),
    );
  }
  if (!contract.risk) {
    errors.push(finding("missing-risk", "Execution Contract must declare Risk."));
  } else if (!riskLevels.has(contract.risk)) {
    errors.push(
      finding(
        "invalid-risk",
        `Risk must be mechanical, integration, or high; received ${contract.risk}.`,
      ),
    );
  }
  if (contract.dependsOn === null) {
    errors.push(finding("missing-dependencies", "Execution Contract must declare Depends on."));
  }
  if (contract.allowedPaths === null || contract.allowedPaths.length === 0) {
    errors.push(finding("missing-allowed-paths", "Execution Contract must declare Allowed paths."));
  }

  for (const dependency of dependencyStates) {
    if (dependency.state === "active") {
      errors.push(
        finding(
          "dependency-active",
          `Dependency ${dependency.id} is still active and must close first.`,
        ),
      );
    } else if (dependency.state === "missing") {
      errors.push(
        finding(
          "dependency-missing",
          `Dependency ${dependency.id} has no active or archived change.`,
        ),
      );
    }
  }

  if (contract.risk === "high" && !proofHeading.test(design)) {
    errors.push(
      finding(
        "missing-proof-obligations",
        "High-risk work must freeze Proof Obligations, an Attack Matrix, or a State Matrix.",
      ),
    );
  }

  if (slices.length === 0) {
    errors.push(finding("missing-task-slices", "Tasks must contain numbered top-level slices."));
  }
  for (const slice of slices) {
    if (!/^\*\*Verification:\*\*/im.test(slice.body)) {
      errors.push(
        finding(
          "missing-slice-verification",
          `Task slice ${slice.number} (${slice.title}) has no focused Verification.`,
        ),
      );
    }
    if (containsUnboundedScope(slice.body)) {
      errors.push(
        finding(
          "unbounded-slice",
          `Task slice ${slice.number} (${slice.title}) contains unbounded scope language.`,
        ),
      );
    }
  }

  const gateCounts = new Map();
  for (const command of tasks.match(fullGateCommand) ?? []) {
    gateCounts.set(command, (gateCounts.get(command) ?? 0) + 1);
  }
  if ([...gateCounts.values()].some((count) => count > 1)) {
    errors.push(
      finding("repeated-full-gate", "Full-gate commands must appear in only one closure slice."),
    );
  }

  for (const overlap of overlappingCapabilities) {
    warnings.push(
      finding(
        "capability-overlap",
        `${overlap.capability} is also modified by ${overlap.changes.join(", ")}; refresh this change after those dependencies close.`,
      ),
    );
  }

  return { changeName, contract, slices, errors, warnings };
}

export function runPreflight({ root, changeName, runOpenSpec }) {
  const status = runOpenSpec(["status", "--change", changeName, "--json"], {
    json: true,
  });
  const list = runOpenSpec(["list", "--json"], { json: true });
  let validationError = null;
  try {
    runOpenSpec(["validate", changeName, "--strict", "--no-interactive"], {
      json: false,
    });
  } catch (error) {
    validationError = errorOutput(error);
  }

  const proposal = readArtifact(status, "proposal");
  const design = readArtifact(status, "design");
  const tasks = readArtifact(status, "tasks");
  const contract = parseExecutionContract(proposal);
  const activeChanges = new Set(list.changes.map((change) => change.name));
  const archivedChanges = listArchivedChanges(root);
  const dependencyStates = (contract.dependsOn ?? []).map((id) => ({
    id,
    state: activeChanges.has(id) ? "active" : archivedChanges.has(id) ? "archived" : "missing",
  }));
  const selectedCapabilities = new Set(
    (status.artifactPaths.specs?.existingOutputPaths ?? []).map(capabilityFromSpecPath),
  );
  const overlapMap = new Map();
  for (const activeChange of activeChanges) {
    if (activeChange === changeName) continue;
    for (const capability of listChangeCapabilities(root, activeChange)) {
      if (!selectedCapabilities.has(capability)) continue;
      const changes = overlapMap.get(capability) ?? [];
      changes.push(activeChange);
      overlapMap.set(capability, changes);
    }
  }

  return analyzePreflight({
    changeName,
    artifactComplete: status.isComplete,
    proposal,
    design,
    tasks,
    dependencyStates,
    overlappingCapabilities: [...overlapMap]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([capability, changes]) => ({ capability, changes: changes.sort() })),
    validationError,
  });
}

export function parseArguments(args) {
  let changeName = null;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--change") {
      changeName = args[index + 1] ?? null;
      index += 1;
    } else if (argument === "--json") {
      json = true;
    } else {
      throw new Error(usage());
    }
  }
  if (!changeName) throw new Error(usage());
  return { changeName, json };
}

export function formatPreflightResult(result, { json }) {
  if (json) {
    return JSON.stringify(
      {
        status: result.errors.length === 0 ? "passed" : "blocked",
        changeName: result.changeName,
        contract: result.contract,
        slices: result.slices.map(({ number, title }) => ({ number, title })),
        errors: result.errors,
        warnings: result.warnings,
      },
      null,
      2,
    );
  }
  const lines = [
    `OpenSpec preflight ${result.errors.length === 0 ? "PASSED" : "BLOCKED"}: ${result.changeName}`,
  ];
  for (const error of result.errors) lines.push(`ERROR [${error.code}] ${error.message}`);
  for (const warning of result.warnings) {
    lines.push(`WARNING [${warning.code}] ${warning.message}`);
  }
  return lines.join("\n");
}

export function parseExecutionContract(proposal) {
  return {
    risk: readField(proposal, "Risk")?.toLowerCase() ?? null,
    dependsOn: readListField(proposal, "Depends on"),
    allowedPaths: readListField(proposal, "Allowed paths"),
  };
}

export function parseTaskSlices(tasks) {
  const headings = [...tasks.matchAll(numberedSliceHeading)];
  return headings.map((heading, index) => {
    const marker = heading[0].match(/^##\s+(\d+(?:\.\d+)*)/);
    const start = (heading.index ?? 0) + heading[0].length;
    const end = headings[index + 1]?.index ?? tasks.length;
    return {
      number: marker?.[1] ?? String(index + 1),
      title: heading[1].trim(),
      body: tasks.slice(start, end),
    };
  });
}

function readListField(markdown, label) {
  const value = readField(markdown, label);
  if (value === null) return null;
  if (value.toLowerCase() === "none") return [];
  return value
    .split(",")
    .map((item) => item.trim().replace(/^`|`$/g, ""))
    .filter(Boolean);
}

function readField(markdown, label) {
  const match = markdown.match(new RegExp(`^\\s*-\\s*${label}:\\s*(.+?)\\s*$`, "im"));
  return match?.[1]?.trim() ?? null;
}

function containsUnboundedScope(markdown) {
  return unboundedScope.test(markdown.replace(/`[^`\n]*`/g, ""));
}

function readArtifact(status, id) {
  const path = status.artifactPaths[id]?.existingOutputPaths?.[0];
  if (!path) throw new Error(`OpenSpec status did not report an existing ${id} artifact.`);
  return readFileSync(path, "utf8");
}

function listArchivedChanges(root) {
  const archiveRoot = join(root, "openspec", "changes", "archive");
  if (!existsSync(archiveRoot)) return new Set();
  return new Set(
    readdirSync(archiveRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name.replace(/^\d{4}-\d{2}-\d{2}-/, "")),
  );
}

function listChangeCapabilities(root, changeName) {
  const specsRoot = join(root, "openspec", "changes", changeName, "specs");
  if (!existsSync(specsRoot)) return [];
  return readdirSync(specsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(specsRoot, entry.name, "spec.md")))
    .map((entry) => entry.name);
}

function capabilityFromSpecPath(path) {
  return basename(dirname(path));
}

function errorOutput(error) {
  if (typeof error === "object" && error !== null) {
    const stderr = "stderr" in error ? String(error.stderr).trim() : "";
    const stdout = "stdout" in error ? String(error.stdout).trim() : "";
    if (stderr || stdout) return stderr || stdout;
  }
  return error instanceof Error ? error.message : String(error);
}

function createOpenSpecRunner(root) {
  return (args, { json }) => {
    const output = execFileSync("openspec", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
    return json ? JSON.parse(output) : output;
  };
}

function findRepositoryRoot(start) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "openspec", "config.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("No openspec/config.yaml found above cwd.");
    current = parent;
  }
}

function usage() {
  return "Usage: pnpm openspec:preflight --change <change-id> [--json]";
}

function finding(code, message) {
  return { code, message };
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const root = findRepositoryRoot(process.cwd());
    const result = runPreflight({
      root,
      changeName: options.changeName,
      runOpenSpec: createOpenSpecRunner(root),
    });
    process.stdout.write(`${formatPreflightResult(result, options)}\n`);
    process.exitCode = result.errors.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${errorOutput(error)}\n`);
    process.exitCode = 2;
  }
}
