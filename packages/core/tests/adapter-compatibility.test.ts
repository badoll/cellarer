import { describe, expect, it } from "vitest";
import { loadCompatibility, nativeEvidence } from "../src/adapters/compatibility.js";
import { makeTmpEnv } from "./helpers/env.js";

describe("native compatibility evidence", () => {
  it("covers all 42 cells without inferring native verification", async () => {
    const t = makeTmpEnv();
    try {
      const matrix = await loadCompatibility(t.env);
      expect(matrix.cells).toHaveLength(42);
      expect(new Set(matrix.cells.map((c) => `${c.agent}/${c.capability}/${c.scope}`)).size).toBe(
        42,
      );
      for (const cell of matrix.cells) {
        expect(cell.sources.length).toBeGreaterThan(0);
        expect(cell.prerequisites.length).toBeGreaterThan(0);
        expect(nativeEvidence(cell)).toEqual({ status: "unknown", reason: "not-run" });
      }
    } finally {
      await t.cleanup();
    }
  });

  it("does not transfer observations between versions, capabilities or scopes", () => {
    const cell = { agent: "codex", capability: "rules", scope: "project" } as const;
    const observation = { ...cell, version: "1.0", loaded: true };
    expect(nativeEvidence(cell, "2.0", observation)).toEqual({
      status: "unknown",
      reason: "version-mismatch",
    });
    expect(nativeEvidence(cell, "1.0", { ...observation, scope: "global" })).toEqual({
      status: "unknown",
      reason: "cell-mismatch",
    });
    expect(nativeEvidence(cell, "1.0", observation)).toEqual({
      status: "native-verified",
      version: "1.0",
    });
    expect(nativeEvidence(cell, "1.0", { ...observation, loaded: false })).toEqual({
      status: "unknown",
      reason: "not-loaded",
    });
  });
});

describe("calibrated ownership boundaries", () => {
  it("blocks a prior owned MCP location without reading or writing either target", async () => {
    const { apply } = await import("../src/engine/apply.js");
    const { plan } = await import("../src/engine/plan.js");
    const { initialConfigText } = await import("../src/store/config.js");
    const t = makeTmpEnv();
    try {
      const storeRoot = t.path("home", ".cellarer");
      await t.env.fs.mkdir(`${storeRoot}/store/mcp`, { recursive: true });
      await t.env.fs.writeFile(
        `${storeRoot}/store/mcp/sample.json`,
        '{"command":"sample-not-executed"}',
      );
      const config = JSON.parse(await initialConfigText(t.env));
      config.adapterOverrides = { "claude-code": { mcp: { global: "~/.claude/mcp.json" } } };
      await t.env.fs.writeFile(`${storeRoot}/config.json`, JSON.stringify(config));
      await apply(t.env, {
        storeRoot,
        agents: ["claude-code"],
        scope: "global",
        capabilities: ["mcp"],
      });
      const old = t.path("home", ".claude", "mcp.json");
      const original = await t.env.fs.readFile(old);
      config.adapterOverrides = {};
      await t.env.fs.writeFile(`${storeRoot}/config.json`, JSON.stringify(config));
      const result = await plan(t.env, {
        storeRoot,
        agents: ["claude-code"],
        scope: "global",
        capabilities: ["mcp"],
      });
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toMatchObject({
        op: "skip",
        reason: expect.stringContaining("relocation-required"),
      });
      expect(result.actions[0]?.preview).toBeUndefined();
      expect(await t.env.fs.readFile(old)).toBe(original);
      await expect(t.env.fs.readFile(t.path("home", ".claude.json"))).rejects.toThrow();
    } finally {
      await t.cleanup();
    }
  });
});

describe("native settings and overrides", () => {
  it("preserves non-MCP fields and blocks sensitive native settings without disclosure", async () => {
    const { plan } = await import("../src/engine/plan.js");
    const t = makeTmpEnv();
    try {
      const storeRoot = t.path("home", ".cellarer");
      const target = t.path("home", ".claude.json");
      await t.env.fs.mkdir(`${storeRoot}/store/mcp`, { recursive: true });
      await t.env.fs.writeFile(
        `${storeRoot}/store/mcp/sample.json`,
        '{"command":"sample-not-executed"}',
      );
      const opts = {
        storeRoot,
        agents: ["claude-code"],
        scope: "global" as const,
        capabilities: ["mcp" as const],
      };
      const original = JSON.stringify({
        theme: "dark",
        projects: { "/example": { allowedTools: [] } },
        mcpServers: {},
      });
      await t.env.fs.writeFile(target, original);
      let first = await plan(t.env, opts);
      const token = first.conflicts[0]?.acknowledgement?.token;
      expect(token).toBeDefined();
      const reviewed = await plan(t.env, {
        ...opts,
        replaceUnowned: [token ?? ""],
        snapshotPassphrase: "test-snapshot-passphrase",
      });
      expect(JSON.parse(reviewed.actions[0]?.preview?.after ?? "null")).toMatchObject({
        theme: "dark",
        projects: { "/example": { allowedTools: [] } },
        mcpServers: { sample: { command: "sample-not-executed" } },
      });
      expect(await t.env.fs.readFile(target)).toBe(original);
      const sensitive = JSON.stringify({ oauthToken: "fixture-sensitive-value", mcpServers: {} });
      await t.env.fs.writeFile(target, sensitive);
      first = await plan(t.env, opts);
      const blocked = await plan(t.env, {
        ...opts,
        replaceUnowned: [first.conflicts[0]?.acknowledgement?.token ?? ""],
        snapshotPassphrase: "test-snapshot-passphrase",
      });
      expect(blocked.actions.every((action) => action.op === "skip")).toBe(true);
      expect(JSON.stringify(blocked)).not.toContain("fixture-sensitive-value");
      expect(await t.env.fs.readFile(target)).toBe(sensitive);
    } finally {
      await t.cleanup();
    }
  });

  it("withdraws only affected capability claims when a built-in is overridden", async () => {
    const { describeCompatibility } = await import("../src/adapters/compatibility.js");
    const t = makeTmpEnv();
    try {
      const matrix = await loadCompatibility(t.env);
      const cells = describeCompatibility(matrix, "claude-code", "global", {
        mcp: { global: "~/custom.json" },
      });
      expect(cells.find((cell) => cell.capability === "mcp")).toMatchObject({
        evidence: "user-defined",
        sources: [],
        native: "unknown",
      });
      expect(cells.find((cell) => cell.capability === "rules")?.evidence).toBe("documented");
      expect(
        describeCompatibility(matrix, "custom", "project").every(
          (cell) => cell.evidence === "user-defined",
        ),
      ).toBe(true);
    } finally {
      await t.cleanup();
    }
  });
});

it("compares Skill entry parents and keeps other project owners out of relocation checks", async () => {
  const { requiresRelocation } = await import("../src/engine/plan/relocation.js");
  const { loadRegistry } = await import("../src/adapters/registry.js");
  const t = makeTmpEnv();
  try {
    const registry = await loadRegistry(t.env, t.path("store"));
    const cursor = registry.get("cursor");
    if (!cursor) throw new Error("missing cursor adapter");
    const receipt = {
      method: "copy" as const,
      fingerprint: "fixture",
      backup: null,
      generated: true,
      appliedAt: "2026-09-07",
    };
    const owner = {
      agent: "cursor",
      capability: "skills" as const,
      scope: "global" as const,
      target: t.path("home", ".cursor", "skills-cursor", "sample"),
      artifactIds: ["skills/sample"],
      receipt,
    };
    expect(await requiresRelocation(t.env, cursor, "skills", "global", undefined, [owner])).toBe(
      true,
    );
    expect(
      await requiresRelocation(t.env, cursor, "skills", "global", undefined, [
        { ...owner, target: t.path("home", ".cursor", "skills", "sample") },
      ]),
    ).toBe(false);
    expect(
      await requiresRelocation(t.env, cursor, "rules", "global", undefined, [
        {
          ...owner,
          capability: "rules",
          artifactIds: ["rules/sample"],
          target: t.path("home", ".cursor", "rules", "cellarer.mdc"),
        },
      ]),
    ).toBe(true);
    expect(
      await requiresRelocation(t.env, cursor, "skills", "project", t.path("project"), [
        { ...owner, scope: "project", projectRoot: t.path("other-project") },
      ]),
    ).toBe(false);
    expect(
      await requiresRelocation(t.env, cursor, "skills", "project", t.path("project"), [
        { ...owner, scope: "project", projectRoot: t.path("project") },
      ]),
    ).toBe(true);
  } finally {
    await t.cleanup();
  }
});

it("keeps fixture execution separate from unconfigured native probes", async () => {
  // The probe module has no process side effects when imported.
  const { runNativeProbe } = await import("../../../test/e2e/native-agent-compatibility.mjs");
  expect(
    await runNativeProbe({ agent: "claude-code", capability: "rules", scope: "global" }),
  ).toMatchObject({ status: "unavailable", native: "unknown", reason: "no-isolated-recipe" });
  expect(
    await runNativeProbe({ agent: "codex", capability: "mcp", scope: "global" }),
  ).toMatchObject({
    status: "unavailable",
    native: "unknown",
    reason: "explicit-binary-and-version-required",
  });
});

it("does not certify a custom adapter that shadows a built-in ID", async () => {
  const { listControlPlaneAgents } = await import("../src/control-plane.js");
  const { initialConfigText } = await import("../src/store/config.js");
  const t = makeTmpEnv();
  try {
    const storeRoot = t.path("store");
    await t.env.fs.mkdir(storeRoot, { recursive: true });
    const config = JSON.parse(await initialConfigText(t.env));
    config.customAdapters = { codex: { rules: { global: "~/custom/AGENTS.md" } } };
    await t.env.fs.writeFile(`${storeRoot}/config.json`, JSON.stringify(config));
    const result = await listControlPlaneAgents(t.env, {
      storeRoot,
      scope: "global",
      agents: ["codex"],
    });
    expect(result.agents[0]?.adapterKind).toBe("custom");
    expect(result.agents[0]?.compatibility.every((cell) => cell.evidence === "user-defined")).toBe(
      true,
    );
  } finally {
    await t.cleanup();
  }
});
