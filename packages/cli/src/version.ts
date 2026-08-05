import { readFileSync } from "node:fs";

interface CliPackageMetadata {
  readonly version?: unknown;
}

export const CLI_PACKAGE_VERSION = readCliPackageVersion();

function readCliPackageVersion(): string {
  const metadata = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as CliPackageMetadata;
  if (typeof metadata.version !== "string" || metadata.version.trim().length === 0) {
    throw new Error("@cellarer/cli package metadata is missing a valid version");
  }
  return metadata.version;
}
