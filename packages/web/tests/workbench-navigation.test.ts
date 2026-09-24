// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../client/App.js";
import { apiFetch } from "../client/api.js";
import { workbenchLabels, workbenchLocale } from "../client/workbench-labels.js";

vi.mock("../client/api.js", () => ({
  apiFetch: vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: {
            resources: [],
            warnings: [],
            counts: { managed: 0, discovered: 0, synced: 0, drifted: 0, missing: 0, blocked: 0 },
            collections: [],
            latestActivity: [],
            agents: [],
            profiles: [],
          },
        }),
      ),
  ),
  streamInventory: vi.fn(async () => {
    throw new Error("Inventory unavailable in navigation fixture");
  }),
}));

describe("management navigation", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens the library and reaches discovery and Profiles through task destinations", async () => {
    await act(async () => root.render(createElement(App)));
    expect(host.querySelector("h2")?.textContent).toBe("Agent Config Library");
    expect(
      [...host.querySelectorAll(".sidebar .nav button")].map(
        (item) => item.querySelector(".nav-label")?.textContent,
      ),
    ).toEqual([
      "Overview",
      "Agent Config Library",
      "Sync",
      "Agents",
      "Operation History",
      "Settings",
    ]);
    const active = host.querySelector<HTMLButtonElement>(
      ".sidebar .nav button[aria-current='page']",
    );
    active?.focus();
    expect(document.activeElement).toBe(active);
    await act(async () => clickButton(host, "Find existing configuration"));
    expect(host.querySelector("h2")?.textContent).toBe("Find existing configuration");
    await act(async () => clickNav(host, "Agents"));
    await act(async () => clickButton(host, "Profiles"));
    expect(host.querySelector("h2")?.textContent).toBe("Profiles");
  });

  it("uses Chinese for Chinese browser language and English otherwise", () => {
    expect(workbenchLocale("zh-CN")).toBe("zh-CN");
    expect(workbenchLocale("zh-TW")).toBe("zh-CN");
    expect(workbenchLocale("fr-FR")).toBe("en");
    expect(workbenchLabels("zh-CN").navigation.library).toBe("Agent 配置库");
    expect(workbenchLabels("zh-CN").intent.group).toBe("分组");
    expect(workbenchLabels("en").status.nativeUnverified).toBe("Native loading unverified");
  });

  it("renders the primary journey in Chinese for a Chinese browser", async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("zh-CN");
    await act(async () => root.render(createElement(App)));
    expect(host.querySelector("h2")?.textContent).toBe("Agent 配置库");
    expect(host.querySelector(".sidebar .nav")?.textContent).toContain("操作记录");
    expect(host.querySelector(".content")?.textContent).toContain("查找已有配置");
  });

  it("keeps the library as the returning user's entry when Store contains resources", async () => {
    vi.mocked(apiFetch).mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            status: "success",
            data: {
              resources: [
                {
                  id: "skills/example",
                  name: "Example",
                  kind: "skills",
                  state: "managed",
                  source: "local",
                  membership: { collections: [] },
                  usage: { applied: [] },
                  secretReferenceNames: [],
                  currentRevision: { id: "v1" },
                  validation: { status: "valid", issues: [] },
                },
              ],
              warnings: [],
              counts: { managed: 1, discovered: 0, synced: 0, drifted: 0, missing: 0, blocked: 0 },
              collections: [],
              latestActivity: [],
              agents: [],
              profiles: [],
            },
          }),
        ),
    );
    await act(async () => root.render(createElement(App)));
    expect(host.querySelector("h2")?.textContent).toBe("Agent Config Library");
    expect(host.querySelector(".resource-table")?.textContent).toContain("Example");
    expect(host.textContent).not.toContain("first-run");
  });
});

function clickButton(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing button ${label}`);
  button.click();
}

function clickNav(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll(".sidebar .nav button")].find(
    (item) => item.querySelector(".nav-label")?.textContent === label,
  );
  if (!button) throw new Error(`Missing navigation ${label}`);
  button.click();
}
