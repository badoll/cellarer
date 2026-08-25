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

  it("returns complete, partial, and failed post-commit Inventory without changing mutation success", async () => {
    const canary = "ghp_web_post_commit_secret_1234567890";
    env.env = { WEB_POST_COMMIT_TOKEN: canary };
    app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });

    await env.fs.mkdir(join(root, "home", ".complete-web"), { recursive: true });
    await env.fs.writeFile(
      join(root, "home", ".complete-web", "RULES.md"),
      `Use $${"{WEB_POST_COMMIT_TOKEN}"} by reference only.\n`,
    );
    const complete = await upsertCustomAdapter("complete-web", {
      rules: { global: "~/.complete-web/RULES.md" },
    });
    expect(complete).toMatchObject({
      status: "success",
      data: {
        operation: { ok: true, receipt: { outcome: "committed" } },
        postCommitInventoryRefresh: {
          agentId: "complete-web",
          status: "complete",
          inventory: { completeness: "complete" },
        },
      },
    });

    const externalSkill = join(root, "external-web-skill");
    await env.fs.mkdir(join(root, "home", ".partial-web", "skills"), { recursive: true });
    await env.fs.mkdir(externalSkill, { recursive: true });
    await env.fs.writeFile(join(root, "home", ".partial-web", "RULES.md"), "# Safe\n");
    await env.fs.writeFile(join(externalSkill, "SKILL.md"), "# External\n");
    await env.fs.symlink(
      externalSkill,
      join(root, "home", ".partial-web", "skills", "linked"),
      "dir",
    );
    const partial = await upsertCustomAdapter("partial-web", {
      rules: { global: "~/.partial-web/RULES.md" },
      skills: { global: "~/.partial-web/skills" },
    });
    expect(partial).toMatchObject({
      status: "success",
      data: {
        operation: { ok: true, receipt: { outcome: "committed" } },
        postCommitInventoryRefresh: {
          agentId: "partial-web",
          status: "partial",
          retryCommand: "cellarer inventory refresh --agent partial-web",
          inventory: { completeness: "partial", findings: [{ code: "UNSAFE_LINK" }] },
        },
      },
    });

    const externalRules = join(root, "external-web-rules.md");
    await env.fs.mkdir(join(root, "home", ".failed-web"), { recursive: true });
    await env.fs.writeFile(externalRules, "# External\n");
    await env.fs.symlink(externalRules, join(root, "home", ".failed-web", "RULES.md"), "file");
    const failed = await upsertCustomAdapter("failed-web", {
      rules: { global: "~/.failed-web/RULES.md" },
    });
    expect(failed).toMatchObject({
      status: "success",
      data: {
        operation: { ok: true, receipt: { outcome: "committed" } },
        postCommitInventoryRefresh: {
          agentId: "failed-web",
          status: "failed",
          retryCommand: "cellarer inventory refresh --agent failed-web",
          inventory: { completeness: "failed", candidates: [] },
        },
      },
    });

    expect(JSON.stringify([complete, partial, failed])).not.toContain(canary);
  }, 30_000);

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
          replanRequired: true,
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

  it("keeps first-run Inventory review, decline, exact import, and stale remediation separate", async () => {
    const firstSource = join(root, "home", ".codex", "skills", "first-run", "SKILL.md");
    const staleSource = join(root, "home", ".codex", "skills", "stale-run", "SKILL.md");
    await env.fs.mkdir(join(firstSource, ".."), { recursive: true });
    await env.fs.mkdir(join(staleSource, ".."), { recursive: true });
    await env.fs.writeFile(
      firstSource,
      "---\nname: first-run\ndescription: first-run Inventory fixture\n---\n",
    );
    await env.fs.writeFile(
      staleSource,
      "---\nname: stale-run\ndescription: stale Inventory fixture\n---\n",
    );

    const reviewedResponse = await app.request("/api/v1/inventory/codex");
    const reviewed = (await reviewedResponse.json()) as SuccessEnvelope<{
      readonly completeness: string;
      readonly candidates: readonly {
        readonly id: string;
        readonly name: string;
        readonly state: string;
        readonly defaultSelected: boolean;
      }[];
    }>;
    expect(reviewedResponse.status).toBe(200);
    expect(reviewed.data).toMatchObject({
      completeness: "complete",
      candidates: expect.arrayContaining([
        expect.objectContaining({ name: "first-run", state: "ready", defaultSelected: true }),
        expect.objectContaining({ name: "stale-run", state: "ready", defaultSelected: true }),
      ]),
    });

    // Decline is represented by making no mutation request after review.
    await expect(
      env.fs.lstat(join(storeRoot, "store", "skills", "first-run", "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const firstCandidate = reviewed.data.candidates.find(({ name }) => name === "first-run");
    const staleCandidate = reviewed.data.candidates.find(({ name }) => name === "stale-run");
    if (!firstCandidate || !staleCandidate) throw new Error("missing first-run candidates");

    const firstPlanResponse = await post("/api/v1/inventory/import/plan", {
      candidateIds: [firstCandidate.id],
      agentId: "codex",
    });
    const firstPlan = (await firstPlanResponse.json()) as SuccessEnvelope<{
      readonly candidateIds: readonly string[];
      readonly mutationPlan: MutationPlan;
    }>;
    expect(firstPlanResponse.status).toBe(200);
    expect(firstPlan.data).toMatchObject({
      candidateIds: [firstCandidate.id],
      mutationPlan: { operation: "store-import" },
    });
    const firstApply = await post("/api/v1/inventory/import/apply", {
      mutationPlan: firstPlan.data.mutationPlan,
    });
    expect(firstApply.status).toBe(200);
    expect(await firstApply.json()).toMatchObject({
      status: "success",
      data: {
        candidateIds: [firstCandidate.id],
        resourceIds: ["skills/first-run"],
        operation: { ok: true, receipt: { outcome: "committed" } },
      },
    });

    const stalePlanResponse = await post("/api/v1/inventory/import/plan", {
      candidateIds: [staleCandidate.id],
      agentId: "codex",
    });
    const stalePlan = (await stalePlanResponse.json()) as SuccessEnvelope<{
      readonly mutationPlan: MutationPlan;
    }>;
    expect(stalePlanResponse.status).toBe(200);
    await env.fs.writeFile(
      staleSource,
      "---\nname: stale-run\ndescription: drifted after confirmation\n---\n",
    );
    const staleApply = await post("/api/v1/inventory/import/apply", {
      mutationPlan: stalePlan.data.mutationPlan,
    });
    expect(staleApply.status).toBe(409);
    expect(await staleApply.json()).toMatchObject({
      status: "error",
      error: {
        code: "TARGET_CONFLICT",
        details: { coreCode: "TARGET_PRECONDITION_CONFLICT", replanRequired: true },
      },
    });
    await expect(
      env.fs.lstat(join(storeRoot, "store", "skills", "stale-run", "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves safe first-run candidates when Inventory refresh is partial", async () => {
    const safeSource = join(root, "home", ".codex", "skills", "safe-run", "SKILL.md");
    const externalRules = join(root, "external-rules.md");
    await env.fs.mkdir(join(safeSource, ".."), { recursive: true });
    await env.fs.writeFile(
      safeSource,
      "---\nname: safe-run\ndescription: safe partial fixture\n---\n",
    );
    await env.fs.writeFile(externalRules, "# External rules\n");
    await env.fs.mkdir(join(root, "home", ".codex"), { recursive: true });
    await env.fs.symlink(externalRules, join(root, "home", ".codex", "AGENTS.md"), "file");

    const response = await app.request("/api/v1/inventory/codex");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "success",
      data: {
        completeness: "partial",
        candidates: [expect.objectContaining({ name: "safe-run", state: "ready" })],
        findings: [
          expect.objectContaining({ code: "UNSAFE_LINK", remediation: "remove-unsafe-link" }),
        ],
      },
    });
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

  async function upsertCustomAdapter(
    agentId: string,
    adapter: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const planned = await post("/api/v1/agents/plan", {
      action: "upsert-adapter",
      agentId,
      kind: "custom",
      adapter,
    });
    expect(planned.status, await planned.clone().text()).toBe(200);
    const body = (await planned.json()) as SuccessEnvelope<{ readonly plan: MutationPlan }>;
    const applied = await post("/api/v1/mutations/apply", { mutationPlan: body.data.plan });
    expect(applied.status, await applied.clone().text()).toBe(200);
    return (await applied.json()) as Record<string, unknown>;
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
