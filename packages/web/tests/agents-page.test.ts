import { describe, expect, it } from "vitest";
import { adapterPatch } from "../client/agents-page.js";

describe("AgentsPage adapter helpers", () => {
  it("does not override built-in MCP dialect when patching paths", () => {
    expect(
      adapterPatch({
        adapterId: "codex",
        displayName: "",
        rulesGlobal: "",
        mcpGlobal: "~/.codex/custom.toml",
        skillsGlobal: "",
      }),
    ).toEqual({
      displayName: undefined,
      rules: undefined,
      mcp: { global: "~/.codex/custom.toml" },
      skills: undefined,
    });
  });

  it("includes JSON MCP dialect fields for custom adapters", () => {
    expect(
      adapterPatch({
        adapterId: "my-agent",
        displayName: "My Agent",
        rulesGlobal: "~/.my-agent/AGENTS.md",
        mcpGlobal: "~/.my-agent/mcp.json",
        skillsGlobal: "~/.my-agent/skills",
      }),
    ).toMatchObject({
      displayName: "My Agent",
      rules: { global: "~/.my-agent/AGENTS.md", format: "markdown" },
      mcp: { global: "~/.my-agent/mcp.json", format: "json", serversKey: "mcpServers" },
      skills: { global: "~/.my-agent/skills", format: "dir" },
    });
  });
});
