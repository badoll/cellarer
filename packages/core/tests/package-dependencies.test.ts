import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("core production dependency boundary", () => {
  it("contains only explicitly authorized production dependencies", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const lockfile = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");

    expect(Object.keys(packageJson.dependencies ?? {}).sort()).toEqual([
      "age-encryption",
      "smol-toml",
      "yaml",
      "zod",
    ]);
    expect(packageJson.dependencies?.yaml).toBe("catalog:");
    expect(lockfile).toContain("yaml@2.9.1:");
    expect(lockfile).not.toMatch(/(?:^|\/)koffi(?:@|:)/m);
    expect(lockfile).not.toContain("@koromix/koffi-");
  });
});
