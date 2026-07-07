import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImportDialog, selectItemsForPlan } from "../client/import-dialog.js";

describe("ImportDialog", () => {
  it("requires a preview before applying an import", () => {
    const html = renderToStaticMarkup(
      createElement(ImportDialog, {
        open: true,
        kind: "rules",
        onClose: () => undefined,
        onImported: () => undefined,
      }),
    );

    expect(html).toContain('aria-label="Import existing setup"');
    expect(html).toContain("Preview");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Import<\/button>/);
  });

  it("locks apply selection to importable rows from the preview plan", () => {
    expect(
      selectItemsForPlan({
        agent: "codex",
        scope: "global",
        warnings: [],
        items: [
          {
            kind: "rules",
            name: "team",
            status: "new",
            action: "import",
            source: "/home/.codex/AGENTS.md",
          },
          {
            kind: "mcp",
            name: "ctx",
            status: "conflict",
            action: "skip",
            source: "/home/.codex/config.toml",
          },
        ],
      }),
    ).toEqual([{ kind: "rules", name: "team", source: "/home/.codex/AGENTS.md" }]);
  });
});
