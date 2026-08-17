import { isAbsolute, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { InvalidConfigError } from "../src/store/config.js";
import { resolveStoreLayout } from "../src/store/layout.js";
import { observeStoreConfigSnapshot } from "../src/store/snapshot.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const READ_ONLY_SECRET_REFERENCE = "$" + "{CELLARER_SECRET:READ_ONLY}";

describe("store snapshot layout", () => {
  let t: TmpEnv;
  let storeRoot: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("physical-store");
    await t.env.fs.mkdir(storeRoot, { recursive: true });
  });

  afterEach(() => t.cleanup());

  it("layout resolves Store root aliases to one canonical physical identity", async () => {
    const alias = t.path("cwd", "store-alias");
    await t.env.fs.symlink(storeRoot, alias, "dir");

    const direct = await resolveStoreLayout(t.env, storeRoot);
    const throughRelativeAlias = await resolveStoreLayout(t.env, "store-alias");

    expect(direct.canonicalStoreRoot).toBe(storeRoot);
    expect(throughRelativeAlias.canonicalStoreRoot).toBe(storeRoot);
    expect(throughRelativeAlias).toEqual(direct);
    expect(Object.isFrozen(direct)).toBe(true);
  });

  it("layout preserves the current configuration and revision disk paths", async () => {
    const layout = await resolveStoreLayout(t.env, storeRoot);

    expect(layout.configurationPath).toBe(join(storeRoot, "config.json"));
    expect(layout.revisionPath).toBe(join(storeRoot, "revision.json"));
  });

  it("layout keeps every named path inside the canonical Store root", async () => {
    const layout = await resolveStoreLayout(t.env, storeRoot);

    for (const path of [layout.configurationPath, layout.revisionPath]) {
      const relativePath = relative(layout.canonicalStoreRoot, path);
      expect(relativePath).not.toBe("");
      expect(relativePath).not.toBe("..");
      expect(relativePath.startsWith(`..${sep}`)).toBe(false);
      expect(isAbsolute(relativePath)).toBe(false);
    }
  });

  it("layout rejects a managed configuration path that is a symlink", async () => {
    const externalConfig = t.path("external-config.json");
    await t.env.fs.writeFile(externalConfig, '{"external":true}\n');
    await t.env.fs.symlink(externalConfig, join(storeRoot, "config.json"), "file");

    await expect(resolveStoreLayout(t.env, storeRoot)).rejects.toThrow(/configuration.*symlink/i);
  });
});

describe("store snapshot coherence", () => {
  let t: TmpEnv;
  let storeRoot: string;
  let configurationPath: string;
  let revisionPath: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("physical-store");
    configurationPath = join(storeRoot, "config.json");
    revisionPath = join(storeRoot, "revision.json");
    await t.env.fs.mkdir(storeRoot, { recursive: true });
  });

  afterEach(() => t.cleanup());

  it("coherence returns one immutable configuration bound to a stable revision", async () => {
    await writeConfiguration(t, configurationPath, "stable");
    await writeRevision(t, revisionPath, 7);

    const result = await observeStoreConfigSnapshot(t.env, storeRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.canonicalStoreRoot).toBe(storeRoot);
    expect(result.snapshot.revision).toBe(7);
    expect(result.snapshot.configuration.collections.stable?.description).toBe("stable");
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.configuration)).toBe(true);
    expect(Object.isFrozen(result.snapshot.configuration.defaults)).toBe(true);
  });

  it("coherence discards one drifted observation and returns only the retry", async () => {
    await writeConfiguration(t, configurationPath, "discarded");
    await writeRevision(t, revisionPath, 0);
    const baseSnapshotPathNoFollow = t.env.fs.snapshotPathNoFollow;
    let configurationReads = 0;
    let revisionReads = 0;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        snapshotPathNoFollow: async (anchorRoot, path) => {
          const snapshot = await baseSnapshotPathNoFollow(anchorRoot, path);
          if (path === revisionPath) revisionReads += 1;
          if (path === configurationPath) {
            configurationReads += 1;
            if (configurationReads === 1) {
              await writeConfiguration(t, configurationPath, "accepted");
              await writeRevision(t, revisionPath, 1);
            }
          }
          return snapshot;
        },
      },
    };

    const result = await observeStoreConfigSnapshot(env, storeRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.revision).toBe(1);
    expect(result.snapshot.configuration.collections.accepted?.description).toBe("accepted");
    expect(result.snapshot.configuration.collections.discarded).toBeUndefined();
    expect(configurationReads).toBe(2);
    expect(revisionReads).toBe(4);
  });

  it("coherence returns STALE_STORE_SNAPSHOT after drift on both attempts", async () => {
    await writeConfiguration(t, configurationPath, "first");
    await writeRevision(t, revisionPath, 0);
    const baseSnapshotPathNoFollow = t.env.fs.snapshotPathNoFollow;
    let configurationReads = 0;
    let revisionReads = 0;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        snapshotPathNoFollow: async (anchorRoot, path) => {
          const snapshot = await baseSnapshotPathNoFollow(anchorRoot, path);
          if (path === revisionPath) revisionReads += 1;
          if (path === configurationPath) {
            configurationReads += 1;
            await writeConfiguration(
              t,
              configurationPath,
              configurationReads === 1 ? "second" : "third",
            );
            await writeRevision(t, revisionPath, configurationReads);
          }
          return snapshot;
        },
      },
    };

    const result = await observeStoreConfigSnapshot(env, storeRoot);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "STALE_STORE_SNAPSHOT",
        beforeRevision: 1,
        afterRevision: 2,
      },
    });
    expect("snapshot" in result).toBe(false);
    expect(configurationReads).toBe(2);
    expect(revisionReads).toBe(4);
  });
});

describe("store snapshot safety", () => {
  let t: TmpEnv;
  let storeRoot: string;
  let configurationPath: string;
  let revisionPath: string;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("physical-store");
    configurationPath = join(storeRoot, "config.json");
    revisionPath = join(storeRoot, "revision.json");
    await t.env.fs.mkdir(storeRoot, { recursive: true });
  });

  afterEach(() => t.cleanup());

  it("safety returns a typed unsafe result before reading a symlinked configuration target", async () => {
    const externalConfiguration = t.path("external-config.json");
    await t.env.fs.writeFile(externalConfiguration, '{"providerValue":"must-not-be-read"}\n');
    await t.env.fs.symlink(externalConfiguration, configurationPath, "file");
    const baseReadFile = t.env.fs.readFile;
    let externalReads = 0;
    const env: Env = {
      ...t.env,
      fs: {
        ...t.env.fs,
        readFile: async (path) => {
          if (path === externalConfiguration) externalReads += 1;
          return baseReadFile(path);
        },
      },
    };

    const result = await observeStoreConfigSnapshot(env, storeRoot);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "UNSAFE_STORE_OBSERVATION",
        path: configurationPath,
        reason: "symbolic-link",
      },
    });
    expect(externalReads).toBe(0);
    expect(JSON.stringify(result)).not.toContain("must-not-be-read");
  });

  it("safety preserves malformed configuration as an InvalidConfigError", async () => {
    await t.env.fs.writeFile(configurationPath, '{"collections":');

    await expect(observeStoreConfigSnapshot(t.env, storeRoot)).rejects.toMatchObject({
      name: "InvalidConfigError",
      configPath: configurationPath,
    });
    await expect(observeStoreConfigSnapshot(t.env, storeRoot)).rejects.toBeInstanceOf(
      InvalidConfigError,
    );
  });

  it("safety needs no mutation or provider capability and preserves secret references", async () => {
    await t.env.fs.writeFile(
      configurationPath,
      `${JSON.stringify({
        defaults: { secretMode: "keychain" },
        customAdapters: {
          "reference-only": {
            mcp: {
              global: READ_ONLY_SECRET_REFERENCE,
              supportedSecretReferences: ["cellarer"],
            },
          },
        },
      })}\n`,
    );
    await writeRevision(t, revisionPath, 3);
    const readOnlyEnv: Env = { ...t.env };
    delete readOnlyEnv.mutationAuthority;
    delete readOnlyEnv.secretStore;

    const result = await observeStoreConfigSnapshot(readOnlyEnv, storeRoot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.revision).toBe(3);
    expect(result.snapshot.configuration.customAdapters["reference-only"]?.mcp?.global).toBe(
      READ_ONLY_SECRET_REFERENCE,
    );
    expect(JSON.stringify(result.snapshot)).not.toContain("provider-value");
  });
});

async function writeConfiguration(t: TmpEnv, path: string, name: string): Promise<void> {
  await t.env.fs.writeFile(
    path,
    `${JSON.stringify({ collections: { [name]: { description: name } } })}\n`,
  );
}

async function writeRevision(t: TmpEnv, path: string, revision: number): Promise<void> {
  await t.env.fs.writeFile(path, `${JSON.stringify({ schemaVersion: 1, revision })}\n`);
}
