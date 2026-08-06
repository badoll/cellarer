#!/usr/bin/env node
import { chmod, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const binUrl = new URL("../packages/cli/dist/bin.js", import.meta.url);
const contents = await readFile(binUrl, "utf8");

if (!contents.startsWith("#!/usr/bin/env node\n")) {
  throw new Error(`CLI bin is missing its Node shebang: ${fileURLToPath(binUrl)}`);
}

await chmod(binUrl, 0o755);
