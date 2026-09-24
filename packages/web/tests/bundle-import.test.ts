// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../client/api.js";
import { BundleImport } from "../client/bundle-import.js";

vi.mock("../client/api.js", () => ({ apiFetch: vi.fn() }));

describe("bundle import entry", () => {
  let host: HTMLDivElement;
  let root: Root;
  const plan = { planId: "bundle-exact", authorization: { digest: "sealed" }, actions: [] };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  beforeEach(() => {
    requests.length = 0;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      requests.push({ path, body: JSON.parse(String(init?.body)) });
      if (path === "/api/v1/resources/bundle/validate") {
        return response({
          resource: { id: "rules/example", kind: "rules", name: "Example" },
          bundleDigest: "digest",
          contentFingerprint: "fingerprint",
        });
      }
      if (path === "/api/v1/resources/bundle-import/plan") {
        return response({ plan, bundleDigest: "digest", resource: { id: "rules/example" } });
      }
      if (path === "/api/v1/resources/bundle-import/apply") {
        return response({ operation: { ok: true, receipt: { planId: "bundle-exact" } } });
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

  it("validates and applies the exact reviewed Store plan without target sync", async () => {
    const imported = vi.fn();
    await act(async () => root.render(createElement(BundleImport, { onImported: imported })));
    expect(button("Review Store import").disabled).toBe(true);
    const input = host.querySelector<HTMLInputElement>('input[type="text"]');
    if (!input) throw new Error("Missing bundle path input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "/tmp/example.cellarer-resource.json");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Validate bundle").click());
    expect(requests[0]).toEqual({
      path: "/api/v1/resources/bundle/validate",
      body: { bundlePath: "/tmp/example.cellarer-resource.json" },
    });
    await act(async () => button("Review Store import").click());
    await act(async () => button("Preview").click());
    expect(button("Confirm").disabled).toBe(false);
    await act(async () => button("Confirm").click());
    expect(requests[2]).toEqual({
      path: "/api/v1/resources/bundle-import/apply",
      body: {
        bundlePath: "/tmp/example.cellarer-resource.json",
        mutationPlan: plan,
      },
    });
    expect(requests.map((item) => item.path)).not.toContain("/api/v1/sync/apply");
    expect(imported).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Sync to an Agent is a separate action");
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
