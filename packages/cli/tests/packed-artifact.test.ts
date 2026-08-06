import { execFileSync } from "node:child_process";
import { promises as fs, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

describe("packed CLI artifact", () => {
  it("resolves an optional dependency through the installed CLI's real pnpm location", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "cellarer-cli-optional-resolution-"));
    temporaryDirectories.push(temporaryRoot);
    const projectRoot = join(temporaryRoot, "consumer");
    const cliRoot = join(
      projectRoot,
      "node_modules",
      ".pnpm",
      "@cellarer+cli@file+cli",
      "node_modules",
      "@cellarer",
      "cli",
    );
    const keyringRoot = join(
      projectRoot,
      "node_modules",
      ".pnpm",
      "@napi-rs+keyring@1.3.0",
      "node_modules",
      "@napi-rs",
      "keyring",
    );
    await fs.mkdir(join(cliRoot, "node_modules", "@napi-rs"), { recursive: true });
    await fs.mkdir(keyringRoot, { recursive: true });
    await fs.writeFile(join(cliRoot, "package.json"), '{"name":"@cellarer/cli"}\n');
    await fs.writeFile(
      join(keyringRoot, "package.json"),
      '{"name":"@napi-rs/keyring","main":"index.js"}\n',
    );
    await fs.writeFile(join(keyringRoot, "index.js"), "module.exports = {};\n");
    await fs.symlink(keyringRoot, join(cliRoot, "node_modules", "@napi-rs", "keyring"));
    await fs.mkdir(join(projectRoot, "node_modules", "@cellarer"), { recursive: true });
    await fs.symlink(cliRoot, join(projectRoot, "node_modules", "@cellarer", "cli"));

    const helperUrl = pathToFileURL(
      join(
        dirname(fileURLToPath(new URL("../..", import.meta.url))),
        "scripts",
        "artifact-release-gate-helpers.mjs",
      ),
    );
    const helper = await import(helperUrl.href).catch(() => ({}));
    expect(helper.optionalKeychainInstalled).toBeTypeOf("function");
    expect(helper.optionalKeychainInstalled({ projectRoot })).toBe(true);

    const withoutOptionalProjectRoot = join(temporaryRoot, "consumer-without-optional");
    const withoutOptionalCliRoot = join(
      withoutOptionalProjectRoot,
      "node_modules",
      ".pnpm",
      "@cellarer+cli@file+cli",
      "node_modules",
      "@cellarer",
      "cli",
    );
    await fs.mkdir(withoutOptionalCliRoot, { recursive: true });
    await fs.writeFile(join(withoutOptionalCliRoot, "package.json"), '{"name":"@cellarer/cli"}\n');
    await fs.mkdir(join(withoutOptionalProjectRoot, "node_modules", "@cellarer"), {
      recursive: true,
    });
    await fs.symlink(
      withoutOptionalCliRoot,
      join(withoutOptionalProjectRoot, "node_modules", "@cellarer", "cli"),
    );
    expect(helper.optionalKeychainInstalled({ projectRoot: withoutOptionalProjectRoot })).toBe(
      false,
    );
  });

  it("keeps the release gate's installed and manifest contracts explicit", () => {
    const gate = readFileSync(
      join(
        dirname(fileURLToPath(new URL("../..", import.meta.url))),
        "scripts",
        "artifact-release-gate.mjs",
      ),
      "utf8",
    );

    expect(gate).toContain('"--dry-run"');
    expect(gate).toContain("KEYCHAIN_MODULE_UNAVAILABLE");
    expect(gate).toContain("KEYCHAIN_SMOKE_ISOLATION_UNAVAILABLE");
    expect(gate).toContain("optionalKeychainInstalled(installed)");
    expect(gate).toContain("credential-store-not-isolated");
    expect(gate).toContain("requiredEntries");
    expect(gate).toContain("assertPublicManifest");
    expect(gate).toContain("includeOptionalDependencies: true");
  });

  it("rejects unsupported Node before creating isolated state", async () => {
    const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
    const temporaryRoot = mkdtempSync(join(tmpdir(), "cellarer-cli-node-gate-"));
    temporaryDirectories.push(temporaryRoot);
    const storeRoot = join(temporaryRoot, "store");
    const preload = join(temporaryRoot, "unsupported-node.cjs");
    await fs.writeFile(
      preload,
      'Object.defineProperty(process.versions, "node", { value: "18.0.0" });\n',
      "utf8",
    );

    let failure: (Error & { status?: number; stderr?: string }) | undefined;
    try {
      execFileSync(
        process.execPath,
        ["--require", preload, join(packageRoot, "dist", "bin.js"), "init", "--agent", "codex"],
        {
          cwd: temporaryRoot,
          encoding: "utf8",
          env: { ...process.env, HOME: join(temporaryRoot, "home"), CELLARER_HOME: storeRoot },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      failure = error as Error & { status?: number; stderr?: string };
    }
    expect(failure?.status).toBe(1);
    expect(failure?.stderr).toMatch(/Node\.js >=20\.19 is required.*18\.0\.0/i);
    let accessError = "";
    try {
      await fs.access(storeRoot);
    } catch (error) {
      accessError = (error as NodeJS.ErrnoException).code ?? "";
    }
    expect(accessError).toBe("ENOENT");
  });

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
    const installedBin = join(installedPackageRoot, "dist", "bin.js");
    expect((await fs.readFile(installedBin, "utf8")).startsWith("#!/usr/bin/env node\n")).toBe(
      true,
    );
    expect((await fs.stat(installedBin)).mode & 0o111).toBe(0o111);
    await fs.symlink(
      join(packageRoot, "node_modules"),
      join(installedPackageRoot, "node_modules"),
      "dir",
    );
    const installedMetadata = JSON.parse(
      readFileSync(join(installedPackageRoot, "package.json"), "utf8"),
    ) as { version: string };
    const output = execFileSync(process.execPath, [installedBin, "--version"], {
      cwd: installedPackageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    expect(output).toBe(installedMetadata.version);

    const discovery = JSON.parse(
      execFileSync(process.execPath, [installedBin, "--output", "json", "capabilities"], {
        cwd: installedPackageRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as { status?: string; command?: string; data?: { protocolVersions?: string[] } };
    expect(discovery).toMatchObject({
      status: "success",
      command: "capabilities",
      data: { protocolVersions: ["1.0"] },
    });
  });
});
