// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPicker } from "../client/agent-picker.js";
import { apiFetch } from "../client/api.js";
import { ProfilesPage } from "../client/profiles-page.js";

vi.mock("../client/api.js", () => ({ apiFetch: vi.fn() }));

describe("Agent and Profile follow-up", () => {
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
    vi.mocked(apiFetch).mockReset();
    vi.unstubAllGlobals();
  });

  it("keeps unsupported Agent scopes visible but unselectable", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      response({
        agents: [
          {
            id: "limited",
            displayName: "Limited",
            enabled: true,
            detected: true,
            capabilityScopes: { rules: ["global"], mcp: [], skills: [] },
            compatibility: [
              {
                capability: "rules",
                evidence: "unsupported",
                native: "unknown",
                prerequisites: ["Project placement unavailable"],
              },
            ],
          },
        ],
        warnings: [],
      }),
    );
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        createElement(AgentPicker, {
          value: [],
          onChange,
          scope: "project",
          dir: "/workspace",
          kinds: ["rules"],
        }),
      ),
    );
    const target = host.querySelector<HTMLInputElement>('input[aria-label="Target limited"]');
    expect(target?.disabled).toBe(true);
    expect(host.textContent).toContain("Unsupported scope");
    expect(host.textContent).toContain("Project placement unavailable");
    await act(async () => target?.click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps Profile edit separate from shared-consumer uninstall preview", async () => {
    const requests: { path: string; body: unknown }[] = [];
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path === "/api/v1/profiles")
        return response({
          profiles: [
            {
              profileId: "daily",
              revision: "v1",
              desired: {
                agentIds: ["codex"],
                scope: "global",
                resourceIds: ["rules/a"],
                collectionIds: [],
                capabilities: ["rules"],
                method: "copy",
                mergePolicy: "merge",
              },
            },
          ],
        });
      if (path === "/api/v1/resources?includeDiscovered=false")
        return response({ resources: [{ id: "rules/a", kind: "rules" }] });
      if (path === "/api/v1/collections") return response({ collections: [] });
      if (path.startsWith("/api/v1/agents?")) return response({ agents: [], warnings: [] });
      requests.push({ path, body: JSON.parse(String(init?.body)) });
      return response({
        plan: { planId: "uninstall", authorization: { proof: "sealed" }, actions: [] },
        targets: [
          {
            key: "shared",
            target: "/shared/AGENTS.md",
            proposedAction: "retain",
            consumerSet: ["daily", "other"],
          },
        ],
      });
    });
    await act(async () => root.render(createElement(ProfilesPage)));
    await act(async () => button("daily").click());
    expect(button("Review Profile").disabled).toBe(false);
    expect(button("Preview reconciliation").disabled).toBe(false);
    await act(async () => button("Preview uninstall").click());
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("Shared content stays");
    await act(async () => button("Preview").click());
    expect(requests).toEqual([{ path: "/api/v1/profiles/daily/uninstall/plan", body: {} }]);
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
      "Consumers before: daily, other",
    );
    expect(requests.map((item) => item.path)).not.toContain(
      "/api/v1/profiles/daily/uninstall/apply",
    );
  });

  function button(label: string) {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent?.trim() === label,
    );
    if (!found) throw new Error(`Missing button ${label}`);
    return found;
  }
});

function response(data: unknown) {
  return new Response(JSON.stringify({ status: "success", data }));
}
