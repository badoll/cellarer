import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImportDialog } from "../client/import-dialog.js";

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
});
