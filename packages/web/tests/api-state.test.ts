import { describe, expect, it } from "vitest";
import { readApiJson } from "../client/api-state.js";

describe("client api state", () => {
  it("turns API error responses into thrown errors", async () => {
    await expect(
      readApiJson(
        new Response(JSON.stringify({ error: "invalid config: adapter" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    ).rejects.toThrow("invalid config: adapter");
  });

  it("returns JSON for successful responses", async () => {
    await expect(
      readApiJson<{ ok: true }>(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ).resolves.toEqual({ ok: true });
  });
});
