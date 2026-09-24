// @vitest-environment happy-dom
import type {
  ControlPlaneResourceListDto,
  DashboardSummaryResult,
} from "@cellarer/core/client-api";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../client/api.js";
import { OverviewPage, overviewEvidence } from "../client/overview-page.js";

vi.mock("../client/api.js", () => ({ apiFetch: vi.fn() }));

const summary = {
  agentCounts: { detected: 2 },
  driftCounts: { ok: 3, drifted: 1, missing: 1, "broken-link": 0 },
  driftItems: [
    {
      artifact: "skills/alpha",
      agent: "codex",
      scope: "global",
      target: "/target",
      status: "drifted",
    },
  ],
  distributionCoverage: [{ blockedCount: 1 }],
  warnings: [],
} as unknown as DashboardSummaryResult;
const library = {
  resources: [{ id: "skills/alpha", state: "managed", currentRevision: { id: "rev-2" } }],
} as unknown as ControlPlaneResourceListDto;

describe("Overview evidence", () => {
  it("keeps unknown reads unavailable and never treats native loading as verified", () => {
    expect(overviewEvidence(null, null)).toMatchObject({
      storedCount: null,
      matchingTargets: null,
      pendingTargets: null,
      blockedCoverage: null,
      nativeLoading: "unverified",
      sourceUpdates: "not checked",
    });
    expect(overviewEvidence(summary, library)).toMatchObject({
      storedCount: 1,
      matchingTargets: 3,
      pendingTargets: 2,
      blockedCoverage: 1,
      conflicts: null,
    });
  });

  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.mocked(apiFetch).mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify({
            status: "success",
            data: path === "/api/v1/summary" ? summary : library,
          }),
        ),
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.mocked(apiFetch).mockReset();
    vi.unstubAllGlobals();
  });

  it("links each affected target to its exact stored resource", async () => {
    const opened: Array<string | undefined> = [];
    await act(async () =>
      root.render(
        createElement(OverviewPage, {
          onDiscover() {},
          onOpenResource(id) {
            opened.push(id);
          },
          onSync() {},
          onHistory() {},
        }),
      ),
    );
    const button = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === "Inspect exact resource",
    );
    await act(async () => button?.click());
    expect(opened).toEqual(["skills/alpha"]);
    expect(host.textContent).toContain("native loading unverified");
    expect(host.textContent).toContain("Conflicts: unavailable");
  });
});
