import type { PostCommitInventoryRefresh } from "@cellarer/core/client-api";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  adapterPatch,
  BUILTIN_ADAPTER_IDS,
  PostCommitInventoryNotice,
} from "../client/agents-page.js";

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

  it.each([
    ["complete", undefined],
    ["partial", "cellarer inventory refresh --agent my-agent"],
    ["failed", "cellarer inventory refresh --agent my-agent"],
  ] as const)("keeps the adapter mutation committed when post-commit Inventory is %s", (status, retryCommand) => {
    const refresh = {
      agentId: "my-agent",
      status,
      inventory: {
        generatedAt: "2026-08-10T08:00:00.000Z",
        candidates: [],
        findings: [],
        counts: {
          total: 0,
          ready: 0,
          needsAttention: 0,
          inStore: 0,
          observedSources: 1,
          failedSources: status === "complete" ? 0 : 1,
        },
        completeness: status,
      },
      ...(retryCommand ? { retryCommand } : {}),
    } as PostCommitInventoryRefresh;
    const html = renderToStaticMarkup(createElement(PostCommitInventoryNotice, { refresh }));

    expect(html).toContain("Adapter mutation committed");
    expect(html).toContain(`Inventory refresh ${status}`);
    if (retryCommand) expect(html).toContain(retryCommand);
    else expect(html).not.toContain("Retry manually");
  });
});
