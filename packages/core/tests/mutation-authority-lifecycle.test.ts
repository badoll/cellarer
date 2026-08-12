import { describe, expect, it } from "vitest";
import { assertMutationAuthorityRotationAllowed } from "../src/protocol/authority-lifecycle.js";
import { operationJournalPath } from "../src/protocol/journal.js";
import { ensureBaseDirs, makeTmpEnv } from "./helpers/env.js";

describe("mutation authority lifecycle", () => {
  it("allows rotation only when no active journal exists", async () => {
    const t = makeTmpEnv();
    try {
      await ensureBaseDirs(t);
      const storeRoot = t.path("home", ".cellarer");

      await expect(
        assertMutationAuthorityRotationAllowed(t.env, storeRoot),
      ).resolves.toBeUndefined();

      const journalPath = operationJournalPath(storeRoot);
      await t.env.fs.mkdir(t.path("home", ".cellarer", "operations"), { recursive: true });
      await t.env.fs.writeFile(journalPath, "unsigned-or-interrupted-record\n", { mode: 0o600 });

      await expect(assertMutationAuthorityRotationAllowed(t.env, storeRoot)).rejects.toMatchObject({
        code: "MUTATION_AUTHORITY_ROTATION_FAILURE",
        failure: "active-journal",
      });
    } finally {
      await t.cleanup();
    }
  });
});
