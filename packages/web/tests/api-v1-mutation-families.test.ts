import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMutationPlan,
  createRealEnv,
  type Env,
  type MutationPlan,
  planApplyMutation,
} from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initStore, writeRuleArtifact } from "../../core/src/store/store.js";
import { createApp } from "../src/app.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

interface SuccessEnvelope<T> {
  readonly status: "success";
  readonly data: T;
}

interface ErrorEnvelope {
  readonly status: "error";
  readonly error: { readonly code: string; readonly details?: { readonly coreCode?: string } };
}

describe("versioned mutation families", () => {
  let root: string;
  let storeRoot: string;
  let workspaceRoot: string;
  let env: Env;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-api-v1-families-")));
    storeRoot = join(root, "home", ".cellarer");
    workspaceRoot = join(root, "workspace");
    const real = createRealEnv();
    env = {
      ...real,
      homedir: () => join(root, "home"),
      cwd: () => workspaceRoot,
      now: () => new Date("2026-08-10T10:00:00.000Z"),
      mutationAuthority: deterministicMutationAuthority(),
    };
    await fs.mkdir(workspaceRoot, { recursive: true });
    await initStore(env, storeRoot);
    await writeRuleArtifact(env, storeRoot, "style", "# Style\n");
    app = createApp({ env, storeRoot, auth: { mode: "trusted-embedded" } });
  });

  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it("round-trips an exact revert plan", async () => {
    const distribution = await planApplyMutation(env, {
      storeRoot,
      scope: "project",
      dir: workspaceRoot,
      agents: ["codex"],
      resourceIds: ["rules/style"],
      capabilities: ["rules"],
      method: "copy",
      mcpStrategy: "merge",
      secretMode: "env",
    });
    const distributed = await applyMutationPlan(env, distribution.mutationPlan, { storeRoot });
    expect(distributed.operation.ok).toBe(true);

    const reverted = await postData<{ readonly mutationPlan: MutationPlan }>(
      "/api/v1/revert/plan",
      { scope: "project", dir: workspaceRoot, agents: ["codex"] },
    );
    const revertApplied = await postData<{
      readonly operation: { readonly ok: boolean; readonly receipt?: { readonly planId: string } };
    }>("/api/v1/revert/apply", {
      scope: "project",
      dir: workspaceRoot,
      agents: ["codex"],
      mutationPlan: reverted.mutationPlan,
    });
    expect(revertApplied.operation).toMatchObject({
      ok: true,
      receipt: { planId: reverted.mutationPlan.planId },
    });
  });

  it("round-trips resource rename, export, remove, and bundle-import plans", async () => {
    const renamed = await postData<{ readonly plan: MutationPlan }>(
      "/api/v1/resources/rename/plan",
      { resourceId: "rules/style", newName: "style-renamed", mode: "rename" },
    );
    const renameApplied = await postData<{
      readonly operation: { readonly ok: boolean; readonly receipt?: { readonly planId: string } };
    }>("/api/v1/resources/rename/apply", {
      resourceId: "rules/style",
      newName: "style-renamed",
      mode: "rename",
      mutationPlan: renamed.plan,
    });
    expect(renameApplied.operation).toMatchObject({
      ok: true,
      receipt: { planId: renamed.plan.planId },
    });

    const bundlePath = join(root, "style.cellarer-resource.json");
    const exported = await postData<{ readonly plan: MutationPlan }>(
      "/api/v1/resources/export/plan",
      { resourceId: "rules/style", bundlePath },
    );
    await expectExactApply("/api/v1/resources/export/apply", exported.plan, {
      resourceId: "rules/style",
      bundlePath,
    });

    const removed = await postData<{ readonly plan: MutationPlan }>(
      "/api/v1/resources/remove/plan",
      { resourceId: "rules/style", cascade: false },
    );
    await expectExactApply("/api/v1/resources/remove/apply", removed.plan, {
      resourceId: "rules/style",
      cascade: false,
    });

    const imported = await postData<{ readonly plan: MutationPlan }>(
      "/api/v1/resources/bundle-import/plan",
      { bundlePath },
    );
    await expectExactApply("/api/v1/resources/bundle-import/apply", imported.plan, {
      bundlePath,
    });
  }, 15_000);

  it("round-trips exact sync-profile apply and uninstall plans", async () => {
    const desired = {
      agentIds: ["codex"],
      scope: "project",
      resourceIds: ["rules/style"],
      collectionIds: [],
      capabilities: ["rules"],
      method: "copy",
      mergePolicy: "merge",
    };
    const profile = await postData<{ readonly plan: MutationPlan }>("/api/v1/profiles/plan", {
      action: "create",
      profileId: "daily",
      desired,
    });
    await expectExactApply("/api/v1/profiles/apply", profile.plan);

    const sync = await postData<{ readonly mutationPlan: MutationPlan }>(
      "/api/v1/profiles/daily/sync/plan",
      { workspaceRoot },
    );
    await expectExactApply("/api/v1/profiles/daily/sync/apply", sync.mutationPlan, {
      workspaceRoot,
    });
    const verified = await postData<{ readonly healthy: boolean }>(
      "/api/v1/profiles/daily/verify",
      { workspaceRoot },
    );
    expect(verified.healthy).toBe(true);

    const uninstall = await postData<{
      readonly mutationPlan: MutationPlan;
      readonly targetKeys: readonly string[];
    }>("/api/v1/profiles/daily/uninstall/plan", { workspaceRoot });
    await expectExactApply("/api/v1/profiles/daily/uninstall/apply", uninstall.mutationPlan, {
      workspaceRoot,
      targetKeys: uninstall.targetKeys,
    });
  }, 15_000);

  it("exposes typed recovery diagnosis and recovery results", async () => {
    const diagnosedResponse = await app.request("/api/v1/recovery");
    const diagnosed = (await diagnosedResponse.json()) as SuccessEnvelope<{
      readonly status: string;
    }>;
    expect(diagnosedResponse.status, JSON.stringify(diagnosed)).toBe(200);
    expect(diagnosed.data.status).toBe("clean");

    const recoveredResponse = await post("/api/v1/recovery/apply", {
      operationId: "operation-missing",
    });
    const recovered = (await recoveredResponse.json()) as ErrorEnvelope;
    expect(recoveredResponse.status, JSON.stringify(recovered)).toBe(409);
    expect(recovered).toMatchObject({
      status: "error",
      error: { code: "RECOVERY_REQUIRED", details: { coreCode: "MANUAL_RECOVERY_REQUIRED" } },
    });
  });

  async function expectExactApply(
    path: string,
    mutationPlan: MutationPlan,
    body: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const applied = await postData<{
      readonly operation: { readonly ok: boolean; readonly receipt?: { readonly planId: string } };
    }>(path, { ...body, mutationPlan: JSON.parse(JSON.stringify(mutationPlan)) });
    expect(applied.operation).toMatchObject({
      ok: true,
      receipt: { planId: mutationPlan.planId },
    });
  }

  async function postData<T>(path: string, body: unknown): Promise<T> {
    const response = await post(path, body);
    const payload = (await response.json()) as SuccessEnvelope<T> | ErrorEnvelope;
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.status).toBe("success");
    return (payload as SuccessEnvelope<T>).data;
  }

  function post(path: string, body: unknown): Promise<Response> {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
});
