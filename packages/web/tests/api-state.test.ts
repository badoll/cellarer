import { describe, expect, it } from "vitest";
import { ClientApiError, readApiJson } from "../client/api-state.js";

describe("client api state", () => {
  it("turns API error responses into thrown errors", async () => {
    const error = await readApiJson(
      new Response(
        JSON.stringify({
          apiVersion: "1.0",
          requestId: "req-error",
          status: "error",
          warnings: [],
          error: { code: "DOMAIN_VALIDATION_FAILED", message: "invalid config: adapter" },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      ),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClientApiError);
    expect(error).toMatchObject({
      message: "invalid config: adapter",
      code: "DOMAIN_VALIDATION_FAILED",
      requestId: "req-error",
      httpStatus: 400,
    });
  });

  it("preserves stale-plan remediation as typed client state", async () => {
    const error = await readApiJson(
      new Response(
        JSON.stringify({
          apiVersion: "1.0",
          requestId: "req-stale",
          status: "error",
          warnings: [],
          error: {
            code: "STALE_REVISION",
            message: "plan revision is stale",
            details: { coreCode: "STALE_REVISION" },
          },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "STALE_REVISION",
      details: { coreCode: "STALE_REVISION" },
      httpStatus: 409,
    });
  });

  it("returns JSON for successful responses", async () => {
    await expect(
      readApiJson<{ ok: true }>(
        new Response(
          JSON.stringify({
            apiVersion: "1.0",
            requestId: "req-success",
            status: "success",
            warnings: [],
            data: { ok: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("returns typed readiness data from a successful 503 envelope", async () => {
    await expect(
      readApiJson<{ ready: false; blockers: readonly { code: string }[] }>(
        new Response(
          JSON.stringify({
            apiVersion: "1.0",
            requestId: "req-not-ready",
            status: "success",
            warnings: [],
            data: { ready: false, blockers: [{ code: "RECOVERY_REQUIRED" }] },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      ),
    ).resolves.toEqual({ ready: false, blockers: [{ code: "RECOVERY_REQUIRED" }] });
  });
});
