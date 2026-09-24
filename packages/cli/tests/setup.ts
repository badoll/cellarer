import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealEnv } from "@cellarer/core";
import { afterAll } from "vitest";
import { initStore } from "../../core/src/store/store.js";

const previousHome = process.env.HOME;
const isolatedHome = mkdtempSync(join(tmpdir(), "cellarer-cli-test-home-"));
mkdirSync(join(isolatedHome, ".cellarer"));
process.env.HOME = isolatedHome;
await initStore(createRealEnv(), join(isolatedHome, ".cellarer"));

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});
