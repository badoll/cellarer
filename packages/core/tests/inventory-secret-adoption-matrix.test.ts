import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentAdapter } from "../src/adapters/types.js";
import type { InventorySource } from "../src/inventory/enumerator.js";
import { groupInventoryCandidates } from "../src/inventory/grouper.js";
import { inspectInventorySource } from "../src/inventory/inspector.js";
import { mcpCodecFor } from "../src/mcp/codec.js";
import { ensureBaseDirs, makeTmpEnv, type TmpEnv } from "./helpers/env.js";

const SECRET_CANARY = "inventory-adoption-canary-value";

describe("Inventory secret-adoption supported-field matrix", () => {
  let t: TmpEnv;

  beforeEach(async () => {
    t = makeTmpEnv();
    await ensureBaseDirs(t);
  });

  afterEach(async () => {
    await t.cleanup();
  });

  it.each([
    {
      label: "standard environment",
      content: { mcpServers: { sample: { command: "tool", env: { API_TOKEN: SECRET_CANARY } } } },
      expected: { kind: "environment", server: "sample", name: "API_TOKEN" },
    },
    {
      label: "standard header",
      content: {
        mcpServers: {
          sample: { url: "https://example.invalid/mcp", headers: { Authorization: SECRET_CANARY } },
        },
      },
      expected: { kind: "header", server: "sample", name: "Authorization" },
    },
    {
      label: "separate argument value",
      content: {
        mcpServers: { sample: { command: "tool", args: ["--api-key", SECRET_CANARY] } },
      },
      expected: {
        kind: "argument",
        server: "sample",
        name: "api-key",
        index: 1,
        style: "value",
      },
    },
    {
      label: "inline argument value",
      content: {
        mcpServers: { sample: { command: "tool", args: [`--api-key=${SECRET_CANARY}`] } },
      },
      expected: {
        kind: "argument",
        server: "sample",
        name: "api-key",
        index: 0,
        style: "assignment",
      },
    },
    {
      label: "URL query field",
      content: {
        mcpServers: { sample: { url: `https://example.invalid/mcp?api_key=${SECRET_CANARY}` } },
      },
      expected: { kind: "url-query", server: "sample", name: "api_key" },
    },
  ])("offers one redacted selector for $label", async ({ content, expected }) => {
    const candidate = await inspectJsonCandidate(content);
    const adoption = candidate.findings.find(
      (finding) => finding.code === "secret-adoption-required",
    )?.adoption;

    expect(candidate.state).toBe("needs-attention");
    expect(adoption?.selector).toEqual(expected);
    expect(adoption?.targetName).toMatch(/^mcp-sample-/);
    expect(JSON.stringify(candidate)).not.toContain(SECRET_CANARY);
  });

  it("uses canonical selectors for environment and URL dialect aliases", async () => {
    const openCode = await inspectJsonCandidate(
      {
        mcp: {
          local: {
            type: "local",
            command: ["tool"],
            environment: { CLIENT_SECRET: SECRET_CANARY },
          },
        },
      },
      {
        serversKey: "mcp",
        dialect: {
          commandStyle: "array",
          envKey: "environment",
          typeField: "type",
          stdioType: "local",
          remoteType: "remote",
        },
      },
    );
    const windsurf = await inspectJsonCandidate(
      {
        mcpServers: {
          remote: { serverUrl: `https://example.invalid/mcp?access_token=${SECRET_CANARY}` },
        },
      },
      { dialect: { urlKey: "serverUrl" } },
    );

    expect(adoptionSelectors(openCode)).toEqual([
      { kind: "environment", server: "local", name: "CLIENT_SECRET" },
    ]);
    expect(adoptionSelectors(windsurf)).toEqual([
      { kind: "url-query", server: "remote", name: "access_token" },
    ]);
  });

  it("keeps a candidate with multiple supported plaintext fields blocked as ambiguous", async () => {
    const candidate = await inspectJsonCandidate({
      mcpServers: {
        sample: {
          command: "tool",
          env: { API_TOKEN: SECRET_CANARY, "api-token": `${SECRET_CANARY}-second` },
        },
      },
    });
    expect(adoptionSelectors(candidate)).toEqual([]);
  });

  it("does not promote a high-entropy value under an unsupported field name", async () => {
    const candidate = await inspectJsonCandidate({
      mcpServers: {
        sample: { command: "tool", env: { REGION: "ghp_1234567890abcdefghij1234567890" } },
      },
    });

    expect(adoptionSelectors(candidate)).toEqual([]);
  });

  it.each([
    {
      label: "custom MCP shape",
      content: JSON.stringify({ mcpServers: { custom: { credential: SECRET_CANARY } } }),
      kind: "mcp" as const,
    },
    {
      label: "duplicate-key MCP source",
      content: `{"mcpServers":{"sample":{"command":"tool","env":{"API_TOKEN":"first","API_TOKEN":"${SECRET_CANARY}"}}}}`,
      kind: "mcp" as const,
    },
    {
      label: "URL userinfo",
      content: JSON.stringify({
        mcpServers: { remote: { url: `https://user:${SECRET_CANARY}@example.invalid/mcp` } },
      }),
      kind: "mcp" as const,
    },
    { label: "malformed MCP", content: `{${SECRET_CANARY}`, kind: "mcp" as const },
    { label: "Rule", content: `Use ${SECRET_CANARY}\n`, kind: "rules" as const },
  ])("keeps $label blocked without an adoption offer", async ({ content, kind }) => {
    const path = t.path("home", ".fixture", kind === "rules" ? "RULES.md" : "mcp.json");
    await t.env.fs.mkdir(join(path, ".."), { recursive: true });
    await t.env.fs.writeFile(path, content);
    const inspected = await inspectInventorySource(t.env, source(kind, path), adapter());
    const candidates = groupInventoryCandidates(t.env, inspected.candidates, []);

    expect(candidates).toHaveLength(1);
    expect(adoptionSelectors(candidates[0] as (typeof candidates)[number])).toEqual([]);
    expect(JSON.stringify(candidates)).not.toContain(SECRET_CANARY);
  });

  it("keeps a secret-bearing Skill blocked without an adoption offer", async () => {
    const path = t.path("home", ".fixture", "skills", "unsafe");
    await t.env.fs.mkdir(path, { recursive: true });
    await t.env.fs.writeFile(join(path, "SKILL.md"), `Use ${SECRET_CANARY}\n`);

    const inspected = await inspectInventorySource(
      t.env,
      source("skills", join(path, "..")),
      adapter(),
    );
    const candidates = groupInventoryCandidates(t.env, inspected.candidates, []);

    expect(candidates).toHaveLength(1);
    expect(adoptionSelectors(candidates[0] as (typeof candidates)[number])).toEqual([]);
    expect(JSON.stringify(candidates)).not.toContain(SECRET_CANARY);
  });

  async function inspectJsonCandidate(
    content: unknown,
    options: {
      readonly serversKey?: string;
      readonly dialect?: Parameters<typeof mcpCodecFor>[1];
    } = {},
  ) {
    const path = t.path("home", ".fixture", "mcp.json");
    await t.env.fs.mkdir(join(path, ".."), { recursive: true });
    await t.env.fs.writeFile(path, JSON.stringify(content));
    const inspected = await inspectInventorySource(
      t.env,
      source("mcp", path),
      adapter(options.serversKey, options.dialect),
    );
    const candidates = groupInventoryCandidates(t.env, inspected.candidates, []);
    expect(candidates).toHaveLength(1);
    return candidates[0] as (typeof candidates)[number];
  }

  function adapter(
    serversKey = "mcpServers",
    dialect?: Parameters<typeof mcpCodecFor>[1],
  ): AgentAdapter {
    return {
      id: "fixture",
      displayName: "Fixture",
      capabilities: { rules: ["global"], mcp: ["global"], skills: ["global"] },
      detect: async () => ({ installed: true, root: t.env.homedir() }),
      paths: () => ({}),
      mcp: {
        codec: mcpCodecFor("json", dialect),
        serversKey,
        defaultStrategy: "merge",
        supportedSecretReferences: ["cellarer"],
      },
    };
  }

  function source(kind: InventorySource["kind"], path: string): InventorySource {
    return {
      id: `fixture:global:${kind}:${path}`,
      adapterId: "fixture",
      displayName: "Fixture",
      scope: "global",
      kind,
      path,
      enabled: true,
      detected: true,
    };
  }
});

function adoptionSelectors(candidate: {
  readonly findings: readonly { readonly adoption?: { readonly selector: unknown } }[];
}): unknown[] {
  return candidate.findings.flatMap((finding) =>
    finding.adoption ? [finding.adoption.selector] : [],
  );
}
