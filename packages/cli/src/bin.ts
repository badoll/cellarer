#!/usr/bin/env node
import { CLI_PACKAGE_VERSION } from "./version.js";

if (isStandaloneVersionRequest(process.argv)) {
  process.stdout.write(`${CLI_PACKAGE_VERSION}\n`);
} else {
  const { runCli } = await import("./runner.js");
  await runCli(process.argv);
}

function isStandaloneVersionRequest(argv: readonly string[]): boolean {
  return argv.length === 3 && (argv[2] === "--version" || argv[2] === "-V");
}
