import { describe, expect, it } from "vitest";
import { apply } from "../src/engine/apply.js";
import { isGenerated } from "../src/markers.js";
import { mcpCodecFor } from "../src/mcp/codec.js";
import { compileMcp } from "../src/mcp/compiler.js";
import type { McpDialect } from "../src/mcp/model.js";
import { serverFromRaw, serverToRaw } from "../src/mcp/model.js";
import { compileRules } from "../src/rules/compiler.js";
import { scanStructuredFileSecretFindings } from "../src/secrets/detector.js";
import { parseSkillManifest } from "../src/skills/manifest.js";

describe("bounded portable resource semantics", () => {
  it("interprets quoted and block scalars without losing extension metadata", () => {
    const raw =
      '---\nname: example\ndescription: |\n  first line\n  second line\nmetadata:\n  internal: true\n  custom: [one, "two: three"]\nunknown: {nested: value}\n---\nbody\n';
    expect(parseSkillManifest(raw)).toEqual({
      name: "example",
      description: "first line\nsecond line\n",
      metadata: { internal: true, custom: ["one", "two: three"] },
      extensions: { unknown: { nested: "value" } },
    });
    expect(
      parseSkillManifest("---\nname: 'example'\ndescription: 'It''s useful'\n---\n").description,
    ).toBe("It's useful");
  });
  it.each([
    "name: example\ndescription: |\n",
    "name: example\nname: other\ndescription: hello",
    "name: example\ndescription: !execute hello",
    "name: example\ndescription: &a hello\nother: *a",
    "name: example\ndescription: hello\nmetadata: [invalid]",
    `name: example\ndescription: hello\nnested: ${"[".repeat(40)}a${"]".repeat(40)}`,
    `name: example\ndescription: ${"a".repeat(65536)}`,
  ])("rejects ambiguity, executable features and resource limits without source leakage", (yaml) => {
    expect(() => parseSkillManifest(`---\n${yaml}\n---\n`)).toThrow("INVALID_MANIFEST");
  });
});

describe("Rule trigger compilation", () => {
  it("keeps every conditional rule in its own MDC with frontmatter before markers", () => {
    const result = compileRules("/project/.cursor/rules/cellarer.mdc", [
      { relPath: "rules/plain.md", content: "Always" },
      {
        relPath: "rules/types.md",
        content: '---\nalwaysApply: false\nglobs: "**/*.ts"\n---\nTypes',
      },
      { relPath: "rules/manual.md", content: "---\nalwaysApply: false\n---\nManual" },
    ]);
    expect(result.status).toBe("exact");
    if (result.status !== "exact") return;
    expect(result.value).toHaveLength(3);
    expect(result.value[1]?.content).toContain('globs: "**/*.ts"');
    expect(result.value[1]?.sources).toEqual(["rules/types.md"]);
    for (const output of result.value) {
      expect(output.content.startsWith("---\n")).toBe(true);
      expect(isGenerated(output.content)).toBe(true);
    }
  });
  it("blocks semantic downgrade and native target collisions", () => {
    const conditional = {
      relPath: "rules/a.md",
      content: '---\nalwaysApply: false\nglobs: "**/*.ts"\n---\nConditional',
    };
    expect(compileRules("/project/AGENTS.md", [conditional])).toMatchObject({
      status: "requires-choice",
    });
    expect(
      compileRules("/project/cellarer.mdc", [
        conditional,
        { ...conditional, relPath: "other/a.md" },
      ]),
    ).toMatchObject({ status: "unsupported", reason: "RULE_TARGET_COLLISION" });
    expect(
      compileRules("/project/AGENTS.md", [
        { relPath: "rules/a.md", content: "---\nunknown: true\n---\nBody" },
      ]),
    ).toMatchObject({ status: "unsupported" });
  });
});

it("applies a conditional target set and converges with exact source ownership", async () => {
  const { plan } = await import("../src/engine/plan.js");
  const { makeTmpEnv, ensureBaseDirs } = await import("./helpers/env.js");
  const t = makeTmpEnv();
  try {
    await ensureBaseDirs(t);
    const storeRoot = t.path("store");
    const dir = t.path("project");
    await t.env.fs.mkdir(`${storeRoot}/store/rules`, { recursive: true });
    await t.env.fs.mkdir(dir, { recursive: true });
    await t.env.fs.writeFile(
      `${storeRoot}/store/rules/types.md`,
      '---\nalwaysApply: false\nglobs: "**/*.ts"\n---\nTypes',
    );
    await t.env.fs.writeFile(
      `${storeRoot}/store/rules/manual.md`,
      "---\nalwaysApply: false\n---\nManual",
    );
    const opts = {
      storeRoot,
      dir,
      scope: "project" as const,
      agents: ["cursor"],
      capabilities: ["rules" as const],
    };
    const first = await apply(t.env, opts);
    expect(first.plan.actions.filter((action) => action.op !== "skip")).toHaveLength(2);
    const next = await plan(t.env, opts);
    expect(next.actions.every((action) => action.op !== "skip")).toBe(true);
    expect(next.actions.map((action) => action.artifactIds)).toEqual([
      ["rules/manual"],
      ["rules/types"],
    ]);
    expect(next.conflicts).toEqual([]);
    await apply(t.env, opts);
  } finally {
    await t.cleanup();
  }
});

function mcpTarget(semanticDialect: McpDialect["semanticDialect"]) {
  return {
    codec: mcpCodecFor("json", { semanticDialect }),
    serversKey: "mcpServers",
    defaultStrategy: "merge" as const,
    supportedSecretReferences: ["environment" as const],
  };
}

describe("MCP transport, provenance and reference positions", () => {
  it("retains native unknown extensions only within the same dialect", () => {
    const target = mcpTarget("claude");
    const incoming = target.codec.decode(
      '{"mcpServers":{"sample":{"command":"sample","custom":{"retained":true}}}}',
      "mcpServers",
    ).servers;
    const stored = serverToRaw(incoming.sample!);
    const reloaded = { sample: serverFromRaw(stored) };
    expect(compileMcp(reloaded, target).status).toBe("exact");
    expect(compileMcp(reloaded, mcpTarget("gemini"))).toMatchObject({
      status: "requires-choice",
      reason: "MCP_EXTENSION_DIALECT",
    });
    const roundtrip = JSON.parse(
      target.codec.encode({ servers: {}, doc: {}, serversKey: "mcpServers" }, incoming),
    );
    expect(roundtrip.mcpServers.sample).toEqual({ command: "sample", custom: { retained: true } });
    expect(JSON.stringify(roundtrip)).not.toContain("$cellarerMcp");
  });
  it("does not guess URL transport and refuses SSE on an HTTP-only target", () => {
    expect(
      compileMcp(
        { sample: serverFromRaw({ url: "https://example.test/mcp" }) },
        mcpTarget("claude"),
      ),
    ).toMatchObject({ status: "requires-choice", reason: "MCP_UNKNOWN_TRANSPORT" });
    const incoming = { sample: serverFromRaw({ type: "sse", url: "https://example.test/sse" }) };
    expect(compileMcp(incoming, mcpTarget("codex"))).toMatchObject({ status: "unsupported" });
    const gemini = compileMcp(incoming, mcpTarget("gemini"));
    expect(gemini.status).toBe("exact");
    if (gemini.status === "exact")
      expect(serverToRaw(gemini.value.sample!, { semanticDialect: "gemini" })).toEqual({
        url: "https://example.test/sse",
      });
  });
  it("maps Codex header references structurally without reading values", () => {
    const incoming = {
      sample: serverFromRaw({
        type: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "${ACCESS_TOKEN}", "X-Key": "${CUSTOM_TOKEN}" },
      }),
    };
    const result = compileMcp(incoming, mcpTarget("codex"));
    expect(result.status).toBe("exact");
    if (result.status === "exact")
      expect(serverToRaw(result.value.sample!, { semanticDialect: "codex" })).toEqual({
        url: "https://example.test/mcp",
        env_http_headers: { Authorization: "ACCESS_TOKEN", "X-Key": "CUSTOM_TOKEN" },
      });
    expect(compileMcp(incoming, mcpTarget("gemini"))).toMatchObject({
      status: "unsupported",
      reason: "MCP_HEADER_REFERENCE",
    });
    expect(
      compileMcp(
        { sample: serverFromRaw({ command: "sample", args: ["${TOKEN}"] }) },
        mcpTarget("gemini"),
      ),
    ).toMatchObject({ status: "unsupported", reason: "MCP_ARGUMENT_REFERENCE" });
  });
});

it("blocks unsupported reference positions before provider access and emits native header names", async () => {
  const { plan } = await import("../src/engine/plan.js");
  const { makeTmpEnv, ensureBaseDirs } = await import("./helpers/env.js");
  const t = makeTmpEnv();
  try {
    await ensureBaseDirs(t);
    const storeRoot = t.path("store");
    await t.env.fs.mkdir(`${storeRoot}/store/mcp`, { recursive: true });
    await t.env.fs.writeFile(
      `${storeRoot}/store/mcp/sample.json`,
      JSON.stringify({
        type: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "${HEADER_TOKEN}" },
      }),
    );
    let reads = 0;
    const env = {
      ...t.env,
      env: { HEADER_TOKEN: "opaque-canary-value" },
      secretStore: {
        get: async () => {
          reads++;
          return { found: true, value: "opaque-canary-value" };
        },
        set: async () => {},
        delete: async () => false,
      },
    };
    const opts = { storeRoot, scope: "global" as const, capabilities: ["mcp" as const] };
    const blocked = await plan(env, { ...opts, agents: ["gemini-cli"] });
    expect(blocked.actions).toEqual([
      expect.objectContaining({ op: "skip", reason: "unsupported: MCP_HEADER_REFERENCE" }),
    ]);
    expect(reads).toBe(0);
    const native = await plan(env, { ...opts, agents: ["codex"] });
    expect(native.actions[0]?.op, JSON.stringify(native)).toBe("merge");
    expect(native.actions[0]?.preview?.after).toContain('Authorization = "HEADER_TOKEN"');
    expect(native.actions[0]?.preview?.after).toContain("env_http_headers");
    expect(JSON.stringify(native)).not.toContain("opaque-canary-value");
    const applied = await apply(env, { ...opts, agents: ["codex"] });
    expect(applied.mutation.result.ok).toBe(true);
    expect(await t.env.fs.readFile(t.path("home", ".codex", "config.toml"))).toContain(
      'Authorization = "HEADER_TOKEN"',
    );
  } finally {
    await t.cleanup();
  }
});

it("recognizes only native environment-name containers without exempting header plaintext", () => {
  expect(
    scanStructuredFileSecretFindings(
      "config.toml",
      '[mcp_servers.sample.env_http_headers]\nAuthorization = "TOKEN_NAME"',
    ),
  ).toEqual([]);
  expect(
    scanStructuredFileSecretFindings(
      "config.toml",
      '[mcp_servers.sample.http_headers]\nAuthorization = "literal"',
    ),
  ).toContainEqual(expect.objectContaining({ rule: "sensitive-field" }));
  expect(
    scanStructuredFileSecretFindings(
      "config.toml",
      '[mcp_servers.sample.env_http_headers]\nAuthorization = "not a variable name"',
    ),
  ).toContainEqual(expect.objectContaining({ rule: "sensitive-field" }));
  expect(
    scanStructuredFileSecretFindings(
      "config.toml",
      '[unrelated.env_http_headers]\nAuthorization = "TOKEN_NAME"',
    ),
  ).toContainEqual(expect.objectContaining({ rule: "sensitive-field" }));
});

it("binds compiler and packaged adapter contracts and rejects a changed contract before effects", async () => {
  const { planApplyMutation, applyMutationPlan } = await import("../src/engine/apply.js");
  const { createAuthorizedMutationPlan } = await import("../src/protocol/canonical.js");
  const { makeTmpEnv, ensureBaseDirs } = await import("./helpers/env.js");
  const t = makeTmpEnv();
  try {
    await ensureBaseDirs(t);
    const storeRoot = t.path("store");
    await t.env.fs.mkdir(`${storeRoot}/store/rules`, { recursive: true });
    await t.env.fs.writeFile(`${storeRoot}/store/rules/sample.md`, "Reviewed bytes");
    const options = { storeRoot, scope: "global" as const, agents: ["claude-code"] };
    const prepared = await planApplyMutation(t.env, options);
    const original = prepared.mutationPlan;
    expect(original.normalizedInputs.resourceSemantics).toEqual({
      version: "1",
      adapterFingerprint: expect.stringMatching(/^sha256:/),
    });
    for (const evidence of [
      { version: "old", adapterFingerprint: `sha256:${"a".repeat(64)}` },
      { version: "1", adapterFingerprint: `sha256:${"a".repeat(64)}` },
    ]) {
      const forged = createAuthorizedMutationPlan(t.env, storeRoot, {
        schemaVersion: original.schemaVersion,
        planId: "resealed-contract",
        operation: original.operation,
        baseRevision: original.baseRevision,
        normalizedInputs: { ...original.normalizedInputs, resourceSemantics: evidence },
        actions: original.actions,
        targetPreconditions: original.targetPreconditions,
        expires: original.expires,
      });
      expect(
        (await applyMutationPlan(t.env, forged, { storeRoot, options })).operation,
      ).toMatchObject({ ok: false, conflict: { code: "INVALID_PLAN" } });
    }
    await expect(t.env.fs.readFile(t.path("home", ".claude", "CLAUDE.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await t.cleanup();
  }
});

it("does not equate distinct native adapters merely because their field layout matches", () => {
  const first = {
    ...mcpTarget("standard"),
    codec: mcpCodecFor("json", { semanticDialect: "standard", nativeId: "first" }),
  };
  const second = {
    ...mcpTarget("standard"),
    codec: mcpCodecFor("json", { semanticDialect: "standard", nativeId: "second" }),
  };
  const incoming = first.codec.decode(
    '{"mcpServers":{"sample":{"command":"sample","extension":true}}}',
    "mcpServers",
  ).servers;
  expect(compileMcp(incoming, first).status).toBe("exact");
  expect(compileMcp(incoming, second)).toMatchObject({
    status: "requires-choice",
    reason: "MCP_EXTENSION_DIALECT",
  });
});

it("preserves special own server names instead of changing a dictionary prototype", () => {
  const target = mcpTarget("claude");
  const decoded = target.codec.decode(
    '{"mcpServers":{"__proto__":{"command":"sample"}}}',
    "mcpServers",
  );
  const result = compileMcp(decoded.servers, target);
  expect(result.status).toBe("exact");
  if (result.status === "exact") expect(Object.keys(result.value)).toEqual(["__proto__"]);
});
