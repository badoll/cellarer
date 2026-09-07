// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../client/api.js";

vi.mock("../client/api.js", () => ({ apiFetch: vi.fn() }));

import { SyncDialog } from "../client/sync-dialog.js";
import { buildSyncSelection, collectionFilterSelection } from "../client/sync-selection.js";

const input = { agents: "codex", destination: "user" as const, dir: "", kinds: ["rules" as const] };

describe("Web sync selection", () => {
  it.each(["work", "personal"])("binds the %s filter to request and summary", (collection) => {
    const selection = buildSyncSelection({
      ...input,
      collections: collectionFilterSelection(` ${collection} `),
    });
    expect(selection.request.resources?.collections).toEqual([collection]);
    expect(selection.collectionSummary).toBe(collection);
  });

  it("keeps an empty filter on Store defaults, without claiming all collections", () => {
    const selection = buildSyncSelection({
      ...input,
      collections: collectionFilterSelection("  "),
    });
    expect(selection.request.resources?.collections).toBeUndefined();
    expect(selection.collectionSummary).toBe("Store defaults");
    const html = renderToStaticMarkup(
      createElement(SyncDialog, {
        open: true,
        kinds: ["rules"],
        onClose() {},
        onApplied() {},
      }),
    );
    expect(html).toContain("Store defaults");
    expect(html).not.toContain("All collections");
    expect(html).toContain("Discovered resources must be imported first");
  });
});

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function planned(id: string) {
  return new Response(
    JSON.stringify({
      status: "success",
      data: {
        plan: { actions: [], warnings: [id] },
        mutationPlan: { planId: id, actions: [{ exact: id }] },
      },
    }),
  );
}
function stale() {
  return new Response(
    JSON.stringify({
      status: "error",
      error: {
        code: "STALE_REVISION",
        message: "Store revision changed",
        details: { replanRequired: true },
      },
    }),
    { status: 409 },
  );
}

describe("mounted sync lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onApplied: ReturnType<typeof vi.fn>;
  async function render(collection = "work", open = true, kind: "rules" | "skills" = "rules") {
    await act(async () =>
      root.render(
        createElement(SyncDialog, {
          open,
          collections: [collection],
          kinds: [kind],
          onClose() {},
          onApplied,
        }),
      ),
    );
  }
  function button(text: string) {
    const element = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === text,
    );
    if (!element) throw new Error(`Missing button ${text}`);
    return element;
  }
  async function click(text: string) {
    await act(async () => button(text).click());
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(apiFetch).mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onApplied = vi.fn();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it.each([
    "success",
    "error",
  ])("ignores an obsolete %s after another selection preview", async (outcome) => {
    const old = deferred();
    vi.mocked(apiFetch)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(planned("personal-plan"));
    await render();
    await click("Preview");
    await render("personal");
    expect(button("Preview").disabled).toBe(false);
    await click("Preview");
    await act(async () => old.resolve(outcome === "success" ? planned("old-plan") : stale()));
    expect(container.textContent).toContain("personal-plan");
    expect(container.textContent).not.toContain("old-plan");
    expect(container.textContent).not.toContain("Store revision changed");
    expect(button("Apply").disabled).toBe(false);
  });

  it("invalidates close/reopen and cannot revive a pending plan for the same selection", async () => {
    const old = deferred();
    vi.mocked(apiFetch).mockReturnValueOnce(old.promise);
    await render();
    await click("Preview");
    await render("work", false);
    await render();
    await act(async () => old.resolve(planned("old-session")));
    expect(button("Apply").disabled).toBe(true);
    expect(button("Preview").disabled).toBe(false);
    expect(container.textContent).not.toContain("old-session");
  });

  it("preserves an equivalent selection rerender but invalidates changed kinds and collections", async () => {
    vi.mocked(apiFetch).mockResolvedValue(planned("reviewed"));
    await render();
    await click("Preview");
    await render();
    expect(button("Apply").disabled).toBe(false);
    await render("personal");
    expect(button("Apply").disabled).toBe(true);
    await click("Preview");
    await render("personal", true, "skills");
    expect(button("Apply").disabled).toBe(true);
  });

  it("does not clear the busy state of a newer preview when the old request settles", async () => {
    const old = deferred();
    const current = deferred();
    vi.mocked(apiFetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await render();
    await click("Preview");
    await render("personal");
    await click("Preview");
    await act(async () => old.resolve(stale()));
    expect(button("Previewing...").disabled).toBe(true);
    expect(button("Apply").disabled).toBe(true);
    await act(async () => current.resolve(planned("current")));
    expect(button("Apply").disabled).toBe(false);
  });

  it("invalidates changes to agents, destination and project directory", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => planned("reviewed"));
    await render();
    await click("Preview");
    const input = container.querySelector("input[type=text]") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "claude-code");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Apply").disabled).toBe(true);
    await click("Preview");
    await act(async () =>
      (container.querySelectorAll("input[type=radio]")[1] as HTMLInputElement).click(),
    );
    expect(button("Apply").disabled).toBe(true);
    const dir = container.querySelector(".dir-input") as HTMLInputElement;
    await act(async () => {
      setter?.call(dir, "/tmp/first");
      dir.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Preview");
    expect(button("Apply").disabled).toBe(false);
    await act(async () => {
      setter?.call(dir, "/tmp/second");
      dir.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Apply").disabled).toBe(true);
  });

  it("finishes a pending preview after an equivalent whitespace-only input change", async () => {
    const pending = deferred();
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise);
    await render();
    await click("Preview");
    const input = container.querySelector("input[type=text]") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "codex ",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => pending.resolve(planned("current")));
    expect(button("Preview").disabled).toBe(false);
    expect(button("Apply").disabled).toBe(false);
  });

  it("submits the exact plan once and requires preview after typed stale rejection", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(planned("exact-plan")).mockResolvedValueOnce(stale());
    await render();
    await click("Preview");
    await click("Apply");
    expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[1]?.[1]?.body))).toEqual({
      mutationPlan: { planId: "exact-plan", actions: [{ exact: "exact-plan" }] },
    });
    expect(container.textContent).toContain("Preview again");
    expect(container.textContent).toContain("STALE_REVISION");
    expect(button("Apply").disabled).toBe(true);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(onApplied).not.toHaveBeenCalled();
  });
});
