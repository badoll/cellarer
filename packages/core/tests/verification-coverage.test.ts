import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apply } from "../src/engine/apply.js";
import { verify } from "../src/engine/verification.js";
import { loadConfig, saveConfig } from "../src/store/config.js";
import { initStore, writeMcpArtifact, writeRuleArtifact } from "../src/store/store.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

describe("verification request coverage", () => {
  let t: TmpEnv;
  let storeRoot: string;
  const options = () => ({ storeRoot, scope: "global" as const, agents: ["claude-code"] });
  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
    storeRoot = t.path("home", ".cellarer");
    await initStore(t.env, storeRoot);
  });
  afterEach(() => t.cleanup());

  it("rejects an unknown identity before inspecting resources or acquiring authority", async () => {
    const snapshot = vi.spyOn(t.env.fs, "snapshotPathNoFollow");
    await expect(
      verify({ ...t.env, mutationAuthority: undefined }, { ...options(), agents: ["unknown"] }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("deduplicates valid empty requests and reports no-op, never healthy", async () => {
    const report = await verify(t.env, {
      ...options(),
      agents: ["claude-code", "claude-code"],
      capabilities: ["rules", "rules"],
    });
    expect(report).toMatchObject({
      configuration: "no-op",
      healthy: false,
      runtime: { observation: "unknown" },
      coverage: {
        expected: 1,
        observed: 1,
        failed: 0,
        complete: true,
        items: [{ outcome: "no-op" }],
      },
    });
  });

  it("keeps disabled and unsupported requests incomplete", async () => {
    const config = await loadConfig(t.env, storeRoot);
    config.adapterOverrides["claude-code"] = { enabled: false };
    config.customAdapters["rules-only"] = {
      displayName: "Rules only",
      rules: { global: "~/.rules-only/RULES.md" },
    };
    await saveConfig(t.env, storeRoot, config);
    await t.env.fs.writeFile(t.path("home", ".cellarer", "store", "mcp", "bad.json"), "{bad");
    const report = await verify(t.env, {
      ...options(),
      agents: ["claude-code", "rules-only"],
      capabilities: ["mcp"],
    });
    expect(report).toMatchObject({
      configuration: "incomplete",
      healthy: false,
      coverage: {
        expected: 2,
        observed: 0,
        complete: false,
        items: [{ outcome: "disabled" }, { outcome: "unsupported" }],
      },
    });
  });

  it("retains successful comparisons when another capability cannot be parsed", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "Be clear");
    await apply(t.env, options());
    await writeMcpArtifact(t.env, storeRoot, "broken", { kind: "stdio", command: "example" });
    await t.env.fs.writeFile(
      t.path("home", ".cellarer", "store", "mcp", "broken.json"),
      "{bad json",
    );
    const report = await verify(t.env, { ...options(), capabilities: ["rules", "mcp"] });
    expect(report).toMatchObject({
      configuration: "incomplete",
      healthy: false,
      coverage: {
        expected: 2,
        observed: 1,
        failed: 1,
        items: [{ outcome: "covered" }, { outcome: "failed", code: "PLANNING_FAILED" }],
      },
      desiredVsApplied: {
        items: [expect.objectContaining({ capability: "rules", status: "in-sync" })],
      },
    });
  });

  it("verifies configuration with no mutation authority or provider access", async () => {
    await writeMcpArtifact(t.env, storeRoot, "example", {
      kind: "stdio",
      command: "example",
      env: { TOKEN: "${TOKEN}" },
    });
    const provider = vi.fn(() => {
      throw new Error("provider accessed");
    });
    const env = { ...t.env, mutationAuthority: undefined, env: new Proxy({}, { get: provider }) };
    const report = await verify(env, { ...options(), capabilities: ["mcp"] });
    expect(report.configuration).toBe("unhealthy");
    expect(provider).not.toHaveBeenCalled();
  });

  it("reports blocked targets and snapshot failures with fixed codes", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "Be clear");
    await t.env.fs.mkdir(t.path("home", ".claude"), { recursive: true });
    await t.env.fs.writeFile(t.path("home", ".claude", "CLAUDE.md"), "unowned");
    expect(await verify(t.env, options())).toMatchObject({
      configuration: "incomplete",
      coverage: { items: [{ outcome: "blocked", code: "PLANNING_BLOCKED" }] },
    });
    vi.spyOn(t.env.fs, "snapshotPathNoFollow").mockRejectedValue(new Error("private payload"));
    const report = await verify(t.env, options());
    expect(report).toMatchObject({
      configuration: "incomplete",
      coverage: { failed: 1, items: [{ code: "PLANNING_FAILED" }] },
    });
    expect(JSON.stringify(report)).not.toContain("private payload");
  });

  it("observes recovery conservatively without touching authority", async () => {
    const env = {
      ...t.env,
      mutationAuthority: new Proxy(
        {},
        {
          get() {
            throw new Error("authority accessed");
          },
        },
      ) as NonNullable<typeof t.env.mutationAuthority>,
    };
    expect(await verify(env, options())).toMatchObject({
      configuration: "no-op",
      recovery: { status: "clean" },
    });
    const read = t.env.fs.readFile.bind(t.env.fs);
    vi.spyOn(t.env.fs, "readFile").mockImplementation(async (path) => {
      if (path.endsWith("/operations/active.json") || path.includes("mutation-lock"))
        throw new Error("unreadable");
      return read(path);
    });
    expect(await verify(env, options())).toMatchObject({
      healthy: false,
      recovery: { status: "manual-recovery-required" },
    });
  });

  it("requires real verified targets and keeps drift on its existing axis", async () => {
    await writeRuleArtifact(t.env, storeRoot, "style", "Be clear");
    await apply(t.env, options());
    expect(await verify(t.env, options())).toMatchObject({
      configuration: "healthy",
      healthy: true,
      runtime: { observation: "unknown" },
    });
    await t.env.fs.writeFile(t.path("home", ".claude", "CLAUDE.md"), "drift");
    expect(await verify(t.env, options())).toMatchObject({
      configuration: "unhealthy",
      healthy: false,
      desiredVsApplied: { status: "converged" },
      appliedVsDisk: { status: "diverged" },
    });
    expect(await verify(t.env, { ...options(), resourceIds: [] })).toMatchObject({
      configuration: "unhealthy",
      healthy: false,
    });
  });
});
