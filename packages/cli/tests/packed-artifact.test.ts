import { execFileSync } from "node:child_process";
import { promises as fs, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

describe("packed CLI artifact", () => {
  it("prints the version declared by the packed artifact metadata", async () => {
    const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
    const temporaryRoot = mkdtempSync(join(tmpdir(), "cellarer-cli-pack-"));
    temporaryDirectories.push(temporaryRoot);
    const stagingRoot = join(temporaryRoot, "staging");
    const artifactRoot = join(temporaryRoot, "artifacts");
    const extractedRoot = join(temporaryRoot, "installed");
    await fs.mkdir(artifactRoot, { recursive: true });
    await fs.mkdir(extractedRoot, { recursive: true });
    await fs.cp(join(packageRoot, "dist"), join(stagingRoot, "dist"), { recursive: true });

    const packageMetadata = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    await fs.writeFile(
      join(stagingRoot, "package.json"),
      `${JSON.stringify({ ...packageMetadata, version: "9.8.7-packed-artifact" }, null, 2)}\n`,
      "utf8",
    );

    const tarballName = execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", artifactRoot],
      {
        cwd: stagingRoot,
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: join(temporaryRoot, "npm-cache") },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    execFileSync("tar", ["-xzf", join(artifactRoot, tarballName), "-C", extractedRoot]);

    const installedPackageRoot = join(extractedRoot, "package");
    await fs.symlink(
      join(packageRoot, "node_modules"),
      join(installedPackageRoot, "node_modules"),
      "dir",
    );
    const installedMetadata = JSON.parse(
      readFileSync(join(installedPackageRoot, "package.json"), "utf8"),
    ) as { version: string };
    const output = execFileSync(
      process.execPath,
      [join(installedPackageRoot, "dist", "bin.js"), "--version"],
      { cwd: installedPackageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();

    expect(output).toBe(installedMetadata.version);

    const discovery = JSON.parse(
      execFileSync(
        process.execPath,
        [join(installedPackageRoot, "dist", "bin.js"), "--output", "json", "capabilities"],
        { cwd: installedPackageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    ) as { status?: string; command?: string; data?: { protocolVersions?: string[] } };
    expect(discovery).toMatchObject({
      status: "success",
      command: "capabilities",
      data: { protocolVersions: ["1.0"] },
    });
  });
});
