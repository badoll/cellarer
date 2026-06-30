import { describe, expect, it } from "vitest";
import { applyMerge, jsonMcpCodec, mcpCodecFor, tomlMcpCodec } from "../src/mcp/codec.js";
import { findServersKey, mergeServerSets } from "../src/mcp/merge.js";
import {
  type McpServerSet,
  serverFromRaw,
  serverSetFromRaw,
  serverSetToRaw,
  serverToRaw,
} from "../src/mcp/model.js";

describe("mcp/model canonical conversion", () => {
  it("classifies a server with command as stdio", () => {
    const s = serverFromRaw({ command: "npx", args: ["-y", "x"], env: { K: "v" } });
    expect(s.kind).toBe("stdio");
    if (s.kind === "stdio") {
      expect(s.command).toBe("npx");
      expect(s.args).toEqual(["-y", "x"]);
      expect(s.env).toEqual({ K: "v" });
    }
  });

  it("classifies a server with url as remote", () => {
    const s = serverFromRaw({ url: "https://x/mcp", headers: { Authorization: "Bearer t" } });
    expect(s.kind).toBe("remote");
    if (s.kind === "remote") {
      expect(s.url).toBe("https://x/mcp");
      expect(s.headers).toEqual({ Authorization: "Bearer t" });
    }
  });

  it("falls back to custom (passthrough) for unknown shapes, losing nothing", () => {
    const s = serverFromRaw({ type: "weird", foo: 1, nested: { a: 2 } });
    expect(s.kind).toBe("custom");
    if (s.kind === "custom") {
      expect(s.config).toEqual({ type: "weird", foo: 1, nested: { a: 2 } });
    }
  });

  it("round-trips stdio/remote/custom through raw", () => {
    const set: McpServerSet = {
      a: { kind: "stdio", command: "npx", args: ["x"], env: { K: "v" } },
      b: { kind: "remote", url: "https://h/mcp" },
      c: { kind: "custom", config: { type: "x", q: 1 } },
    };
    const raw = serverSetToRaw(set);
    expect(serverSetFromRaw(raw)).toEqual(set);
  });

  it("preserves unknown per-server fields (disabled/type/timeout) on round-trip", () => {
    // 用户既有 server 的私有字段不能在 merge round-trip 中丢失。
    const raw = { command: "npx", args: ["x"], disabled: true, timeout: 30, type: "stdio-x" };
    const server = serverFromRaw(raw);
    expect(server.kind).toBe("stdio");
    if (server.kind === "stdio") {
      expect(server.extra).toEqual({ disabled: true, timeout: 30, type: "stdio-x" });
    }
    const back = serverToRaw(server);
    expect(back.disabled).toBe(true);
    expect(back.timeout).toBe(30);
    expect(back.type).toBe("stdio-x");
    expect(back.command).toBe("npx");
  });

  it("omits empty args/env/headers when serializing", () => {
    expect(serverToRaw({ kind: "stdio", command: "go", args: [], env: {} })).toEqual({
      command: "go",
    });
    expect(serverToRaw({ kind: "remote", url: "u", headers: {} })).toEqual({ url: "u" });
  });
});

describe("mcp/merge", () => {
  it("findServersKey prefers the requested key then known aliases", () => {
    expect(findServersKey({ mcpServers: {} }, "mcpServers")).toBe("mcpServers");
    // codex uses mcp_servers; if file already has it, keep it even when preferred differs.
    expect(findServersKey({ mcp_servers: {} }, "mcpServers")).toBe("mcp_servers");
    // nothing present → return preferred.
    expect(findServersKey({ other: 1 }, "mcpServers")).toBe("mcpServers");
  });

  it("merge keeps existing and overrides same-named; overwrite replaces all", () => {
    const existing: McpServerSet = {
      a: { kind: "stdio", command: "old" },
      b: { kind: "stdio", command: "keep" },
    };
    const incoming: McpServerSet = { a: { kind: "stdio", command: "new" } };
    const merged = mergeServerSets(existing, incoming, "merge");
    expect(Object.keys(merged).sort()).toEqual(["a", "b"]);
    expect((merged.a as { command: string }).command).toBe("new");
    const overwritten = mergeServerSets(existing, incoming, "overwrite");
    expect(Object.keys(overwritten)).toEqual(["a"]);
  });
});

describe("mcp/codec JSON (claude/cursor)", () => {
  it("encodes incoming servers into an empty file under the preferred key", () => {
    const incoming: McpServerSet = { ctx: { kind: "stdio", command: "npx", args: ["-y", "c7"] } };
    const content = applyMerge(jsonMcpCodec, null, incoming, "mcpServers", "merge");
    const parsed = JSON.parse(content);
    expect(parsed.mcpServers.ctx.command).toBe("npx");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("merge preserves unrelated top-level fields and other servers", () => {
    const existing = JSON.stringify({
      $schema: "x",
      mcpServers: { keep: { command: "keep-cmd" } },
    });
    const incoming: McpServerSet = { added: { kind: "stdio", command: "added-cmd" } };
    const content = applyMerge(jsonMcpCodec, existing, incoming, "mcpServers", "merge");
    const parsed = JSON.parse(content);
    expect(parsed.$schema).toBe("x"); // 非 server 字段保留
    expect(parsed.mcpServers.keep.command).toBe("keep-cmd"); // 既有 server 保留
    expect(parsed.mcpServers.added.command).toBe("added-cmd"); // 新 server 加入
  });

  it("overwrite replaces the servers section but keeps other fields", () => {
    const existing = JSON.stringify({ other: 1, mcpServers: { gone: { command: "x" } } });
    const incoming: McpServerSet = { only: { kind: "stdio", command: "y" } };
    const content = applyMerge(jsonMcpCodec, existing, incoming, "mcpServers", "overwrite");
    const parsed = JSON.parse(content);
    expect(parsed.other).toBe(1);
    expect(parsed.mcpServers).toEqual({ only: { command: "y" } });
  });

  it("merge preserves unknown per-server fields of an existing untouched server", () => {
    // 用户既有 server foo 带私有字段 disabled;merge 新 server bar 不应抹掉 foo.disabled。
    const existing = JSON.stringify({
      mcpServers: { foo: { command: "x", disabled: true } },
    });
    const incoming: McpServerSet = { bar: { kind: "stdio", command: "y" } };
    const content = applyMerge(jsonMcpCodec, existing, incoming, "mcpServers", "merge");
    const parsed = JSON.parse(content);
    expect(parsed.mcpServers.foo.command).toBe("x");
    expect(parsed.mcpServers.foo.disabled).toBe(true); // 私有字段未丢
    expect(parsed.mcpServers.bar.command).toBe("y");
  });

  it("gives an actionable error (not a bare SyntaxError) on a malformed existing file", () => {
    const malformed = '{ "mcpServers": { "x": { "command": "y" }, } '; // 尾逗号 + 未闭合
    expect(() =>
      applyMerge(jsonMcpCodec, malformed, {}, "mcpServers", "merge", "/path/to/.mcp.json"),
    ).toThrow(/invalid existing json mcp config at \/path\/to\/\.mcp\.json/);
  });

  it("re-encoding identical content is byte-stable (idempotency support)", () => {
    const incoming: McpServerSet = { a: { kind: "stdio", command: "npx", env: { K: "v" } } };
    const first = applyMerge(jsonMcpCodec, null, incoming, "mcpServers", "merge");
    const second = applyMerge(jsonMcpCodec, first, incoming, "mcpServers", "merge");
    expect(second).toBe(first);
  });
});

describe("mcp/codec TOML (codex)", () => {
  it("encodes into codex [mcp_servers.*] nested tables", () => {
    const incoming: McpServerSet = {
      context7: { kind: "stdio", command: "npx", args: ["-y", "c7"], env: { K: "v" } },
    };
    const content = applyMerge(tomlMcpCodec, null, incoming, "mcp_servers", "merge");
    expect(content).toContain("[mcp_servers.context7]");
    expect(content).toContain('command = "npx"');
    expect(content).toContain("[mcp_servers.context7.env]");
  });

  it("preserves non-server top-level config (model etc.) on merge", () => {
    const existing = `model = "gpt-5"
approval_policy = "on-request"

[mcp_servers.old]
command = "old-cmd"
`;
    const incoming: McpServerSet = { added: { kind: "stdio", command: "new-cmd" } };
    const content = applyMerge(tomlMcpCodec, existing, incoming, "mcp_servers", "merge");
    expect(content).toContain('model = "gpt-5"');
    expect(content).toContain("[mcp_servers.old]");
    expect(content).toContain("[mcp_servers.added]");
  });

  it("normalizes via existing key alias when file already uses mcp_servers", () => {
    const existing = `[mcp_servers.x]\ncommand = "c"\n`;
    const incoming: McpServerSet = { y: { kind: "stdio", command: "d" } };
    // even if we request the JSON-style key, the codex file's mcp_servers is honored.
    const content = applyMerge(tomlMcpCodec, existing, incoming, "mcpServers", "merge");
    expect(content).toContain("[mcp_servers.x]");
    expect(content).toContain("[mcp_servers.y]");
  });

  it("re-encoding identical content is byte-stable", () => {
    const incoming: McpServerSet = { a: { kind: "stdio", command: "npx" } };
    const first = applyMerge(tomlMcpCodec, null, incoming, "mcp_servers", "merge");
    const second = applyMerge(tomlMcpCodec, first, incoming, "mcp_servers", "merge");
    expect(second).toBe(first);
  });
});

describe("mcp/codec selection", () => {
  it("mcpCodecFor returns json/toml codecs", () => {
    expect(mcpCodecFor("json").format).toBe("json");
    expect(mcpCodecFor("toml").format).toBe("toml");
  });
});
