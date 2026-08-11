import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDurableMutationPlan,
  createRealEnv,
  type Env,
  initializeStore,
  type MutationPlan,
  mutateCollection,
  mutationLockPath,
} from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishOperationJournal } from "../../core/src/protocol/journal.js";
import { createApp } from "../src/app.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

interface SuccessEnvelope<T> {
  readonly status: "success";
  readonly data: T;
}

interface ErrorEnvelope {
  readonly status: "error";
  readonly error: {
    readonly code: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

describe("versioned HTTP mutation journeys", () => {
  let root: string;
  let storeRoot: string;
  let env: Env;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-http-mutation-")));
    storeRoot = join(root, "home", ".cellarer");
    const real = createRealEnv();
    env = {
      ...real,
      homedir: () => join(root, "home"),
      cwd: () => join(root, "workspace"),
      now: () => new Date("2026-08-10T09:00:00.000Z"),
      env: {},
      mutationAuthority: deterministicMutationAuthority(),
    };
    await fs.mkdir(join(root, "workspace"), { recursive: true });
    await initializeStore(env, storeRoot);
    app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
  });

  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it("applies the exact plan receipt returned by planning", async () => {
    const planned = await planCollection("exact");
    const response = await post("/api/v1/mutations/apply", {
      mutationPlan: JSON.parse(JSON.stringify(planned.plan)),
    });
    const body = (await response.json()) as SuccessEnvelope<{
      readonly plan: MutationPlan;
      readonly operation: {
        readonly ok: true;
        readonly receipt: { readonly planId: string; readonly planDigest: string };
      };
    }>;

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.data.plan).toEqual(planned.plan);
    expect(body.data.operation.receipt).toMatchObject({
      planId: planned.plan.planId,
      planDigest: planned.plan.digest,
    });
  });

  it("returns the same Core mutation DTO that the CLI path consumes", async () => {
    env.randomId = () => "parity";
    app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
    const core = await mutateCollection(env, {
      storeRoot,
      action: "create",
      collectionName: "parity",
      description: "shared Core DTO",
      resourceIds: [],
      dryRun: true,
    });

    const response = await post("/api/v1/collections/plan", {
      action: "create",
      collectionName: "parity",
      description: "shared Core DTO",
      resourceIds: [],
    });
    const body = (await response.json()) as SuccessEnvelope<typeof core>;

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.data).toEqual(core);
    const applied = await post("/api/v1/mutations/apply", { mutationPlan: body.data.plan });
    expect(await applied.json()).toMatchObject({
      status: "success",
      data: {
        plan: { planId: core.plan.planId, digest: core.plan.digest },
        operation: {
          ok: true,
          receipt: { planId: core.plan.planId, planDigest: core.plan.digest },
        },
      },
    });
  });

  it("rejects a changed seal-bound field as a typed invalid plan", async () => {
    const planned = await planCollection("altered");
    const changed = JSON.parse(JSON.stringify(planned.plan)) as MutationPlan & {
      actions: { payload: Record<string, unknown> }[];
    };
    const action = changed.actions[0];
    if (!action) throw new Error("expected one collection action");
    action.payload.data = "attacker-controlled";

    const response = await post("/api/v1/mutations/apply", { mutationPlan: changed });
    const body = (await response.json()) as ErrorEnvelope;

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      status: "error",
      error: { code: "DOMAIN_VALIDATION_FAILED", details: { coreCode: "INVALID_PLAN" } },
    });
    expect(await collectionNames()).toEqual([]);
  });

  it("returns the shared stale code when another client commits first", async () => {
    const first = await planCollection("first");
    const stale = await planCollection("stale");
    expect((await post("/api/v1/mutations/apply", { mutationPlan: first.plan })).status).toBe(200);

    const response = await post("/api/v1/mutations/apply", { mutationPlan: stale.plan });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: "error",
      error: {
        code: "STALE_REVISION",
        details: {
          coreCode: "STALE_REVISION",
          planId: "untrusted",
          expectedRevision: stale.plan.baseRevision,
          actualRevision: first.plan.baseRevision + 1,
          replanRequired: true,
        },
      },
    });
  });

  it("returns TARGET_CONFLICT when a planned target drifts", async () => {
    const planned = await planCollection("drift");
    const configPath = join(storeRoot, "config.json");
    const external = JSON.parse(await env.fs.readFile(configPath)) as {
      collections: Record<string, { description?: string }>;
    };
    external.collections.default = { description: "externally changed" };
    await env.fs.writeFile(configPath, `${JSON.stringify(external, null, 2)}\n`);

    const response = await post("/api/v1/mutations/apply", { mutationPlan: planned.plan });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: "error",
      error: {
        code: "TARGET_CONFLICT",
        details: {
          coreCode: "TARGET_PRECONDITION_CONFLICT",
          planId: "untrusted",
          actionId: "untrusted",
          target: "untrusted",
          expected: { state: "present" },
          actual: { state: "present" },
        },
      },
    });
  });

  it("serializes concurrent clients through Core lock and revision checks", async () => {
    const left = await planCollection("left");
    const right = await planCollection("right");

    const responses = await Promise.all([
      post("/api/v1/mutations/apply", { mutationPlan: left.plan }),
      post("/api/v1/mutations/apply", { mutationPlan: right.plan }),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    const successes = bodies.filter((body) => (body as { status?: unknown }).status === "success");
    const rejectedCodes = bodies.flatMap((body) => {
      const code = (body as ErrorEnvelope).error?.code;
      return code ? [code] : [];
    });

    expect(successes).toHaveLength(1);
    expect(rejectedCodes).toHaveLength(1);
    expect(["LOCK_CONFLICT", "STALE_REVISION"]).toContain(rejectedCodes[0]);
  });

  it("returns LOCK_CONFLICT while another process owns the Store lock", async () => {
    const planned = await planCollection("busy");
    await env.fs.writeFile(
      mutationLockPath(storeRoot),
      `${JSON.stringify({
        operationId: "operation-other",
        processId: 4242,
        hostname: "other-host",
        acquiredAt: env.now().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    const response = await post("/api/v1/mutations/apply", { mutationPlan: planned.plan });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: "error",
      error: {
        code: "LOCK_CONFLICT",
        details: {
          coreCode: "LOCK_CONFLICT",
          owner: {
            operationId: "operation-other",
            processId: 4242,
            hostname: "other-host",
            acquiredAt: env.now().toISOString(),
          },
        },
      },
    });
  });

  it("returns RECOVERY_REQUIRED when a durable interrupted operation exists", async () => {
    const interrupted = await planCollection("interrupted");
    const timestamp = env.now().toISOString();
    await publishOperationJournal(env, storeRoot, {
      schemaVersion: 1,
      operationId: "operation-interrupted",
      plan: createDurableMutationPlan(env, storeRoot, interrupted.plan),
      nextRevision: interrupted.plan.baseRevision + 1,
      status: "executing",
      startedAt: timestamp,
      updatedAt: timestamp,
      actions: interrupted.plan.actions.map(({ actionId, target }) => ({
        actionId,
        target,
        status: "pending" as const,
      })),
    });
    const next = await planCollection("blocked-by-recovery");

    const response = await post("/api/v1/mutations/apply", { mutationPlan: next.plan });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: "error",
      error: {
        code: "RECOVERY_REQUIRED",
        details: {
          coreCode: "INTERRUPTED_OPERATION",
          operationId: "operation-interrupted",
          journalStatus: "executing",
        },
      },
    });
  });

  it("rejects an unauthorized mutation before JSON parsing or filesystem observation", async () => {
    let filesystemEffects = 0;
    const protectedEnv: Env = {
      ...env,
      fs: new Proxy(env.fs, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          return (..._args: unknown[]) => {
            filesystemEffects += 1;
            throw new Error(`unexpected filesystem effect: ${String(property)}`);
          };
        },
      }),
    };
    const protectedApp = createApp({
      env: protectedEnv,
      storeRoot,
      auth: { mode: "bearer", token: "managed-token" },
    });

    const response = await protectedApp.request("/api/v1/mutations/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    expect(response.status).toBe(401);
    expect(filesystemEffects).toBe(0);
  });

  it("rejects an oversized mutation request before parsing or Core observation", async () => {
    let filesystemEffects = 0;
    const protectedEnv: Env = {
      ...env,
      fs: new Proxy(env.fs, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          return (..._args: unknown[]) => {
            filesystemEffects += 1;
            throw new Error(`unexpected filesystem effect: ${String(property)}`);
          };
        },
      }),
    };
    const protectedApp = createApp({
      env: protectedEnv,
      storeRoot,
      auth: { mode: "trusted-embedded" },
    });

    const response = await protectedApp.request("/api/v1/mutations/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      status: "error",
      error: { code: "DOMAIN_VALIDATION_FAILED" },
    });
    expect(filesystemEffects).toBe(0);
  });

  it("round-trips a Core scan plan through versioned HTTP without apply-time rescanning", async () => {
    await env.fs.mkdir(join(root, "home", ".claude"), { recursive: true });
    await env.fs.writeFile(join(root, "home", ".claude", "CLAUDE.md"), "# HTTP rules\n");

    const plannedResponse = await post("/api/v1/scan/plan", {
      agent: "claude-code",
      scope: "global",
      capabilities: ["rules"],
    });
    expect(plannedResponse.status).toBe(200);
    const planned = (await plannedResponse.json()) as SuccessEnvelope<{
      readonly plan: unknown;
      readonly mutationPlan: MutationPlan;
    }>;
    const appliedResponse = await post("/api/v1/scan/apply", {
      mutationPlan: JSON.parse(JSON.stringify(planned.data.mutationPlan)),
    });
    expect(appliedResponse.status).toBe(200);
    const applied = (await appliedResponse.json()) as SuccessEnvelope<{
      readonly operation: { readonly ok: boolean };
    }>;

    expect(applied.data.operation.ok).toBe(true);
  });

  async function planCollection(name: string): Promise<{ readonly plan: MutationPlan }> {
    const response = await post("/api/v1/collections/plan", {
      action: "create",
      collectionName: name,
      description: name,
      resourceIds: [],
    });
    const body = (await response.json()) as SuccessEnvelope<{ readonly plan: MutationPlan }>;
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body.data;
  }

  async function post(path: string, body: unknown): Promise<Response> {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function collectionNames(): Promise<string[]> {
    const response = await app.request("/api/v1/collections");
    const body = (await response.json()) as SuccessEnvelope<{
      readonly collections: readonly { readonly name: string }[];
    }>;
    return body.data.collections.map(({ name }) => name).filter((name) => name !== "default");
  }
});
