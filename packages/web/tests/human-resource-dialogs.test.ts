// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../client/api.js";
import { ProfilesPage } from "../client/profiles-page.js";
import { type WorkflowAction, WorkflowDialog } from "../client/workflow-dialog.js";

vi.mock("../client/api.js", () => ({ apiFetch: vi.fn() }));
vi.mock("../client/agent-picker.js", () => ({ AgentPicker: () => null }));
const action: WorkflowAction = {
  title: "Remove",
  description: "Store only",
  planPath: "/api/v1/resources/remove/plan",
  applyPath: "/api/v1/resources/remove/apply",
  input: { resourceId: "rules/a", cascade: false },
  applyInput: { resourceId: "rules/a", cascade: false },
  success: "Removed",
};
const plan = {
  planId: "exact",
  authorization: { proof: "sealed" },
  normalizedInputs: {},
  actions: [],
};
const response = (data: unknown) => new Response(JSON.stringify({ status: "success", data }));
describe("workflow dialog authority", () => {
  let container: HTMLDivElement;
  let root: Root;
  const applied = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(apiFetch).mockReset();
    applied.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const render = (value = action) =>
    act(async () =>
      root.render(
        createElement(WorkflowDialog, { action: value, onClose() {}, onApplied: applied }),
      ),
    );
  function button(text: string) {
    const item = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === text,
    );
    if (!item) throw Error(`missing ${text}`);
    return item;
  }
  const click = (text: string) => act(async () => button(text).click());
  it.each([
    "STALE_REVISION",
    "RECOVERY_REQUIRED",
    "TARGET_CONFLICT",
  ])("consumes exact plan once and invalidates %s failures", async (code) => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(response({ plan, blocked: [] }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "error",
            error: {
              code,
              message: "blocked",
              details: { operationId: "op-one", replanRequired: true },
            },
          }),
          { status: 409 },
        ),
      );
    await render();
    expect(button("Confirm").disabled).toBe(true);
    await click("Preview");
    await click("Confirm");
    expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[1]?.[1]?.body))).toEqual({
      ...action.applyInput,
      mutationPlan: plan,
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(applied).not.toHaveBeenCalled();
    expect(button("Confirm").disabled).toBe(true);
    expect(container.textContent).toContain(code);
    expect(container.textContent).toContain("op-one");
  });
  it("adds read-only recovery evidence to a lock failure without retrying apply", async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(response({ plan }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "error",
            error: { code: "LOCK_CONFLICT", message: "recovery claim held" },
          }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        response({
          ready: false,
          blockers: [{ code: "RECOVERY_REQUIRED", operationId: "recovery-one" }],
        }),
      );
    await render();
    await click("Preview");
    await click("Confirm");
    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(apiFetch).mock.calls[2]).toEqual(["/api/v1/readiness"]);
    expect(container.textContent).toContain("LOCK_CONFLICT");
    expect(container.textContent).toContain("RECOVERY_REQUIRED");
    expect(container.textContent).toContain("recovery-one");
    expect(button("Confirm").disabled).toBe(true);
    expect(applied).not.toHaveBeenCalled();
  });
  it("rejects late previews when exact action selection changes", async () => {
    let resolve!: (response: Response) => void;
    vi.mocked(apiFetch).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render();
    await click("Preview");
    await render({ ...action, input: { resourceId: "rules/b", cascade: false } });
    await act(async () => resolve(response({ plan, blocked: [] })));
    expect(button("Confirm").disabled).toBe(true);
  });
  it("ignores verification arriving after selecting another Profile context", async () => {
    let resolve!: (response: Response) => void;
    const profile = {
      profileId: "daily",
      revision: "one",
      desired: {
        agentIds: ["codex"],
        scope: "global",
        resourceIds: [],
        collectionIds: ["work"],
        capabilities: ["mcp"],
        method: "copy",
        mergePolicy: "merge",
      },
    };
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (path === "/api/v1/profiles") return response({ profiles: [profile] });
      if (path === "/api/v1/collections") return response({ collections: [{ name: "work" }] });
      if (path === "/api/v1/profiles/daily/verify")
        return new Promise((done) => {
          resolve = done;
        });
      return response({ resources: [] });
    });
    await act(async () => root.render(createElement(ProfilesPage)));
    await click("daily");
    expect(button("Preview historical revert").disabled).toBe(true);
    await click("Verify deployment");
    await click("New Profile");
    await act(async () =>
      resolve(
        response({
          configuration: "healthy",
          desiredVsApplied: { status: "converged" },
          appliedVsDisk: { status: "converged" },
          runtime: { observation: "unknown" },
        }),
      ),
    );
    expect(container.querySelector('[aria-label="Deployment verification"]')).toBeNull();
  });
  it("blocked dependencies are visible and cannot confirm", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      response({
        plan,
        blocked: ["PROFILE_DEPENDENCY"],
        dependencyReport: { profiles: [{ profileId: "daily" }] },
      }),
    );
    await render();
    await click("Preview");
    expect(button("Confirm").disabled).toBe(true);
    expect(container.textContent).toContain("PROFILE_DEPENDENCY");
    expect(container.textContent).toContain("daily");
  });
});
