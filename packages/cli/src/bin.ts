#!/usr/bin/env node
const MINIMUM_NODE_VERSION = [20, 19, 0] as const;

if (!isSupportedNode(process.versions.node)) {
  process.stderr.write(
    `cellarer: Node.js >=20.19 is required; current runtime is ${process.versions.node}.\n`,
  );
  process.exitCode = 1;
} else if (isStandaloneVersionRequest(process.argv)) {
  const { CLI_PACKAGE_VERSION } = await import("./version.js");
  process.stdout.write(`${CLI_PACKAGE_VERSION}\n`);
} else {
  const { runCli } = await import("./runner.js");
  await runCli(process.argv);
}

function isSupportedNode(version: string): boolean {
  const current = version.split(".").map(Number);
  for (let index = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
    const difference = (current[index] ?? 0) - (MINIMUM_NODE_VERSION[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function isStandaloneVersionRequest(argv: readonly string[]): boolean {
  return argv.length === 3 && (argv[2] === "--version" || argv[2] === "-V");
}
