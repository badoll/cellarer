// @vitest-environment happy-dom
import type { ControlPlaneResourceDto } from "@cellarer/core/client-api";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../client/api.js";
import { filterLibrary, librarySelection } from "../client/library-model.js";
import { LibraryPage } from "../client/library-page.js";

vi.mock("../client/api.js", () => ({ apiFetch: vi.fn() }));
vi.mock("../client/agent-picker.js", () => ({ AgentPicker: () => null }));

const resource = (id: string, kind: "skills" | "mcp" | "rules", group: string) =>
  ({
    id,
    kind,
    name: id.split("/")[1],
    source: `/source/${id}`,
    state: "managed",
    currentRevision: { id: "rev-1" },
    membership: { collections: [group] },
    selection: { desired: false, collections: [group] },
    validation: { status: "valid", issues: [] },
    secretReferenceNames: ["API_TOKEN"],
    usage: { desired: [], applied: [] },
  }) as unknown as ControlPlaneResourceDto;

const resources = [
  resource("skills/alpha", "skills", "work"),
  resource("mcp/beta", "mcp", "home"),
  resource("rules/gamma", "rules", "work"),
];

describe("Agent Config Library", () => {
  it("filters mixed kinds while preserving exact stored IDs and hidden count", () => {
    const visible = filterLibrary(resources, { kind: "rules", query: "", group: "work" });
    expect(visible.map((item) => item.id)).toEqual(["rules/gamma"]);
    expect(librarySelection(resources, visible, ["skills/alpha", "rules/gamma"])).toEqual({
      exactIds: ["rules/gamma", "skills/alpha"],
      hiddenIds: ["skills/alpha"],
    });
    expect(
      filterLibrary(resources, { kind: "all", query: "SOURCE/MCP", group: "" }).map(
        (item) => item.id,
      ),
    ).toEqual(["mcp/beta"]);
    const discovered = {
      ...resource("skills/unimported", "skills", "work"),
      discovered: { agent: "codex" },
    } as ControlPlaneResourceDto;
    expect(
      librarySelection(
        [...resources, discovered],
        [...resources, discovered],
        ["skills/unimported"],
      ).exactIds,
    ).toEqual([]);
  });
});

describe("mounted library selection", () => {
  let host: HTMLDivElement;
  let root: Root;
  let plannedBodies: unknown[];
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    plannedBodies = [];
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path === "/api/v1/sync/plan") {
        plannedBodies.push(JSON.parse(String(init?.body)));
        return response({ plan: { actions: [], warnings: [] }, mutationPlan: { planId: "exact" } });
      }
      return response({
        resources,
        warnings: [],
        generatedAt: "2026-09-24T00:00:00Z",
        counts: {
          managed: 3,
          discovered: 0,
          synced: 0,
          drifted: 0,
          missing: 0,
          blocked: 0,
        },
      });
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.mocked(apiFetch).mockReset();
    vi.unstubAllGlobals();
  });

  it("keeps hidden selections and sends only checked IDs to preview", async () => {
    await act(async () => root.render(createElement(LibraryPage, { onNavigate() {} })));
    await act(async () => choose("Select skills/alpha"));
    await act(async () => choose("Select rules/gamma"));
    const typeButton = [...host.querySelectorAll(".library-kind-tabs button")].find(
      (button) => button.textContent === "Rules",
    ) as HTMLButtonElement;
    await act(async () => typeButton.click());
    expect(host.querySelector('[role="status"]')?.textContent).toContain("2 selected · 1 hidden");
    const groupFilter = host.querySelector<HTMLSelectElement>(".library-toolbar select");
    if (!groupFilter) throw new Error("Missing group filter");
    await act(async () => {
      groupFilter.value = "home";
      groupFilter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("2 selected · 2 hidden");
    await act(async () => {
      groupFilter.value = "";
      groupFilter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelector('[role="status"]')?.textContent).toContain("2 selected · 1 hidden");
    await act(async () => choose("Sync to Agents"));
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
      "Exact resources: rules/gamma, skills/alpha",
    );
    await act(async () => choose("Preview"));
    expect(plannedBodies).toEqual([
      expect.objectContaining({
        resources: { ids: ["rules/gamma", "skills/alpha"] },
      }),
    ]);
  });

  it("shows reference names and typed target evidence without dumping raw DTO fields", async () => {
    const secretValue = "should-never-render";
    resources[0] = { ...resources[0], hiddenSecretValue: secretValue } as ControlPlaneResourceDto;
    await act(async () => root.render(createElement(LibraryPage, { onNavigate() {} })));
    await act(async () => choose("alpha"));
    expect(host.querySelector(".library-detail")?.textContent).toContain("API_TOKEN");
    expect(host.textContent).not.toContain(secretValue);
  });

  it("labels a source update separately and shows only checked evidence fields", async () => {
    const hiddenValue = "private-source-token";
    vi.mocked(apiFetch).mockImplementation(async (path) =>
      response(
        path === "/api/v1/resources/update/check"
          ? {
              status: "update-available",
              currentRevisionId: "rev-1",
              checkedAt: "2026-09-24T00:00:00Z",
              unexpectedSecretValue: hiddenValue,
            }
          : {
              resources,
              warnings: [],
              counts: { managed: 3, discovered: 0, synced: 0, drifted: 0, missing: 0, blocked: 0 },
            },
      ),
    );
    await act(async () => root.render(createElement(LibraryPage, { onNavigate() {} })));
    await act(async () => choose("alpha"));
    await act(async () => choose("Check source update"));
    expect(host.querySelector(".library-detail")?.textContent).toContain("Update available");
    expect(host.querySelector(".library-detail")?.textContent).toContain(
      "separate from target sync",
    );
    expect(host.textContent).not.toContain(hiddenValue);
  });

  function choose(label: string) {
    const control =
      host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`) ??
      [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === label,
      );
    if (!control) throw new Error(`Missing control ${label}`);
    control.click();
  }
});

function response(data: unknown) {
  return new Response(JSON.stringify({ status: "success", data }));
}
