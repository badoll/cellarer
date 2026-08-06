import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRealEnv, type Env } from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initStore, writeRuleArtifact } from "../../core/src/store/store.js";
import { createApp } from "../src/app.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

describe("web resource lifecycle and sync-profile DTOs", () => {
  let root: string;
  let storeRoot: string;
  let workspaceRoot: string;
  let env: Env;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-web-lifecycle-")));
    storeRoot = join(root, "home", ".cellarer");
    workspaceRoot = join(root, "workspace");
    const real = createRealEnv();
    env = {
      ...real,
      homedir: () => join(root, "home"),
      cwd: () => workspaceRoot,
      now: () => new Date("2026-08-06T00:00:00.000Z"),
      mutationAuthority: deterministicMutationAuthority(),
    };
    await fs.mkdir(workspaceRoot, { recursive: true });
    await initStore(env, storeRoot);
    await writeRuleArtifact(env, storeRoot, "style", "# Style\n");
    app = createApp({ env, storeRoot });
  });

  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it("returns Core lifecycle DTOs without route-local lifecycle logic", async () => {
    expect(
      await json("/api/resource-lifecycle/check", { resourceId: "rules/style" }),
    ).toMatchObject({
      status: "uncheckable",
      resourceId: "rules/style",
      reason: "no-verifiable-remote-source",
    });
    expect(
      await json("/api/resource-lifecycle/dependencies", { resourceId: "rules/style" }),
    ).toMatchObject({
      schemaVersion: 1,
      resourceId: "rules/style",
      collections: [],
      profiles: [],
      ownedTargets: [],
    });
    expect(
      await json("/api/resource-lifecycle/rename", {
        resourceId: "rules/style",
        newName: "style-renamed",
        mode: "rename",
        dryRun: true,
      }),
    ).toMatchObject({ plan: { operation: "resource-lifecycle" }, blocked: [] });
    expect(
      await json("/api/resource-lifecycle/remove", {
        resourceId: "rules/style",
        cascade: false,
        dryRun: true,
      }),
    ).toMatchObject({ plan: { operation: "resource-lifecycle" }, blocked: [] });

    const untrusted = await json("/api/resource-lifecycle/update/apply", {
      mutationPlan: {
        authorization: {
          schemaVersion: 1,
          domain: "executable-plan-v1",
          algorithm: "HMAC-SHA-256",
          authorityId: "forged",
          authorityEpoch: 1,
          seal: `hmac-sha256:${"a".repeat(64)}`,
        },
      },
    });
    expect(untrusted).toMatchObject({
      plan: { authorization: "[REDACTED]" },
      operation: { ok: false, conflict: { code: "INVALID_PLAN" } },
    });
  });

  it("rejects stale update planning before Store, transport, target, or clock effects", async () => {
    const productEffects: string[] = [];
    let transportCalls = 0;
    let clockReads = 0;
    const originalFs = env.fs;
    env.fs = new Proxy(originalFs, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (..._args: unknown[]) => {
          productEffects.push(String(property));
          throw new Error(`unexpected product effect: ${String(property)}`);
        };
      },
    });
    env.resourceSourceTransport = {
      check: async () => {
        transportCalls += 1;
        throw new Error("unexpected transport check");
      },
      fetch: async () => {
        transportCalls += 1;
        throw new Error("unexpected transport fetch");
      },
    };
    env.now = () => {
      clockReads += 1;
      throw new Error("unexpected clock read");
    };
    env.mutationAuthority = deterministicMutationAuthority({ isCurrent: async () => false });
    app = createApp({ env, storeRoot });

    const response = await app.request("/api/resource-lifecycle/update/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceId: "rules/style" }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/mutation authority/i);
    expect(productEffects).toEqual([]);
    expect(transportCalls).toBe(0);
    expect(clockReads).toBe(0);
  });

  it("exposes profile CRUD and exact sync plan/apply/verify/uninstall DTOs", async () => {
    const desired = {
      agentIds: ["codex"],
      scope: "project",
      resourceIds: ["rules/style"],
      collectionIds: [],
      capabilities: ["rules"],
      method: "copy",
      mergePolicy: "merge",
    };
    expect(await json("/api/profiles", { profileId: "daily", desired })).toMatchObject({
      profile: { profileId: "daily", desired },
      operation: { ok: true },
    });
    expect(await getJson("/api/profiles")).toMatchObject({
      profiles: [{ profileId: "daily" }],
    });
    expect(await getJson("/api/profiles/daily")).toMatchObject({
      profile: { profileId: "daily" },
    });

    const planned = await json("/api/sync/profiles/daily/plan", { workspaceRoot });
    expect(planned, JSON.stringify(planned)).toMatchObject({
      mutationPlan: { authorization: { seal: expect.stringMatching(/^hmac-sha256:/) } },
    });
    expect(planned).toMatchObject({
      profile: { profileId: "daily" },
      workspaceRoot,
      resolvedResources: [{ resourceId: "rules/style" }],
    });
    const applied = await json("/api/sync/profiles/daily/apply", {
      workspaceRoot,
      mutationPlan: planned.mutationPlan,
    });
    expect(applied, JSON.stringify(applied)).toMatchObject({
      profileId: "daily",
      operation: { ok: true },
    });
    expect(await json("/api/sync/profiles/daily/verify", { workspaceRoot })).toMatchObject({
      profileId: "daily",
      healthy: true,
    });
    expect(
      await json("/api/sync/profiles/daily/uninstall", { workspaceRoot, dryRun: true }),
    ).toMatchObject({ profile: { profileId: "daily" }, targets: [{ blocked: false }] });
    expect(await json("/api/sync/profiles/daily/uninstall", { workspaceRoot })).toMatchObject({
      operation: { ok: true },
      uninstalled: [{ syncProfile: { profileId: "daily" } }],
    });

    expect(await deleteJson("/api/profiles/daily?dryRun=true")).toMatchObject({
      profile: null,
      plan: { operation: "settings" },
    });
    expect(await getJson("/api/profiles/daily")).toMatchObject({
      profile: { profileId: "daily" },
    });
  }, 20_000);

  it("keeps profile replacement snapshot passphrases request-lifetime only", async () => {
    const desired = {
      agentIds: ["codex"],
      scope: "project" as const,
      resourceIds: ["rules/style"],
      collectionIds: [],
      capabilities: ["rules" as const],
      method: "copy" as const,
      mergePolicy: "merge" as const,
    };
    await json("/api/profiles", { profileId: "replace", desired });
    const initial = await json("/api/sync/profiles/replace/plan", { workspaceRoot });
    const target = (
      initial.plan as { actions: readonly { target: string; capability?: string }[] }
    ).actions.find((action) => action.capability === "rules")?.target;
    if (!target) throw new Error("expected planned rule target");
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, "user-owned\n", "utf8");

    const blocked = await json("/api/sync/profiles/replace/plan", { workspaceRoot });
    const replacement = (
      blocked.plan as {
        conflicts: readonly { acknowledgement?: { token?: string } }[];
      }
    ).conflicts[0]?.acknowledgement?.token;
    if (!replacement) throw new Error("expected replacement acknowledgement");

    const snapshotPassphrase = "profile-web-snapshot-passphrase";
    const acknowledged = await json("/api/sync/profiles/replace/plan", {
      workspaceRoot,
      replaceUnowned: [replacement],
      snapshotPassphrase,
    });
    expect(acknowledged).toMatchObject({ plan: { conflicts: [] } });
    expect(JSON.stringify(acknowledged)).not.toContain(snapshotPassphrase);

    const applied = await json("/api/sync/profiles/replace/apply", {
      workspaceRoot,
      replaceUnowned: [replacement],
      snapshotPassphrase,
      mutationPlan: acknowledged.mutationPlan,
    });
    expect(applied).toMatchObject({ operation: { ok: true } });
    expect(JSON.stringify(applied)).not.toContain(snapshotPassphrase);
    expect(await fs.readFile(target, "utf8")).toContain("# Style");
    expect(await readTreeText(storeRoot)).not.toContain(snapshotPassphrase);
    expect(await readTreeText(workspaceRoot)).not.toContain(snapshotPassphrase);
  }, 20_000);

  async function json(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }

  async function getJson(path: string): Promise<Record<string, unknown>> {
    const response = await app.request(path);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }

  async function deleteJson(path: string): Promise<Record<string, unknown>> {
    const response = await app.request(path, { method: "DELETE" });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }
});

async function readTreeText(path: string): Promise<string> {
  const entries = await fs.readdir(path, { withFileTypes: true });
  const values: string[] = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) values.push(await readTreeText(child));
    else if (entry.isFile()) values.push((await fs.readFile(child)).toString("utf8"));
  }
  return values.join("\n");
}
