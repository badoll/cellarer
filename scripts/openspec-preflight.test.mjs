import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  analyzePreflight,
  formatPreflightResult,
  parseArguments,
  runPreflight,
} from "./openspec-preflight.mjs";

const validInput = {
  changeName: "example-change",
  artifactComplete: true,
  proposal: `
## Execution Contract

- Risk: integration
- Depends on: none
- Allowed paths: packages/core, packages/cli
`,
  design: "## Decisions\n\nKeep the boundary narrow.\n",
  tasks: `
## 1. Core slice

**Verification:** \`pnpm exec vitest run packages/core/tests/example.test.ts\`

- [ ] 1.1 Add the focused behavior.

## 2. Completion gate

**Verification:** full repository gate

- [ ] 2.1 Run \`pnpm build\`, \`pnpm test\`, \`pnpm lint\`, and \`pnpm typecheck\`.
`,
  dependencyStates: [],
  overlappingCapabilities: [],
};

describe("analyzePreflight", () => {
  it("accepts a bounded integration change with one verification per slice", () => {
    const result = analyzePreflight(validInput);

    expect(result.errors).toEqual([]);
    expect(result.contract).toEqual({
      risk: "integration",
      dependsOn: [],
      allowedPaths: ["packages/core", "packages/cli"],
    });
    expect(result.slices).toHaveLength(2);
  });

  it("blocks a change without an explicit execution contract", () => {
    const result = analyzePreflight({
      ...validInput,
      proposal: "## Why\n\nThe change is useful.\n",
    });

    expect(result.errors.map((finding) => finding.code)).toEqual([
      "missing-risk",
      "missing-dependencies",
      "missing-allowed-paths",
    ]);
  });

  it("blocks active or unknown dependencies", () => {
    const result = analyzePreflight({
      ...validInput,
      proposal: validInput.proposal.replace(
        "Depends on: none",
        "Depends on: active-change, missing-change",
      ),
      dependencyStates: [
        { id: "active-change", state: "active" },
        { id: "missing-change", state: "missing" },
      ],
    });

    expect(result.errors.map((finding) => finding.code)).toEqual([
      "dependency-active",
      "dependency-missing",
    ]);
  });

  it("requires frozen proof obligations for high-risk work", () => {
    const result = analyzePreflight({
      ...validInput,
      proposal: validInput.proposal.replace("integration", "high"),
    });

    expect(result.errors.map((finding) => finding.code)).toContain("missing-proof-obligations");
  });

  it("blocks unverified, unbounded slices and repeated full gates", () => {
    const result = analyzePreflight({
      ...validInput,
      tasks: `
## 1. Broad migration

- [ ] 1.1 Migrate every consumer across the whole repository.

## 2. First gate

**Verification:** full gate

- [ ] 2.1 Run pnpm test.

## 3. Second gate

**Verification:** full gate again

- [ ] 3.1 Run pnpm test again.
`,
    });

    expect(result.errors.map((finding) => finding.code)).toEqual([
      "missing-slice-verification",
      "unbounded-slice",
      "repeated-full-gate",
    ]);
  });

  it("reports overlapping active capabilities without creating another blocker", () => {
    const result = analyzePreflight({
      ...validInput,
      overlappingCapabilities: [{ capability: "cli-control-plane", changes: ["later-change"] }],
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings.map((finding) => finding.code)).toEqual(["capability-overlap"]);
  });

  it("does not treat a mechanically bounded command flag as unbounded prose", () => {
    const result = analyzePreflight({
      ...validInput,
      tasks: validInput.tasks.replace(
        "full repository gate",
        "full repository gate with `openspec validate --all --strict`",
      ),
    });

    expect(result.errors).toEqual([]);
  });

  it("turns strict OpenSpec validation failure into a preflight blocker", () => {
    const result = analyzePreflight({
      ...validInput,
      validationError: "delta requirement is invalid",
    });

    expect(result.errors[0]).toEqual({
      code: "openspec-invalid",
      message: "Strict OpenSpec validation failed: delta requirement is invalid",
    });
  });

  it("reads real artifacts and resolves dependency and capability state", async () => {
    const root = await mkdtemp(join(tmpdir(), "cellarer-openspec-preflight-"));
    const selectedRoot = join(root, "openspec", "changes", "selected-change");
    const activeRoot = join(root, "openspec", "changes", "active-change");
    const archiveRoot = join(root, "openspec", "changes", "archive", "2026-08-17-archived-change");
    const proposalPath = join(selectedRoot, "proposal.md");
    const designPath = join(selectedRoot, "design.md");
    const tasksPath = join(selectedRoot, "tasks.md");
    const selectedSpec = join(selectedRoot, "specs", "shared-capability", "spec.md");
    const activeSpec = join(activeRoot, "specs", "shared-capability", "spec.md");

    try {
      await Promise.all([
        mkdir(join(selectedRoot, "specs", "shared-capability"), { recursive: true }),
        mkdir(join(activeRoot, "specs", "shared-capability"), { recursive: true }),
        mkdir(archiveRoot, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          proposalPath,
          validInput.proposal.replace(
            "Depends on: none",
            "Depends on: archived-change, active-change",
          ),
        ),
        writeFile(designPath, validInput.design),
        writeFile(tasksPath, validInput.tasks),
        writeFile(selectedSpec, "## ADDED Requirements\n"),
        writeFile(activeSpec, "## MODIFIED Requirements\n"),
      ]);

      const status = {
        isComplete: true,
        artifactPaths: {
          proposal: { existingOutputPaths: [proposalPath] },
          design: { existingOutputPaths: [designPath] },
          tasks: { existingOutputPaths: [tasksPath] },
          specs: { existingOutputPaths: [selectedSpec] },
        },
      };
      const runOpenSpec = (args) => {
        if (args[0] === "status") return status;
        if (args[0] === "list") {
          return {
            changes: [{ name: "selected-change" }, { name: "active-change" }],
          };
        }
        return "valid";
      };

      const result = runPreflight({
        root,
        changeName: "selected-change",
        runOpenSpec,
      });

      expect(result.errors.map((finding) => finding.code)).toEqual(["dependency-active"]);
      expect(result.warnings).toEqual([
        {
          code: "capability-overlap",
          message:
            "shared-capability is also modified by active-change; refresh this change after those dependencies close.",
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses the selected change and machine-readable output option", () => {
    expect(parseArguments(["--change", "example-change", "--json"])).toEqual({
      changeName: "example-change",
      json: true,
    });
    expect(() => parseArguments([])).toThrow("Usage:");
  });

  it("formats a blocked result with stable finding codes", () => {
    const result = {
      ...analyzePreflight(validInput),
      errors: [{ code: "dependency-active", message: "dependency is active" }],
      warnings: [{ code: "capability-overlap", message: "capability overlaps" }],
    };

    expect(formatPreflightResult(result, { json: false })).toBe(
      [
        "OpenSpec preflight BLOCKED: example-change",
        "ERROR [dependency-active] dependency is active",
        "WARNING [capability-overlap] capability overlaps",
      ].join("\n"),
    );
    const machineResult = JSON.parse(formatPreflightResult(result, { json: true }));
    expect(machineResult.status).toBe("blocked");
    expect(machineResult.errors[0].code).toBe("dependency-active");
    expect(machineResult.slices[0]).toEqual({ number: "1", title: "Core slice" });
    expect(machineResult.slices[0]).not.toHaveProperty("body");
  });
});
