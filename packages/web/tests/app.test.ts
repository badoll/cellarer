import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRealEnv,
  type Env,
  listOperationReceipts,
  loadConfig,
  readOperationJournal,
  readStoreRevision,
} from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthorizedMutationPlan } from "../../core/src/protocol/canonical.js";
import { executeMutationPlan } from "../../core/src/protocol/execute.js";
import { sha256 } from "../../core/src/store/checksum.js";
import { createApp, redactWebPayload } from "../src/app.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

// web 测试基座:临时库房 + 真实 Env(注入 homedir/cwd 指向临时目录)。
interface Ctx {
  app: ReturnType<typeof createApp>;
  env: Env;
  storeRoot: string;
  root: string;
  cleanup: () => Promise<void>;
}

function makeCtx(envVars: Record<string, string | undefined> = {}): Ctx {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-web-")));
  const home = join(root, "home");
  const real = createRealEnv();
  const env: Env = {
    fs: real.fs,
    homedir: () => home,
    cwd: () => join(root, "cwd"),
    platform: "darwin",
    processId: real.processId,
    hostname: real.hostname,
    randomId: real.randomId,
    now: () => new Date("2026-06-30T08:00:00.000Z"),
    env: envVars,
    mutationAuthority: deterministicMutationAuthority(),
  };
  const storeRoot = join(home, ".cellarer");
  const app = createApp({ env, storeRoot });
  return {
    app,
    env,
    storeRoot,
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

async function seedStore(c: Ctx): Promise<void> {
  for (const sub of ["rules", "mcp", "skills"]) {
    await c.env.fs.mkdir(join(c.storeRoot, "store", sub), { recursive: true });
  }
}

function namesWithState(body: unknown, state: string): string[] {
  const resources = (body as { resources: { name: string; state: string }[] }).resources;
  return resources.filter((resource) => resource.state === state).map((resource) => resource.name);
}

function managedNames(body: unknown): string[] {
  return namesWithState(body, "managed");
}

function discoveredNames(body: unknown): string[] {
  return namesWithState(body, "discovered");
}

describe("web app — resources/agents", () => {
  let c: Ctx;
  beforeEach(async () => {
    c = makeCtx();
    await seedStore(c);
  });
  afterEach(() => c.cleanup());

  it("lists resource catalog with collections", async () => {
    await c.env.fs.writeFile(join(c.storeRoot, "store", "rules", "style.md"), "# rules");
    const res = await c.app.request("/api/resources/rules");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resources).toContainEqual(
      expect.objectContaining({
        id: "rules/style",
        kind: "rules",
        name: "style",
        membership: { collections: [] },
        state: "managed",
      }),
    );
  });

  it("preserves safe reference names in a real resource DTO response", async () => {
    await c.env.fs.writeFile(
      join(c.storeRoot, "store", "mcp", "context.json"),
      '{"command":"context","env":{"TOKEN":"${CTX_TOKEN}"}}\n',
    );
    await c.env.fs.writeFile(
      join(c.storeRoot, "state.json"),
      `${JSON.stringify({
        version: 2,
        owners: [
          {
            agent: "claude-code",
            scope: "global",
            capability: "mcp",
            target: join(c.root, "home", ".claude", "mcp.json"),
            artifactIds: ["mcp/context"],
            receipt: {
              method: "write",
              fingerprint: `sha256:${"a".repeat(64)}`,
              backup: null,
              generated: false,
              appliedAt: "2026-06-30T08:00:00.000Z",
            },
            secretRefs: ["CTX_TOKEN"],
          },
        ],
      })}\n`,
    );

    const response = await c.app.request("/api/resources/mcp?includeDiscovered=false");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resources: [
        expect.objectContaining({
          id: "mcp/context",
          secretReferenceNames: ["CTX_TOKEN"],
        }),
      ],
    });
  });

  it("includes discovered agent-native resources in resource routes", async () => {
    await c.env.fs.mkdir(join(c.root, "home", ".codex", "skills", "study"), {
      recursive: true,
    });

    const res = await c.app.request("/api/resources/skills?agents=codex");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.counts).toMatchObject({ managed: 0, discovered: 1 });
    expect(body.resources).toContainEqual(
      expect.objectContaining({
        kind: "skills",
        name: "study",
        state: "discovered",
        discovered: expect.objectContaining({
          agent: "codex",
          source: join(c.root, "home", ".codex", "skills", "study"),
        }),
      }),
    );
  });

  it("lists configured default agents with capabilities", async () => {
    const res = await c.app.request("/api/agents");
    const body = await res.json();
    expect(body.agents.map((a: { id: string }) => a.id)).toContain("claude-code");
  });

  it("includes global detect results for each registered agent", async () => {
    await c.env.fs.mkdir(join(c.root, "home", ".codex"), { recursive: true });

    const res = await c.app.request("/api/agents");
    const body = await res.json();
    const agents = body.agents as {
      id: string;
      detected: boolean;
      detectionEvidence: { root?: string };
    }[];

    expect(agents.find((a) => a.id === "codex")).toMatchObject({
      detected: true,
      detectionEvidence: { root: join(c.root, "home", ".codex") },
    });
    expect(agents.find((a) => a.id === "claude-code")).toMatchObject({
      detected: false,
      detectionEvidence: { root: join(c.root, "home", ".claude") },
    });
  });
});

describe("web app — dashboard M3 routes", () => {
  let c: Ctx;
  const REAL = "ghp_0123456789abcdefghijklmnopqrstuvwx";

  beforeEach(async () => {
    c = makeCtx({ M3_SECRET: REAL });
    await seedStore(c);
  });
  afterEach(() => c.cleanup());

  it("serves summary and activity from core-owned contracts", async () => {
    await c.env.fs.mkdir(join(c.root, "home", ".codex"), { recursive: true });
    await c.env.fs.writeFile(join(c.storeRoot, "store", "rules", "style.md"), "# style");

    const summary = await c.app.request("/api/summary?agents=codex&capabilities=rules&limit=3");
    expect(summary.status).toBe(200);
    const body = await summary.json();
    expect(body.artifactCounts).toMatchObject({ rules: 1, total: 1 });
    expect(body.agentCounts.detected).toBe(1);
    expect(body.distributionCoverage[0]).toMatchObject({
      collection: "default",
      scope: "global",
      desiredCount: 1,
      percentage: 0,
    });

    const activity = await c.app.request("/api/activity");
    expect(activity.status).toBe(200);
    expect(await activity.json()).toMatchObject({ events: [], warnings: [] });
  });

  it("serves discovery summary by destination", async () => {
    await c.env.fs.mkdir(join(c.root, "home", ".codex"), { recursive: true });
    await c.env.fs.writeFile(join(c.root, "home", ".codex", "AGENTS.md"), "# rules");

    const res = await c.app.request("/api/discovery?agents=codex&destination=user");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      destination: "user",
      totals: { rules: 1, mcp: 0, skills: 0 },
    });
  });

  it("records mutating operations as activity but not previews or dry-runs", async () => {
    await c.env.fs.mkdir(join(c.root, "home", ".claude"), { recursive: true });
    await c.env.fs.writeFile(join(c.root, "home", ".claude", "CLAUDE.md"), "# Team rules");

    await c.app.request("/api/import/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude-code",
        destination: "user",
        capabilities: ["rules"],
      }),
    });
    expect((await (await c.app.request("/api/activity")).json()).events).toHaveLength(0);

    await c.app.request("/api/import/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude-code",
        destination: "user",
        capabilities: ["rules"],
      }),
    });
    await c.app.request("/api/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        destination: "user",
        resources: { kinds: ["rules"] },
      }),
    });
    await c.app.request("/api/revert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], dryRun: true }),
    });
    await c.app.request("/api/revert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], dryRun: false }),
    });

    const activity = await (await c.app.request("/api/activity")).json();
    expect(activity.events.map((event: { action: string }) => event.action)).toEqual([
      "revert",
      "apply",
      "scan-import",
    ]);
  });

  it("serves ownership-blocked and missing drift diffs without plaintext secrets", async () => {
    await c.env.fs.writeFile(join(c.storeRoot, "store", "rules", "style.md"), "# style");
    await c.app.request("/api/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        destination: "user",
        resources: { kinds: ["rules"] },
      }),
    });
    const [item] = (await (await c.app.request("/api/status")).json()).items;
    await c.env.fs.writeFile(item.target, `token=${REAL}`);

    const diff = await c.app.request("/api/diff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: item }),
    });
    const text = await diff.text();
    expect(diff.status).toBe(200);
    expect(text).not.toContain(REAL);
    expect(JSON.parse(text)).toMatchObject({
      available: false,
      warning: "target content is hidden while ownership is blocked",
      currentFingerprint: expect.stringMatching(/^sha256:/),
    });

    await c.env.fs.rm(item.target, { force: true });
    const missing = await c.app.request("/api/diff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: item }),
    });
    expect(await missing.json()).toMatchObject({
      available: false,
      warning: "target is missing",
    });
  });

  it("never returns ownership-blocked target content for ordinary or nested secret fields", async () => {
    await c.env.fs.writeFile(join(c.storeRoot, "store", "rules", "style.md"), "# style");
    await c.app.request("/api/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        destination: "user",
        resources: { kinds: ["rules"] },
      }),
    });
    const [item] = (await (await c.app.request("/api/status")).json()).items;
    const sensitiveTargets = [
      JSON.stringify({ password: "hunter2" }),
      JSON.stringify({ token: "ordinary-token-value" }),
      JSON.stringify({ service: { credentials: { password: "nested-password" } } }),
    ];

    for (const sensitive of sensitiveTargets) {
      await c.env.fs.writeFile(item.target, sensitive);
      const response = await c.app.request("/api/diff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity: item }),
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).not.toContain(sensitive);
      const body = JSON.parse(text);
      expect(body).toMatchObject({
        available: false,
        warning: "target content is hidden while ownership is blocked",
        currentFingerprint: expect.stringMatching(/^sha256:/),
      });
      expect(body.before).toBeUndefined();
    }
  });

  it("does not serialize an ownership-blocked MCP merge containing existing secrets", async () => {
    await c.env.fs.writeFile(
      join(c.storeRoot, "store", "mcp", "managed.json"),
      JSON.stringify({ kind: "stdio", command: "managed" }),
    );
    const target = join(c.root, "home", ".claude", "mcp.json");
    await c.env.fs.mkdir(join(c.root, "home", ".claude"), { recursive: true });
    await c.env.fs.writeFile(
      target,
      JSON.stringify({
        password: "ordinary-password",
        mcpServers: {
          existing: {
            command: "existing",
            metadata: { credentials: { token: "nested-ordinary-token" } },
          },
        },
      }),
    );

    const response = await c.app.request("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        scope: "global",
        capabilities: ["mcp"],
      }),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain("ordinary-password");
    expect(text).not.toContain("nested-ordinary-token");
    expect(JSON.parse(text).actions[0]).toMatchObject({
      op: "skip",
      ownership: { classification: "unowned-existing" },
    });
    expect(JSON.parse(text).actions[0].preview).toBeUndefined();
  });

  it("keeps duplicate ledger owners blocked through plan, apply, and revert APIs", async () => {
    await c.env.fs.writeFile(join(c.storeRoot, "store", "rules", "style.md"), "# style");
    await c.app.request("/api/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        scope: "global",
        capabilities: ["rules"],
      }),
    });
    const statePath = join(c.storeRoot, "state.json");
    const ledger = JSON.parse(await c.env.fs.readFile(statePath));
    const owner = ledger.owners[0];
    ledger.owners.push({ ...owner, artifactIds: ["rules/duplicate"] });
    const duplicateState = JSON.stringify(ledger);
    await c.env.fs.writeFile(statePath, duplicateState);
    const target = join(c.root, "home", ".claude", "CLAUDE.md");
    const targetBefore = await c.env.fs.readFile(target);

    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        scope: "global",
        capabilities: ["rules"],
      }),
    };
    const response = await c.app.request("/api/plan", request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.actions[0]).toMatchObject({
      op: "skip",
      ownership: { classification: "invalid-owner" },
    });
    expect(body.conflicts[0]).toMatchObject({ code: "INVALID_TARGET_OWNER" });

    const applyResponse = await c.app.request("/api/apply", request);
    const applyBody = await applyResponse.json();
    expect(applyResponse.status).toBe(200);
    expect(applyBody.entries).toEqual([]);
    expect(applyBody.plan.conflicts[0]).toMatchObject({ code: "INVALID_TARGET_OWNER" });

    const revertResponse = await c.app.request("/api/revert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], scope: "global" }),
    });
    const revertBody = await revertResponse.json();
    expect(revertResponse.status).toBe(200);
    expect(revertBody.reverted).toEqual([]);
    expect(revertBody.plan.conflicts[0]).toMatchObject({ code: "INVALID_TARGET_OWNER" });
    expect(await c.env.fs.readFile(target)).toBe(targetBefore);
    expect(await c.env.fs.readFile(statePath)).toBe(duplicateState);
  });

  it("blocks apply on an unselected duplicate and selectively reverts a valid owner", async () => {
    await c.env.fs.writeFile(join(c.storeRoot, "store", "rules", "style.md"), "# style");
    await c.env.fs.mkdir(join(c.storeRoot, "store", "skills", "demo"), { recursive: true });
    await c.env.fs.writeFile(
      join(c.storeRoot, "store", "skills", "demo", "SKILL.md"),
      "# managed skill",
    );
    const request = (path: string, body: unknown) =>
      c.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await request("/api/apply", {
      agents: ["claude-code"],
      scope: "global",
      capabilities: ["rules"],
    });
    await request("/api/apply", {
      agents: ["codex"],
      scope: "global",
      capabilities: ["skills"],
    });
    const statePath = join(c.storeRoot, "state.json");
    const ledger = JSON.parse(await c.env.fs.readFile(statePath));
    const ruleOwner = ledger.owners.find(
      (owner: { capability: string }) => owner.capability === "rules",
    );
    const skillOwner = ledger.owners.find(
      (owner: { capability: string }) => owner.capability === "skills",
    );
    if (!ruleOwner || !skillOwner) throw new Error("expected Rules and Skill owners");
    const duplicateRule = { ...ruleOwner, artifactIds: ["rules/duplicate"] };
    const duplicateState = JSON.stringify({
      ...ledger,
      owners: [ruleOwner, duplicateRule, skillOwner],
    });
    await c.env.fs.writeFile(statePath, duplicateState);

    const applyResponse = await request("/api/apply", {
      agents: ["codex"],
      scope: "global",
      capabilities: ["skills"],
    });
    const applyBody = await applyResponse.json();
    expect(applyBody.entries).toEqual([]);
    expect(applyBody.plan.invalidLedger).toBe(true);
    expect(applyBody.plan.actions[0]).toMatchObject({
      capability: "skills",
      ownership: { classification: "owned-current" },
    });
    expect(applyBody.plan.conflicts).toContainEqual(
      expect.objectContaining({ code: "INVALID_TARGET_OWNER", target: ruleOwner.target }),
    );
    expect(await c.env.fs.readFile(statePath)).toBe(duplicateState);

    const dryRunResponse = await request("/api/revert", {
      agents: ["codex"],
      scope: "global",
      dryRun: true,
    });
    const dryRun = await dryRunResponse.json();
    expect(dryRun.reverted).toEqual([skillOwner]);
    expect(await c.env.fs.readFile(statePath)).toBe(duplicateState);

    const revertResponse = await request("/api/revert", {
      agents: ["codex"],
      scope: "global",
    });
    const reverted = await revertResponse.json();
    expect(reverted.reverted).toEqual([skillOwner]);
    expect(JSON.parse(await c.env.fs.readFile(statePath)).owners).toEqual([
      ruleOwner,
      duplicateRule,
    ]);
  });

  it("rejects project-scope summary, activity, and diff without a dir", async () => {
    const summary = await c.app.request("/api/summary?scope=project");
    const activity = await c.app.request("/api/activity?scope=project");
    const diff = await c.app.request("/api/diff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identity: {
          artifact: "rules/*",
          agent: "codex",
          scope: "project",
          capability: "rules",
          target: join(c.root, "project", "AGENTS.md"),
        },
      }),
    });

    expect(summary.status).toBe(400);
    expect(activity.status).toBe(400);
    expect(diff.status).toBe(400);
  });
});

describe("web app — secret safety (red line)", () => {
  let c: Ctx;
  const REAL = "ghp_0123456789abcdefghijklmnopqrstuvwx";
  const CELLARER_SECRET_REF = "${" + "CELLARER_SECRET:C7_KEY}";
  const ENV_SECRET_REF = "${" + "C7_KEY}";
  beforeEach(async () => {
    // 即便环境变量里有真值,web 也只写 ${ENV} 引用,响应里不得出现真值。
    c = makeCtx({ C7_KEY: REAL });
    await seedStore(c);
  });
  afterEach(() => c.cleanup());

  it("preserves a supported environment reference without returning its value", async () => {
    await c.env.fs.writeFile(
      join(c.storeRoot, "store", "mcp", "ctx.json"),
      JSON.stringify({ command: "npx", env: { API_KEY: ENV_SECRET_REF } }),
    );
    const res = await c.app.request("/api/sync/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        destination: "user",
        resources: { kinds: ["mcp"] },
      }),
    });
    const text = await res.text();
    expect(text).not.toContain(REAL);
    expect(text).toContain(ENV_SECRET_REF);
  });

  it("redacts a low-entropy active value at the real Web plan boundary", async () => {
    await c.cleanup();
    c = makeCtx({ C7_KEY: "tiny" });
    await seedStore(c);
    const projectDir = join(c.root, "project-tiny");
    await c.env.fs.mkdir(projectDir, { recursive: true });
    await c.env.fs.writeFile(
      join(c.storeRoot, "store", "mcp", "ctx.json"),
      JSON.stringify({ command: "npx", env: { API_KEY: ENV_SECRET_REF } }),
    );

    const res = await c.app.request("/api/sync/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        destination: "project",
        dir: projectDir,
        resources: { kinds: ["mcp"] },
      }),
    });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).not.toContain("tiny");
    expect(text).toContain("[REDACTED]");
    expect(text).toContain(ENV_SECRET_REF);
  });

  it("secrets endpoint lists only reference names, never values", async () => {
    // 先 apply 一个带 secretRef 的 mcp,使台账记录引用名。
    await c.env.fs.writeFile(
      join(c.storeRoot, "store", "mcp", "ctx.json"),
      JSON.stringify({ command: "npx", env: { API_KEY: ENV_SECRET_REF } }),
    );
    const applied = await c.app.request("/api/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        destination: "user",
        resources: { kinds: ["mcp"] },
      }),
    });
    expect(applied.status).toBe(200);
    expect(await applied.text()).not.toContain(REAL);
    const res = await c.app.request("/api/secrets");
    const body = await res.json();
    expect(body.names).toContain("C7_KEY");
    expect(body.refs).toContainEqual({ name: "C7_KEY", ledgerEntryCount: 1 });
    expect(JSON.stringify(body)).not.toContain(REAL);
    const activity = await c.app.request("/api/activity");
    expect(await activity.text()).not.toContain(REAL);
  });

  it("returns a non-disclosing blocked response for an incompatible reference", async () => {
    await c.env.fs.writeFile(
      join(c.storeRoot, "store", "mcp", "ctx.json"),
      JSON.stringify({ command: "npx", env: { API_KEY: CELLARER_SECRET_REF } }),
    );

    const res = await c.app.request("/api/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        destination: "user",
        resources: { kinds: ["mcp"] },
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(REAL);
    expect(text).toContain("incompatible with reference-only secrets");
    expect(text).toContain(CELLARER_SECRET_REF);
    expect(await c.env.fs.readFile(join(c.storeRoot, "store", "mcp", "ctx.json"))).not.toContain(
      REAL,
    );
  });
});

describe("web app — scan import", () => {
  let c: Ctx;
  const REAL = "ghp_0123456789abcdefghijklmnopqrstuvwx";

  beforeEach(async () => {
    c = makeCtx({ WEB_SCAN_KEY: REAL });
    await seedStore(c);
  });
  afterEach(() => c.cleanup());

  it("plans and applies current-kind imports through product routes with default user destination", async () => {
    await c.env.fs.mkdir(join(c.root, "home", ".claude"), { recursive: true });
    await c.env.fs.writeFile(join(c.root, "home", ".claude", "CLAUDE.md"), "# Team rules");
    await c.env.fs.writeFile(
      join(c.root, "home", ".claude", "mcp.json"),
      JSON.stringify({ mcpServers: { ctx: { command: "npx" } } }),
    );

    const preview = await c.app.request("/api/import/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude-code",
        capabilities: ["rules"],
      }),
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      agent: "claude-code",
      scope: "global",
      items: [expect.objectContaining({ kind: "rules", name: "claude-code" })],
    });

    const applied = await c.app.request("/api/import/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude-code",
        capabilities: ["rules"],
      }),
    });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ operation: { ok: true } });
    await expect(readStoreRevision(c.env, c.storeRoot)).resolves.toBe(1);

    const rules = await (await c.app.request("/api/resources/rules")).json();
    const mcp = await (await c.app.request("/api/resources/mcp")).json();
    expect(managedNames(rules)).toContain("claude-code");
    expect(managedNames(mcp)).not.toContain("ctx");
    expect(discoveredNames(mcp)).toContain("ctx");
  });

  it("11.1 forces Web scan/import to environment mode without credential access", async () => {
    let credentialCalls = 0;
    c.env.secretStore = {
      async get() {
        credentialCalls += 1;
        return { found: false };
      },
      async set() {
        credentialCalls += 1;
      },
      async delete() {
        credentialCalls += 1;
        return false;
      },
    };
    c.app = createApp({ env: c.env, storeRoot: c.storeRoot });
    await c.env.fs.writeFile(
      join(c.storeRoot, "config.json"),
      `${JSON.stringify(
        {
          version: 1,
          defaults: { method: "symlink", collections: ["default"], secretMode: "keychain" },
          collections: { default: { description: "Default" } },
          artifacts: {},
          adapterOverrides: {},
          customAdapters: {},
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await c.env.fs.mkdir(join(c.root, "home", ".claude"), { recursive: true });
    await c.env.fs.writeFile(join(c.root, "home", ".claude", "CLAUDE.md"), "# Team rules");

    for (const route of ["/api/import/plan", "/api/import/apply", "/api/scan", "/api/scan/apply"]) {
      const response = await c.app.request(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "claude-code", capabilities: ["rules"] }),
      });
      expect(response.status, `${route}: ${await response.clone().text()}`).toBe(200);
    }
    expect(credentialCalls).toBe(0);
  });

  it("11.1 allows authorityless Web scan planning but still rejects executable import", async () => {
    delete c.env.mutationAuthority;
    c.app = createApp({ env: c.env, storeRoot: c.storeRoot });
    await c.env.fs.mkdir(join(c.root, "home", ".claude"), { recursive: true });
    await c.env.fs.writeFile(join(c.root, "home", ".claude", "CLAUDE.md"), "# Team rules");

    const preview = await c.app.request("/api/import/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "claude-code", capabilities: ["rules"] }),
    });
    expect(preview.status, await preview.clone().text()).toBe(200);

    const applied = await c.app.request("/api/import/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "claude-code", capabilities: ["rules"] }),
    });
    expect(applied.status).toBe(400);
    expect(await applied.text()).toContain("mutation authority is unavailable");
  });

  it("imports scan candidates and refreshes the artifact inventory", async () => {
    await c.env.fs.mkdir(join(c.root, "home", ".claude"), { recursive: true });
    await c.env.fs.writeFile(join(c.root, "home", ".claude", "CLAUDE.md"), "# Team rules");

    const res = await c.app.request("/api/import/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude-code",
        destination: "user",
        capabilities: ["rules"],
        intoCollection: "default",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toContainEqual(
      expect.objectContaining({ kind: "rules", name: "claude-code", action: "import" }),
    );

    const artifacts = await (await c.app.request("/api/resources/rules")).json();
    expect(artifacts.resources).toContainEqual(
      expect.objectContaining({
        name: "claude-code",
        membership: { collections: ["default"] },
      }),
    );
    const config = JSON.parse(await c.env.fs.readFile(join(c.storeRoot, "config.json"), "utf8"));
    expect(config.artifacts["rules/claude-code"]).toMatchObject({
      collections: ["default"],
    });
  });

  it("imports only selected scan rows when different kinds share a name", async () => {
    await c.env.fs.mkdir(join(c.root, "home", ".claude"), { recursive: true });
    await c.env.fs.writeFile(join(c.root, "home", ".claude", "CLAUDE.md"), "# Team rules");
    await c.env.fs.writeFile(
      join(c.root, "home", ".claude", "mcp.json"),
      JSON.stringify({ mcpServers: { "claude-code": { command: "npx" } } }),
    );

    const res = await c.app.request("/api/import/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude-code",
        destination: "user",
        capabilities: ["rules", "mcp"],
        selectItems: [
          {
            kind: "rules",
            name: "claude-code",
            source: join(c.root, "home", ".claude", "CLAUDE.md"),
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toEqual([
      expect.objectContaining({ kind: "rules", name: "claude-code" }),
    ]);

    const rules = await (await c.app.request("/api/resources/rules")).json();
    const mcp = await (await c.app.request("/api/resources/mcp")).json();
    expect(managedNames(rules)).toContain("claude-code");
    expect(managedNames(mcp)).not.toContain("claude-code");
    expect(discoveredNames(mcp)).toContain("claude-code");
  });

  it("rejects legacy name-only select on every scan/import plan and apply route without effects", async () => {
    await c.env.fs.mkdir(join(c.root, "home", ".claude"), { recursive: true });
    await c.env.fs.writeFile(join(c.root, "home", ".claude", "CLAUDE.md"), "# Team rules");

    for (const route of ["/api/import/plan", "/api/import/apply", "/api/scan", "/api/scan/apply"]) {
      const response = await c.app.request(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "claude-code",
          capabilities: ["rules"],
          select: ["claude-code"],
        }),
      });
      expect(response.status, route).toBe(400);
      const body = await response.json();
      expect(body).toMatchObject({ error: expect.stringContaining("select") });
      expect(body).not.toHaveProperty("items");
      expect(body).not.toHaveProperty("plan");
      expect(body).not.toHaveProperty("mutation");
    }

    for (const route of ["/api/import/plan", "/api/import/apply", "/api/scan", "/api/scan/apply"]) {
      const response = await c.app.request(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: "claude-code",
          capabilities: ["rules"],
          selectItems: [{ kind: "rules", name: "claude-code" }],
        }),
      });
      expect(response.status, route).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("selectItems"),
      });
    }

    await expect(readStoreRevision(c.env, c.storeRoot)).resolves.toBe(0);
    await expect(c.env.fs.lstat(join(c.storeRoot, "config.json"))).rejects.toThrow();
    await expect(c.env.fs.lstat(join(c.storeRoot, "operations"))).rejects.toThrow();
    await expect(
      c.env.fs.lstat(join(c.storeRoot, "store", "rules", "claude-code.md")),
    ).rejects.toThrow();
  });

  it("does not expose plaintext secrets while importing scanned MCP config", async () => {
    await c.env.fs.mkdir(join(c.root, "home", ".claude"), { recursive: true });
    await c.env.fs.writeFile(
      join(c.root, "home", ".claude", "mcp.json"),
      JSON.stringify({ mcpServers: { ctx: { command: "npx", env: { API_KEY: REAL } } } }),
    );

    const res = await c.app.request("/api/import/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude-code",
        destination: "user",
        capabilities: ["mcp"],
      }),
    });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).not.toContain(REAL);
    expect(text).toContain("MCP_CTX_API_KEY");
    await expect(c.env.fs.lstat(join(c.storeRoot, "store", "mcp", "ctx.json"))).rejects.toThrow();
  });
});

describe("web app — diagnostics and revert", () => {
  let c: Ctx;

  beforeEach(async () => {
    c = makeCtx();
    await seedStore(c);
  });
  afterEach(() => c.cleanup());

  it("inspects agents for project scope", async () => {
    const project = join(c.root, "project");
    await c.env.fs.mkdir(project, { recursive: true });

    const res = await c.app.request("/api/agents/inspect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "project", dir: project, agents: ["codex"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ scope: "project", dir: project });
    expect(body.agents[0]).toMatchObject({
      id: "codex",
      scope: "project",
      detected: true,
      paths: {
        rules: join(project, "AGENTS.md"),
        mcp: join(project, ".codex", "config.toml"),
        skillsDir: join(project, ".agents", "skills"),
      },
    });
  });

  it("runs doctor without exposing stack traces", async () => {
    const res = await c.app.request("/api/doctor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", agents: ["codex"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checks.map((check: { id: string }) => check.id)).toContain("store-root");
    expect(body.mutationRecovery).toEqual({ status: "clean" });
    expect(JSON.stringify(body)).not.toContain("Error:");
  });

  it("surfaces typed manual recovery evidence for an unprovable store import", async () => {
    const target = join(c.storeRoot, "store", "rules", "interrupted.md");
    const content = "interrupted fixture";
    const actionId = sha256(JSON.stringify({ kind: "rules", name: "interrupted", target }));
    const mutationPlan = createAuthorizedMutationPlan(c.env, c.storeRoot, {
      schemaVersion: 1,
      planId: "plan-web-interrupted",
      operation: "store-import",
      baseRevision: 0,
      normalizedInputs: { mutationKind: "add" },
      targetPreconditions: [{ actionId, target, expected: { state: "absent" } }],
      actions: [
        {
          actionId,
          kind: "add-rules",
          target,
          payload: { contentDigest: sha256(content) },
          postcondition: { state: "present", fingerprint: sha256(content) },
        },
      ],
      expires: { policy: "none" },
    });
    await expect(
      executeMutationPlan(c.env, c.storeRoot, mutationPlan, async () => {
        throw new Error("web interruption fixture");
      }),
    ).rejects.toThrow("web interruption fixture");

    const res = await c.app.request("/api/doctor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", agents: ["codex"] }),
    });
    const body = await res.json();

    expect(body.mutationRecovery).toMatchObject({
      status: "manual-recovery-required",
      planId: "plan-web-interrupted",
      baseRevision: 0,
      error: { code: "MANUAL_RECOVERY_REQUIRED" },
    });
    expect(JSON.stringify(body.mutationRecovery)).not.toContain("statePublications");
  });

  it("exposes desired-versus-applied separately from applied-versus-disk verification", async () => {
    await c.env.fs.writeFile(join(c.storeRoot, "store", "rules", "style.md"), "# style");
    await c.app.request("/api/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        scope: "global",
        capabilities: ["rules"],
      }),
    });
    await c.env.fs.writeFile(join(c.storeRoot, "store", "rules", "style.md"), "# updated");

    const res = await c.app.request("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        scope: "global",
        capabilities: ["rules"],
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.desiredVsApplied).toMatchObject({
      status: "diverged",
      items: [
        {
          status: "content-mismatch",
          comparisons: { selection: "matched", content: "mismatched", method: "matched" },
        },
      ],
    });
    expect(body.appliedVsDisk).toMatchObject({ status: "converged" });
    expect(body.recovery).toEqual({ status: "clean" });
    expect(JSON.stringify(body)).not.toContain("# updated");
  });

  it("requires a dry-run preview before the UI can safely call revert", async () => {
    await c.env.fs.writeFile(join(c.storeRoot, "store", "rules", "style.md"), "# style");
    const applied = await c.app.request("/api/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        destination: "user",
        resources: { kinds: ["rules"] },
      }),
    });
    const appliedBody = await applied.json();
    expect(appliedBody.mutation).toMatchObject({
      planId: expect.stringMatching(/^plan-/),
      operation: "apply",
      baseRevision: 0,
      result: {
        ok: true,
        receipt: { baseRevision: 0, resultingRevision: 1, outcome: "committed" },
      },
    });
    expect(JSON.stringify(appliedBody.mutation)).not.toContain("statePublications");

    const preview = await c.app.request("/api/revert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], dryRun: true }),
    });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody.reverted).toHaveLength(1);
    expect(previewBody.plan.targets[0]).toMatchObject({
      ownership: { classification: "owned-current" },
      proposedAction: "remove-target",
      blocked: false,
    });
    expect(previewBody.plan.conflicts).toEqual([]);
    expect(previewBody.mutation).toMatchObject({
      planId: expect.stringMatching(/^plan-/),
      operation: "revert",
      baseRevision: 1,
    });
    expect((await (await c.app.request("/api/status")).json()).items).toHaveLength(1);

    const apply = await c.app.request("/api/revert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], dryRun: false }),
    });
    expect(apply.status).toBe(200);
    const revertedBody = await apply.json();
    expect(revertedBody.reverted).toHaveLength(1);
    expect(revertedBody.mutation).toMatchObject({
      operation: "revert",
      baseRevision: 1,
      result: {
        ok: true,
        receipt: { baseRevision: 1, resultingRevision: 2, outcome: "committed" },
      },
    });
    expect((await (await c.app.request("/api/status")).json()).items).toHaveLength(0);
  });

  it("passes the exact drift acknowledgement from a revert plan back to Core", async () => {
    await c.env.fs.writeFile(join(c.storeRoot, "store", "rules", "style.md"), "# style");
    await c.app.request("/api/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        destination: "user",
        resources: { kinds: ["rules"] },
      }),
    });
    const target = join(c.root, "home", ".claude", "CLAUDE.md");
    await c.env.fs.writeFile(target, "user edit");

    const preview = await c.app.request("/api/revert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], dryRun: true }),
    });
    const previewBody = await preview.json();
    expect(previewBody.plan.conflicts[0]?.code).toBe("REVERT_TARGET_DRIFTED");
    const token = previewBody.plan.targets[0]?.acknowledgement?.token;
    expect(token).toMatch(/^sha256:/);

    const applied = await c.app.request("/api/revert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], acknowledgements: [token] }),
    });
    const appliedBody = await applied.json();
    expect(appliedBody.reverted).toHaveLength(1);
    expect(appliedBody.plan.targets[0]?.driftOverridden).toBe(true);
    await expect(c.env.fs.lstat(target)).rejects.toThrow();
  });
});

describe("web app — access token", () => {
  // 带 token 的临时 app;用后 cleanup。try/finally 保证断言失败也不泄漏 tmpdir。
  function makeTokenApp(token: string) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-web-tok-")));
    const real = createRealEnv();
    const env: Env = {
      fs: real.fs,
      homedir: () => join(root, "home"),
      cwd: () => root,
      platform: "darwin",
      processId: real.processId,
      hostname: real.hostname,
      randomId: real.randomId,
      now: () => new Date(),
      env: {},
    };
    const app = createApp({ env, storeRoot: join(root, "home", ".cellarer"), token });
    return { app, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
  }

  it("rejects /api without the configured bearer token", async () => {
    const { app, cleanup } = makeTokenApp("s3cret");
    try {
      const unauth = await app.request("/api/summary");
      expect(unauth.status).toBe(401);
      const ok = await app.request("/api/summary", {
        headers: { Authorization: "Bearer s3cret" },
      });
      expect(ok.status).toBe(200);
    } finally {
      await cleanup();
    }
  });

  it("rejects a bearer token of the wrong length without throwing (timing-safe)", async () => {
    const { app, cleanup } = makeTokenApp("s3cret");
    try {
      // 长度不等的 token:safeEqual 应先判长度返回 false,不得让 timingSafeEqual 抛 RangeError。
      const res = await app.request("/api/agents", { headers: { Authorization: "Bearer short" } });
      expect(res.status).toBe(401);
    } finally {
      await cleanup();
    }
  });
});

describe("web app — DNS-rebinding Host allowlist", () => {
  let c: Ctx;
  beforeEach(async () => {
    c = makeCtx();
    await seedStore(c);
  });
  afterEach(() => c.cleanup());

  it("forbids a non-loopback Host header", async () => {
    const res = await c.app.request("/api/agents", {
      headers: { host: "evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("allows a loopback Host header (with port)", async () => {
    const res = await c.app.request("/api/agents", {
      headers: { host: "127.0.0.1:4317" },
    });
    expect(res.status).toBe(200);
  });
});

describe("web app — input validation", () => {
  let c: Ctx;
  beforeEach(async () => {
    c = makeCtx();
    await seedStore(c);
  });
  afterEach(() => c.cleanup());

  it("16.1 redacts nested container scalars at the Web JSON boundary", () => {
    expect(
      redactWebPayload({
        AccessToken: ["web-plaintext", 17, false, null, { nested: "web-object-plaintext" }],
      }),
    ).toEqual({
      AccessToken: [
        "[REDACTED]",
        "[REDACTED]",
        "[REDACTED]",
        "[REDACTED]",
        { nested: "[REDACTED]" },
      ],
    });
  });

  it("redacts secret-like values from Web error responses", async () => {
    const canary = "ghp_0123456789abcdefghijklmnopqrstuvwx";
    const res = await c.app.request(`/api/resources/rules?destination=${canary}`);

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(canary);
    expect(text).toContain("[REDACTED]");
  });

  it("rejects project-scope apply without a dir (would write into server cwd)", async () => {
    const res = await c.app.request("/api/sync/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        destination: "project",
        resources: { kinds: ["rules"] },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("project");
  });

  it("rejects project-scope scan without a dir (would read server cwd)", async () => {
    const res = await c.app.request("/api/import/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "claude-code", destination: "project" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("project");
  });

  it("rejects project-scope inspect, doctor, and revert without a dir", async () => {
    for (const path of ["/api/agents/inspect", "/api/doctor", "/api/revert"]) {
      const res = await c.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "project" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("project");
    }
  });

  it("returns 400 (not 500) on a malformed JSON body", async () => {
    const res = await c.app.request("/api/sync/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("previews and applies sync through product routes", async () => {
    await c.env.fs.writeFile(join(c.storeRoot, "store", "rules", "style.md"), "# style");
    const preview = await c.app.request("/api/sync/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        destination: "user",
        resources: { kinds: ["rules"] },
      }),
    });
    expect(preview.status).toBe(200);
    expect((await preview.json()).actions.length).toBeGreaterThan(0);

    const applied = await c.app.request("/api/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        destination: "user",
        resources: { kinds: ["rules"] },
      }),
    });
    expect(applied.status).toBe(200);
  });

  it("rejects project destination without dir", async () => {
    const res = await c.app.request("/api/sync/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["codex"],
        destination: "project",
        resources: { kinds: ["rules"] },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid destination values before reading or writing resources", async () => {
    const resources = await c.app.request("/api/resources?destination=projct");
    const discovery = await c.app.request("/api/discovery?destination=projct");
    const sync = await c.app.request("/api/sync/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agents: ["claude-code"],
        destination: "projct",
        resources: { kinds: ["rules"] },
      }),
    });
    const scanImport = await c.app.request("/api/import/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude-code",
        destination: "projct",
        capabilities: ["rules"],
      }),
    });

    for (const res of [resources, discovery, sync, scanImport]) {
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("destination");
    }
  });

  it("rejects invalid conflict strategies before scan import", async () => {
    const importPlan = await c.app.request("/api/import/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude-code",
        destination: "user",
        conflict: "keep-ours",
      }),
    });
    const legacyScan = await c.app.request("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude-code",
        conflict: "keep-ours",
      }),
    });

    for (const res of [importPlan, legacyScan]) {
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("conflict");
    }
  });

  it("applies explicit planned settings, collection, and agent mutations", async () => {
    const collection = await c.app.request("/api/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        collectionName: "work",
        description: "Work",
        resourceIds: [],
      }),
    });
    expect(collection.status).toBe(200);
    expect(await collection.json()).toMatchObject({ receipt: { outcome: "committed" } });

    const settingsMutation = await c.app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { method: "copy" } }),
    });
    expect(settingsMutation.status).toBe(200);
    expect(await settingsMutation.json()).toMatchObject({
      plan: { operation: "settings" },
      changedFields: ["defaults.method"],
      receipt: { outcome: "committed" },
    });

    const agent = await c.app.request("/api/agents/codex/enabled", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(agent.status).toBe(200);

    const adapterConfig = await c.app.request("/api/agents/local-review/adapter", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "custom",
        adapter: { rules: { global: "~/.local-review/RULES.md" } },
      }),
    });
    expect(adapterConfig.status).toBe(200);

    const disabledCustomAdapter = await c.app.request("/api/agents/local-review/enabled", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabledCustomAdapter.status).toBe(200);

    const deletedAdapter = await c.app.request("/api/agents/local-review/adapter", {
      method: "DELETE",
    });
    expect(deletedAdapter.status).toBe(200);
    await expect(readStoreRevision(c.env, c.storeRoot)).resolves.toBe(6);

    const settings = await (await c.app.request("/api/settings")).json();
    expect(settings.collections.map((c: { name: string }) => c.name)).toContain("work");

    const agents = await (await c.app.request("/api/agents")).json();
    expect(agents.agents.find((a: { id: string }) => a.id === "codex")).toMatchObject({
      enabled: false,
    });
  }, 20_000);

  it("returns plans for every explicit settings and collection dry-run and receipts on apply", async () => {
    await c.env.fs.writeFile(join(c.storeRoot, "store", "rules", "style.md"), "# style");
    const jsonRequest = async (path: string, method: string, body?: unknown) => {
      const response = await c.app.request(path, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json();
    };
    const expectDryRun = (body: Record<string, unknown>) => {
      expect(body).toMatchObject({ plan: { operation: "settings" } });
      expect(body.receipt).toBeUndefined();
    };
    const expectApplied = (body: Record<string, unknown>) => {
      expect(body).toMatchObject({
        plan: { operation: "settings" },
        receipt: { outcome: "committed" },
      });
    };

    expectDryRun(
      await jsonRequest("/api/settings", "PUT", {
        settings: { method: "copy" },
        dryRun: true,
      }),
    );
    expectApplied(await jsonRequest("/api/settings", "PUT", { settings: { method: "copy" } }));
    expectApplied(
      await jsonRequest("/api/collections", "POST", {
        collectionName: "work",
        description: "Work",
        resourceIds: [],
      }),
    );

    expectDryRun(
      await jsonRequest("/api/collections/work", "PUT", {
        description: "Updated",
        dryRun: true,
      }),
    );
    expectApplied(await jsonRequest("/api/collections/work", "PUT", { description: "Updated" }));
    expectDryRun(
      await jsonRequest("/api/collections/work/members", "PUT", {
        resourceIds: ["rules/style"],
        dryRun: true,
      }),
    );
    expectApplied(
      await jsonRequest("/api/collections/work/members", "PUT", {
        resourceIds: ["rules/style"],
      }),
    );
    expectDryRun(
      await jsonRequest("/api/collections/defaults", "PUT", {
        collectionNames: ["work"],
        dryRun: true,
      }),
    );
    expectApplied(
      await jsonRequest("/api/collections/defaults", "PUT", {
        collectionNames: ["work"],
      }),
    );
    expectApplied(
      await jsonRequest("/api/collections/defaults", "PUT", {
        collectionNames: ["default"],
      }),
    );

    expectDryRun(await jsonRequest("/api/collections/work?dryRun=true", "DELETE"));
    expect((await loadConfig(c.env, c.storeRoot)).collections.work).toBeDefined();
    expectApplied(await jsonRequest("/api/collections/work", "DELETE"));
    expect(await loadConfig(c.env, c.storeRoot)).toMatchObject({
      artifacts: { "rules/style": { collections: [] } },
    });
  }, 20_000);

  it("rejects obsolete bulk settings routes without changing control-plane state", async () => {
    const beforeStore = await c.env.fs.snapshotTreeNoFollow(c.storeRoot);
    const beforeRevision = await readStoreRevision(c.env, c.storeRoot);
    const beforeReceipts = await listOperationReceipts(c.env, c.storeRoot);

    const responses = await Promise.all([
      c.app.request("/api/settings/collections", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          collections: {
            default: { description: "Default" },
            unsafeBulkReplacement: { description: "Must not be accepted" },
          },
        }),
      }),
      c.app.request("/api/settings/defaults", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaults: { method: "copy" } }),
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404]);
    await expect(c.env.fs.snapshotTreeNoFollow(c.storeRoot)).resolves.toEqual(beforeStore);
    await expect(readStoreRevision(c.env, c.storeRoot)).resolves.toBe(beforeRevision);
    await expect(listOperationReceipts(c.env, c.storeRoot)).resolves.toEqual(beforeReceipts);
  });

  it.each([
    ["missing enabled", {}],
    ["non-boolean enabled", { enabled: "false" }],
    ["null enabled", { enabled: null }],
    ["unknown field", { enabled: false, unknown: true }],
    ["non-boolean dryRun", { enabled: false, dryRun: "false" }],
  ])("rejects an enabled body with %s as HTTP 400 before Env", async (_label, body) => {
    let envTouches = 0;
    const fsProxy = new Proxy(c.env.fs, {
      get(target, key, receiver) {
        envTouches += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const app = createApp({ env: { ...c.env, fs: fsProxy }, storeRoot: c.storeRoot });

    const response = await app.request("/api/agents/codex/enabled", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "DOMAIN_VALIDATION_FAILED" });
    expect(envTouches).toBe(0);
  });

  it("applies exact false and true enabled semantics", async () => {
    for (const enabled of [false, true]) {
      const response = await c.app.request("/api/agents/codex/enabled", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        plan: {
          normalizedInputs: {
            mutationKind: enabled ? "builtin-agent-enable" : "builtin-agent-disable",
          },
        },
      });
      expect((await loadConfig(c.env, c.storeRoot)).adapterOverrides.codex?.enabled).toBe(enabled);
    }
  });

  it("requires explicit adapter kind before Web mutation effects", async () => {
    let envTouches = 0;
    const fsProxy = new Proxy(c.env.fs, {
      get(target, key, receiver) {
        envTouches += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const app = createApp({ env: { ...c.env, fs: fsProxy }, storeRoot: c.storeRoot });
    const response = await app.request("/api/agents/web-agent/adapter", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adapter: { rules: { global: "~/.web-agent/RULES.md" } } }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "DOMAIN_VALIDATION_FAILED" });
    expect(envTouches).toBe(0);
  });

  it.each([
    [
      "accessor",
      () => {
        let traps = 0;
        const body = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(body, "enabled", {
          enumerable: true,
          get() {
            traps += 1;
            return false;
          },
        });
        return { body, traps: () => traps };
      },
    ],
    [
      "Proxy",
      () => {
        let traps = 0;
        const body = new Proxy(
          { enabled: false },
          {
            ownKeys(target) {
              traps += 1;
              return Reflect.ownKeys(target);
            },
          },
        );
        return { body, traps: () => traps };
      },
    ],
    [
      "toJSON",
      () => ({ body: { enabled: false, toJSON: () => ({ enabled: true }) }, traps: () => 0 }),
    ],
    [
      "custom prototype",
      () => ({
        body: Object.assign(Object.create({ inherited: true }), { enabled: false }),
        traps: () => 0,
      }),
    ],
    [
      "symbol key",
      () => ({ body: { enabled: false, [Symbol("unexpected")]: true }, traps: () => 0 }),
    ],
  ])("rejects a hostile enabled %s as HTTP 400 with trap0 and Env0", async (_label, create) => {
    const hostile = create();
    let envTouches = 0;
    const fsProxy = new Proxy(c.env.fs, {
      get(target, key, receiver) {
        envTouches += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const app = createApp({ env: { ...c.env, fs: fsProxy }, storeRoot: c.storeRoot });
    const parse = vi.spyOn(JSON, "parse").mockImplementationOnce(() => hostile.body as never);
    try {
      const response = await app.request("/api/agents/codex/enabled", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "DOMAIN_VALIDATION_FAILED" });
    } finally {
      parse.mockRestore();
    }
    expect(hostile.traps()).toBe(0);
    expect(envTouches).toBe(0);
  });

  it("rejects unknown planned settings and collection fields without changing state", async () => {
    const configPath = join(c.storeRoot, "config.json");
    const beforeConfig = await c.env.fs.readFile(configPath).catch(() => null);
    const beforeRevision = await readStoreRevision(c.env, c.storeRoot);
    const beforeJournal = await readOperationJournal(c.env, c.storeRoot);
    const beforeReceipts = await listOperationReceipts(c.env, c.storeRoot);
    const beforeStore = await c.env.fs.snapshotTreeNoFollow(c.storeRoot);

    const requests = [
      ["PUT", "/api/settings", { settings: { method: "copy", unexpectedOption: true } }],
      [
        "POST",
        "/api/collections",
        {
          collectionName: "unsafe",
          description: "Unsafe",
          resourceIds: [],
          unexpectedOption: true,
        },
      ],
    ] as const;

    for (const [method, path, body] of requests) {
      const response = await c.app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "DOMAIN_VALIDATION_FAILED" });
      if (beforeConfig === null) await expect(c.env.fs.lstat(configPath)).rejects.toThrow();
      else await expect(c.env.fs.readFile(configPath)).resolves.toBe(beforeConfig);
      await expect(readStoreRevision(c.env, c.storeRoot)).resolves.toBe(beforeRevision);
      await expect(readOperationJournal(c.env, c.storeRoot)).resolves.toEqual(beforeJournal);
      await expect(listOperationReceipts(c.env, c.storeRoot)).resolves.toEqual(beforeReceipts);
      await expect(c.env.fs.snapshotTreeNoFollow(c.storeRoot)).resolves.toEqual(beforeStore);
      await expect(loadConfig(c.env, c.storeRoot)).resolves.toBeDefined();
    }
  });

  it("uses planned adapter mutations and preserves a built-in enabled override", async () => {
    const disabled = await c.app.request("/api/agents/codex/enabled", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);

    const configured = await c.app.request("/api/agents/codex/adapter", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "builtin", adapter: { displayName: "Codex Web" } }),
    });
    expect(configured.status).toBe(200);
    expect(await configured.json()).toMatchObject({
      plan: { operation: "settings" },
      changedFields: ["adapterOverrides.codex.displayName"],
      receipt: { outcome: "committed" },
    });
    expect(JSON.parse(await c.env.fs.readFile(join(c.storeRoot, "config.json")))).toMatchObject({
      adapterOverrides: { codex: { enabled: false, displayName: "Codex Web" } },
    });
  });

  it("rejects an unsafe adapter id before Web-facing mutation effects", async () => {
    const configPath = join(c.storeRoot, "config.json");
    await expect(c.env.fs.lstat(configPath)).rejects.toThrow();
    const beforeRevision = await readStoreRevision(c.env, c.storeRoot);

    const response = await c.app.request("/api/agents/agent%20id/adapter", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "custom",
        adapter: { rules: { global: "~/.unsafe/RULES.md" } },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "DOMAIN_VALIDATION_FAILED",
      details: { agentId: "agent id" },
    });
    await expect(c.env.fs.lstat(configPath)).rejects.toThrow();
    await expect(readStoreRevision(c.env, c.storeRoot)).resolves.toBe(beforeRevision);
    await expect(c.env.fs.lstat(join(c.storeRoot, "operations", "active.json"))).rejects.toThrow();
  });

  it("blocks planned custom-adapter deletion with exact owned and desired dependencies", async () => {
    const created = await c.app.request("/api/agents/local-review/adapter", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "custom",
        adapter: { rules: { global: "~/.local-review/RULES.md" } },
      }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ receipt: { outcome: "committed" } });

    const ownedTarget = join(c.root, "owned", "RULES.md");
    await c.env.fs.writeFile(
      join(c.storeRoot, "state.json"),
      `${JSON.stringify(
        {
          version: 2,
          owners: [
            {
              agent: "local-review",
              scope: "global",
              capability: "rules",
              target: ownedTarget,
              artifactIds: ["rules/style"],
              receipt: {
                method: "write",
                fingerprint: "sha256:owned",
                backup: null,
                generated: true,
                appliedAt: "2026-06-30T08:00:00.000Z",
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const deleted = await c.app.request("/api/agents/local-review/adapter", { method: "DELETE" });
    expect(deleted.status).toBe(400);
    expect(await deleted.json()).toMatchObject({
      code: "DOMAIN_VALIDATION_FAILED",
      details: {
        agentId: "local-review",
        dependencies: {
          ownedTargets: [ownedTarget],
          desiredSelections: ["agent:local-review:enabled"],
        },
      },
    });
    expect(JSON.parse(await c.env.fs.readFile(join(c.storeRoot, "config.json")))).toHaveProperty(
      "customAdapters.local-review",
    );
  });
});
