import { describe, expect, it } from "vitest";
import { adapterPatch, BUILTIN_ADAPTER_IDS } from "../client/agents-page.js";

describe("AgentsPage adapter helpers", () => {
  it("does not override built-in MCP dialect when patching paths", () => {
    for (const adapterId of BUILTIN_ADAPTER_IDS) {
      expect(
        adapterPatch({
          adapterId,
          displayName: "",
          rulesGlobal: "",
          mcpGlobal: `~/.${adapterId}/custom-mcp`,
          skillsGlobal: "",
        }),
      ).toEqual({
        displayName: undefined,
        rules: undefined,
        mcp: { global: `~/.${adapterId}/custom-mcp` },
        skills: undefined,
      });
    }
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
