import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRegistryFromConfig } from "../src/adapters/registry.js";
import type { AgentAdapter } from "../src/adapters/types.js";
import {
  enumerateInventorySources,
  InventoryAdapterNotFoundError,
  inspectInventorySourcesBounded,
} from "../src/inventory/enumerator.js";
import { parseConfig } from "../src/store/config.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/inventory/registered-sources.json", import.meta.url),
);

describe("unified Inventory source enumeration", () => {
  let t: TmpEnv;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });

  afterEach(async () => {
    await t.cleanup();
  });

  async function fixture() {
    const configuration = parseConfig(await readFile(fixturePath, "utf8"));
    const registry = await loadRegistryFromConfig(t.env, configuration);
    return { configuration, adapters: registry.list() };
  }

  it("enumerates registered sources independently of enabled and detected state", async () => {
    await t.env.fs.mkdir(t.path("home", ".agents", "skills", "shared-skill"), {
      recursive: true,
    });
    await t.env.fs.writeFile(
      t.path("home", ".agents", "skills", "shared-skill", "SKILL.md"),
      "# Shared Skill\n",
    );
    const { configuration, adapters } = await fixture();

    const result = await enumerateInventorySources(t.env, { adapters, configuration });
    const shared = result.sources.find(
      (source) =>
        source.adapterId === "agents-md" && source.kind === "skills" && source.scope === "global",
    );
    const custom = result.sources.find(
      (source) => source.adapterId === "fixture-agent" && source.kind === "rules",
    );

    expect(shared).toMatchObject({
      path: t.path("home", ".agents", "skills"),
      enabled: false,
      detected: true,
    });
    expect(custom).toMatchObject({
      path: t.path("home", ".fixture-agent", "RULES.md"),
      enabled: true,
      detected: false,
    });
    expect(result.findings).toEqual([]);
    expect(result.sources.every((source) => source.path.startsWith(t.env.homedir()))).toBe(true);
  });

  it("adds only bounded project declarations when an explicit project is selected", async () => {
    const { configuration, adapters } = await fixture();
    const project = t.path("projects", "selected");
    await t.env.fs.mkdir(project, { recursive: true });

    const withoutProject = await enumerateInventorySources(t.env, { adapters, configuration });
    const withProject = await enumerateInventorySources(t.env, {
      adapters,
      configuration,
      projectRoot: project,
    });

    expect(withoutProject.sources.some((source) => source.scope === "project")).toBe(false);
    expect(withProject.projectRoot).toBe(await t.env.fs.realpath(project));
    expect(
      withProject.sources
        .filter((source) => source.scope === "project")
        .every((source) => source.path.startsWith(`${withProject.projectRoot}/`)),
    ).toBe(true);
  });

  it("uses one exact adapter filter and keeps declared absent paths as empty evidence", async () => {
    const { configuration, adapters } = await fixture();

    const result = await enumerateInventorySources(t.env, {
      adapters,
      configuration,
      agentId: "agents-md",
    });

    expect(new Set(result.sources.map((source) => source.adapterId))).toEqual(
      new Set(["agents-md"]),
    );
    expect(result.sources.some((source) => source.path.endsWith("AGENTS.md"))).toBe(true);
    expect(result.findings).toEqual([]);
    await expect(
      enumerateInventorySources(t.env, {
        adapters,
        configuration,
        agentId: "missing-adapter",
      }),
    ).rejects.toBeInstanceOf(InventoryAdapterNotFoundError);
  });

  it("isolates adapter detection and path failures without hiding safe sources", async () => {
    const { configuration, adapters } = await fixture();
    const broken: AgentAdapter = {
      id: "broken",
      displayName: "Broken",
      capabilities: { rules: ["global"], mcp: [], skills: [] },
      detect: async () => {
        throw new Error("secret detection detail");
      },
      paths: () => {
        throw new Error("secret path detail");
      },
    };

    const result = await enumerateInventorySources(t.env, {
      adapters: [...adapters, broken],
      configuration,
    });

    expect(result.sources.some((source) => source.adapterId === "agents-md")).toBe(true);
    expect(result.findings).toEqual([
      {
        code: "ADAPTER_DETECTION_FAILED",
        adapterId: "broken",
        scope: "global",
      },
      { code: "ADAPTER_PATHS_FAILED", adapterId: "broken", scope: "global" },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret detection detail");
    expect(JSON.stringify(result)).not.toContain("secret path detail");
  });

  it("keeps discovery independent from placement and includes documented compatible roots", async () => {
    const configuration = parseConfig(
      JSON.stringify({
        adapterOverrides: {
          opencode: { skills: { global: "~/.placement-only" } },
        },
      }),
    );
    const registry = await loadRegistryFromConfig(t.env, configuration);
    const adapter = registry.get("opencode");
    if (!adapter) throw new Error("missing opencode");
    expect(adapter.paths(t.env, "global").skillsDir).toBe(t.path("home", ".placement-only"));
    const result = await enumerateInventorySources(t.env, {
      adapters: registry.list(),
      configuration,
      agentId: "opencode",
    });
    expect(
      result.sources
        .filter((source) => source.kind === "skills")
        .map((source) => source.path)
        .sort(),
    ).toEqual(
      [
        t.path("home", ".agents/skills"),
        t.path("home", ".claude/skills"),
        t.path("home", ".config/opencode/skills"),
      ].sort(),
    );
    expect(result.sources.every((source) => source.discoveryMode === "declared")).toBe(true);
  });

  it("uses placement-only fallback for custom adapters and rejects unbounded descriptors", async () => {
    const { configuration, adapters } = await fixture();
    const result = await enumerateInventorySources(t.env, {
      adapters,
      configuration,
      agentId: "fixture-agent",
    });
    expect(result.sources.every((source) => source.discoveryMode === "placement-only")).toBe(true);
    const descriptor = {
      sourceId: "skills",
      scope: "global",
      kind: "skills",
      path: "~/.pool",
      locator: "tree",
      maxDepth: 16,
      maxEntries: 1000,
      maxBytes: 10000,
      precedence: { policy: "ranked", rank: 1, evidence: "test declaration" },
    };
    const config = (discovery: unknown) =>
      JSON.stringify({
        customAdapters: { fixture: { skills: { global: "~/.write" }, discovery } },
      });
    expect(() => parseConfig(config([descriptor]))).not.toThrow();
    for (const invalid of [
      { ...descriptor, maxDepth: 0 },
      { ...descriptor, maxEntries: 100001 },
      { ...descriptor, precedence: { policy: "ranked", evidence: "missing rank" } },
    ]) {
      expect(() => parseConfig(config([invalid]))).toThrow();
    }
    expect(() => parseConfig(config([descriptor, descriptor]))).toThrow();
  });

  it("isolates an escaping discovery source without inspecting ancestors outside the project", async () => {
    const projectRoot = t.path("project");
    await t.env.fs.mkdir(projectRoot, { recursive: true });
    const base = {
      scope: "project",
      kind: "rules",
      locator: "file",
      maxDepth: 4,
      maxEntries: 10,
      maxBytes: 1000,
      precedence: { policy: "unknown", evidence: "fixture" },
    };
    const configuration = parseConfig(
      JSON.stringify({
        customAdapters: {
          fixture: {
            rules: { project: "{dir}/WRITE.md" },
            discovery: [
              { ...base, sourceId: "safe", path: "{dir}/RULES.md" },
              { ...base, sourceId: "ancestor", path: "{dir}/../RULES.md" },
            ],
          },
        },
      }),
    );
    const registry = await loadRegistryFromConfig(t.env, configuration);
    const result = await enumerateInventorySources(t.env, {
      adapters: registry.list(),
      configuration,
      projectRoot,
      agentId: "fixture",
    });
    expect(result.sources.map((source) => source.path)).toEqual([join(projectRoot, "RULES.md")]);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: "SOURCE_OUTSIDE_BOUNDARY" }),
    );
  });

  it("settles bounded source work in deterministic source order", async () => {
    const { configuration, adapters } = await fixture();
    const enumeration = await enumerateInventorySources(t.env, {
      adapters,
      configuration,
      agentId: "agents-md",
    });
    const sources = enumeration.sources.slice(0, 2);

    const results = await inspectInventorySourcesBounded(sources, 1, async (source) => {
      if (source.kind === "rules") throw new Error("candidate-local secret");
      return source.kind;
    });

    expect(results.map((result) => result.source.id)).toEqual(sources.map((source) => source.id));
    expect(results.map((result) => result.ok)).toContain(false);
    expect(JSON.stringify(results)).not.toContain("candidate-local secret");
  });
});
