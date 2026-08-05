import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("core production dependency boundary", () => {
  it("13.1 contains only dependencies declared by the reference-only proposal", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const lockfile = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");

    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([
      "age-encryption",
      "smol-toml",
      "zod",
    ]);
    expect(lockfile).not.toMatch(/(?:^|\/)koffi(?:@|:)/m);
    expect(lockfile).not.toContain("@koromix/koffi-");
  });
});
