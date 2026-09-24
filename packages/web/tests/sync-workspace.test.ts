// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../client/api.js";
import { SyncWorkspace } from "../client/sync-workspace.js";

vi.mock("../client/api.js", () => ({ apiFetch: vi.fn() }));
vi.mock("../client/agent-picker.js", () => ({ AgentPicker: () => null }));

describe("explicit sync workspace intent", () => {
  let host: HTMLDivElement;
  let root: Root;
  const plans: unknown[] = [];
  beforeEach(() => {
    plans.length = 0;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path === "/api/v1/resources?includeDiscovered=false")
        return response({
          resources: [{ id: "rules/a", kind: "rules", membership: { collections: ["work"] } }],
        });
      if (path === "/api/v1/collections") return response({ collections: [{ name: "work" }] });
      if (path === "/api/v1/profiles") return response({ profiles: [] });
      if (path === "/api/v1/sync/plan") {
        plans.push(JSON.parse(String(init?.body)));
        return response({
          plan: { actions: [], warnings: [], conflicts: [] },
          mutationPlan: { planId: "exact" },
        });
      }
      throw new Error(`Unexpected path ${path}`);
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.mocked(apiFetch).mockReset();
    vi.unstubAllGlobals();
  });

  it("requires a choice and keeps group, defaults, and Profile distinct", async () => {
    await act(async () => root.render(createElement(SyncWorkspace, { onApplied() {} })));
    expect(button("Choose target and preview").disabled).toBe(true);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button("Group").click());
    const select = host.querySelector<HTMLSelectElement>("select");
    if (!select) throw new Error("Missing group picker");
    await act(async () => {
      select.value = "work";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Choose target and preview").click());
    await act(async () => button("Preview").click());
    expect(plans).toEqual([expect.objectContaining({ resources: { collections: ["work"] } })]);
    await act(async () => button("Profile").click());
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain("Profile reconciliation uses its separate Core contract");
    await act(async () => button("Store defaults").click());
    await act(async () => button("Choose target and preview").click());
    await act(async () => button("Preview").click());
    expect(plans[1]).toEqual({ agents: ["codex"], destination: "user" });
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
