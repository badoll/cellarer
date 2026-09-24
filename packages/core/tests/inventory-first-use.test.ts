import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { refreshInventory } from "../src/inventory/projector.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv } from "./helpers/env.js";

describe("isolated first-use Inventory topology", () => {
  it("observes ordinary and shared linked Skills, Rules, and inert MCP without external effects", async () => {
    const t = makeTmpEnv();
    try {
      await ensureBaseDirs(t);
      const storeRoot = t.path("home", ".cellarer");
      const projectRoot = t.path("project");
      const shared = t.path("home", ".agents", "skills", "shared");
      const claudeSkills = t.path("home", ".claude", "skills");
      const cursorSkills = t.path("home", ".cursor", "skills");
      await initStore(t.env, storeRoot);
      await t.env.fs.mkdir(projectRoot, { recursive: true });
      await t.env.fs.mkdir(shared, { recursive: true });
      await t.env.fs.mkdir(join(claudeSkills, "ordinary"), { recursive: true });
      await t.env.fs.mkdir(cursorSkills, { recursive: true });
      await t.env.fs.writeFile(
        join(shared, "SKILL.md"),
        `---\nname: shared\ndescription: Shared fixture\n---\n# Shared\nExample: build-\${BUILD_ID}.json\n`,
      );
      await t.env.fs.writeFile(
        join(claudeSkills, "ordinary", "SKILL.md"),
        "---\nname: ordinary\ndescription: Ordinary fixture\n---\n# Ordinary\n",
      );
      await t.env.fs.symlink(shared, join(claudeSkills, "shared"), "dir");
      await t.env.fs.symlink(shared, join(cursorSkills, "shared"), "dir");
      await t.env.fs.writeFile(t.path("home", ".agents", "AGENTS.md"), "# Rules fixture\n");
      await t.env.fs.writeFile(
        join(projectRoot, ".mcp.json"),
        JSON.stringify({ mcpServers: { inert: { command: "fixture-command", args: ["--dry"] } } }),
      );

      const beforeStore = await t.env.fs.snapshotTreeNoFollow(storeRoot);
      const beforeShared = await t.env.fs.snapshotTreeNoFollow(shared);
      const forbidden: string[] = [];
      const fail = (action: string): never => {
        forbidden.push(action);
        throw new Error(`Inventory attempted ${action}`);
      };
      const env: Env = {
        ...t.env,
        fs: {
          ...t.env.fs,
          writeFile: async () => fail("writeFile"),
          writeFileBytes: async () => fail("writeFileBytes"),
          publishFileAtomically: async () => fail("publishFileAtomically"),
          mkdir: async () => fail("mkdir"),
          rm: async () => fail("rm"),
          rename: async () => fail("rename"),
        },
        secretStore: {
          get: async () => fail("secretStore.get"),
          set: async () => fail("secretStore.set"),
          delete: async () => fail("secretStore.delete"),
        },
      };
      const result = await refreshInventory(env, { storeRoot, projectRoot });

      expect(forbidden).toEqual([]);
      expect(result.candidates.map(({ name }) => name)).toEqual(
        expect.arrayContaining(["shared", "ordinary", "AGENTS"]),
      );
      expect(result.candidates.some(({ kind, name }) => kind === "mcp" && name === "inert")).toBe(
        true,
      );
      const sharedCandidate = result.candidates.find(({ name }) => name === "shared");
      expect(sharedCandidate?.sources.map(({ location }) => location)).toEqual([
        "~/.agents/skills/shared",
        "~/.claude/skills/shared",
        "~/.cursor/skills/shared",
      ]);
      expect(result.coverage.some(({ kind, scope }) => kind === "mcp" && scope === "project")).toBe(
        true,
      );
      expect(JSON.stringify(result)).not.toContain(t.root);
      expect(await t.env.fs.snapshotTreeNoFollow(storeRoot)).toEqual(beforeStore);
      expect(await t.env.fs.snapshotTreeNoFollow(shared)).toEqual(beforeShared);
    } finally {
      await t.cleanup();
    }
  });
});
