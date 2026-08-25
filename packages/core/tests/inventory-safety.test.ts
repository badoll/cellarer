import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { refreshInventory } from "../src/inventory/projector.js";
import { initStore } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const SECRET_CANARY = "ghp_1234567890abcdefghij1234567890";

describe("unified Inventory read-only safety", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it("performs no write or protected-capability interaction and exposes no observed secret", async () => {
    const sourcePath = t.path("home", ".agents", "AGENTS.md");
    await t.env.fs.mkdir(join(sourcePath, ".."), { recursive: true });
    await t.env.fs.writeFile(sourcePath, `Never publish ${SECRET_CANARY}\n`);
    const beforeStore = await t.env.fs.snapshotTreeNoFollow(storeRoot);
    const beforeSource = await t.env.fs.snapshotFileNoFollow(sourcePath);
    const forbiddenCalls: string[] = [];
    const forbidden = (capability: string): never => {
      forbiddenCalls.push(capability);
      throw new Error(`Inventory used forbidden capability ${capability}`);
    };
    const guardedFs: Env["fs"] = {
      ...t.env.fs,
      writeFile: async () => forbidden("fs.writeFile"),
      writeFileBytes: async () => forbidden("fs.writeFileBytes"),
      writeFileExclusive: async () => forbidden("fs.writeFileExclusive"),
      publishFileAtomically: async () => forbidden("fs.publishFileAtomically"),
      appendFile: async () => forbidden("fs.appendFile"),
      mkdir: async () => forbidden("fs.mkdir"),
      chmod: async () => forbidden("fs.chmod"),
      rm: async () => forbidden("fs.rm"),
      symlink: async () => forbidden("fs.symlink"),
      copyFile: async () => forbidden("fs.copyFile"),
      cp: async () => forbidden("fs.cp"),
      rename: async () => forbidden("fs.rename"),
      access: async (path, mode) =>
        mode === "write" ? forbidden("fs.access.write") : t.env.fs.access(path, mode),
    };
    const guardedEnv: Env = {
      ...t.env,
      fs: guardedFs,
      env: { INVENTORY_SECRET_CANARY: SECRET_CANARY },
      secretStore: {
        get: async () => forbidden("secretStore.get"),
        set: async () => forbidden("secretStore.set"),
        delete: async () => forbidden("secretStore.delete"),
      },
      currentUserOnlyPermissions: {
        supported: () => forbidden("permissions.supported"),
        set: async () => forbidden("permissions.set"),
        verify: async () => forbidden("permissions.verify"),
      },
      headlessLifetimeOwner: {
        acquire: async () => forbidden("headlessLifetimeOwner.acquire"),
      },
      mutationAuthority: {
        seal: () => forbidden("mutationAuthority.seal"),
        verify: () => forbidden("mutationAuthority.verify"),
        isCurrent: async () => forbidden("mutationAuthority.isCurrent"),
        acquireLease: async () => forbidden("mutationAuthority.acquireLease"),
        publishJournalTip: async () => forbidden("mutationAuthority.publishJournalTip"),
        matchesJournalTip: async () => forbidden("mutationAuthority.matchesJournalTip"),
      },
      resourceSourceTransport: {
        check: async () => forbidden("resourceSourceTransport.check"),
        fetch: async () => forbidden("resourceSourceTransport.fetch"),
      },
    };

    const result = await refreshInventory(guardedEnv, {
      storeRoot,
      agentId: "agents-md",
    });

    expect(forbiddenCalls).toEqual([]);
    expect(result).toMatchObject({
      completeness: "complete",
      candidates: [
        {
          kind: "rules",
          state: "needs-attention",
          defaultSelected: false,
          findings: [{ code: "PROBABLE_SECRET" }],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
    expect(await guardedFs.snapshotTreeNoFollow(storeRoot)).toEqual(beforeStore);
    expect(await guardedFs.snapshotFileNoFollow(sourcePath)).toEqual(beforeSource);
  });
});
