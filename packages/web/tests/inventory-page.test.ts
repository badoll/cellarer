import type { InventoryRefreshResult } from "@cellarer/core/client-api";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../client/App.js";
import { defaultInventorySelection } from "../client/inventory-onboarding.js";
import { InventoryResultView } from "../client/inventory-page.js";

describe("Inventory bundled client view", () => {
  it("starts the bundled first-run client on Inventory onboarding", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("<h2>Inventory</h2>");
    expect(html).toContain("Loading bounded registered sources...");
  });

  it("renders shared DTO states, provenance, findings, and only Core-default selection", () => {
    const result: InventoryRefreshResult = {
      generatedAt: "2026-08-25T08:00:00.000Z",
      completeness: "partial",
      counts: {
        total: 2,
        ready: 1,
        needsAttention: 1,
        inStore: 0,
        observedSources: 2,
        failedSources: 1,
      },
      findings: [
        {
          code: "SOURCE_UNREADABLE",
          severity: "warning",
          scope: "source",
          remediation: "check-source-access",
        },
      ],
      candidates: [
        {
          id: "inventory-candidate:v1:ready",
          kind: "skills",
          name: "inventory-demo",
          contentFingerprint: "sha256:ready",
          state: "ready",
          defaultSelected: true,
          sources: [
            {
              id: "source:v1:demo",
              kind: "skills",
              scope: "global",
              location: "~/.agents/skills/inventory-demo",
              adapters: [{ id: "codex", displayName: "Codex", enabled: false, detected: false }],
            },
          ],
          relatedAdapters: [{ id: "codex", displayName: "Codex", enabled: false, detected: false }],
          findings: [],
        },
        {
          id: "inventory-candidate:v1:attention",
          kind: "rules",
          name: "unsafe-rule",
          contentFingerprint: "sha256:attention",
          state: "needs-attention",
          defaultSelected: false,
          sources: [],
          relatedAdapters: [],
          findings: [
            {
              code: "PROBABLE_SECRET",
              severity: "blocked",
              scope: "candidate",
              remediation: "remove-secret-values",
            },
          ],
        },
      ],
    };

    const html = renderToStaticMarkup(
      createElement(InventoryResultView, {
        result,
        selectedCandidateIds: defaultInventorySelection(result),
      }),
    );
    expect(html).toContain("Inventory is partial");
    expect(html).toContain("inventory-demo");
    expect(html).toContain("Ready");
    expect(html).toContain("~/.agents/skills/inventory-demo");
    expect(html).toContain("PROBABLE_SECRET");
    expect(html).toContain("remove-secret-values");
    expect(html).toContain('aria-label="Select inventory-demo" checked=""');
    expect(html).toContain('aria-label="Select unsafe-rule" disabled=""');
  });
});
