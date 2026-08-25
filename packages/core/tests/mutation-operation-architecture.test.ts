import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const coreRoot = resolve(import.meta.dirname, "../src");

function source(path: string): string {
  return readFileSync(resolve(coreRoot, path), "utf8");
}

describe("mutation operation architecture", () => {
  it("keeps prepared effect invocation behind the operation execution composition", () => {
    const candidatePaths = [
      "engine/apply.ts",
      "engine/revert.ts",
      "engine/uninstall.ts",
      "inventory/adoption.ts",
      "inventory/import.ts",
      "protocol/store-mutation.ts",
      "resources/lifecycle.ts",
      "resources/update.ts",
    ];
    const directKernelCallers = candidatePaths.filter((path) =>
      /\bexecuteMutationPlan\s*\(/u.test(source(path)),
    );
    expect(directKernelCallers, "domain code must not invoke the mutation kernel directly").toEqual(
      [],
    );
  });

  it("keeps the closed registry inside Core protocol composition", () => {
    const callers = ["protocol/execute.ts", "protocol/recovery.ts"].map((path) => ({
      path: relative(coreRoot, resolve(coreRoot, path)),
      content: source(path),
    }));
    expect(callers.every(({ content }) => content.includes("operation-adapter.js"))).toBe(true);
  });
});
