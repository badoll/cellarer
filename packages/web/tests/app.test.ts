import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealEnv, type Env } from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

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
    now: () => new Date("2026-06-30T08:00:00.000Z"),
    env: envVars,
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

describe("web app — artifacts/agents", () => {
  let c: Ctx;
  beforeEach(async () => {
    c = makeCtx();
    await seedStore(c);
  });
  afterEach(() => c.cleanup());

  it("lists store artifacts with channels", async () => {
    await c.env.fs.writeFile(join(c.storeRoot, "store", "rules", "style.md"), "# rules");
    await c.env.fs.writeFile(
      join(c.storeRoot, "store", "mcp", "ctx.json"),
      JSON.stringify({ command: "npx" }),
    );
    const res = await c.app.request("/api/artifacts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rules.map((a: { name: string }) => a.name)).toContain("style");
    expect(body.mcp.map((a: { name: string }) => a.name)).toContain("ctx");
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
      root: string;
    }[];

    expect(agents.find((a) => a.id === "codex")).toMatchObject({
      detected: true,
      root: join(c.root, "home", ".codex"),
    });
    expect(agents.find((a) => a.id === "claude-code")).toMatchObject({
      detected: false,
      root: join(c.root, "home", ".claude"),
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
      channel: "common",
      scope: "global",
      desiredCount: 1,
      percentage: 0,
    });

    const activity = await c.app.request("/api/activity");
    expect(activity.status).toBe(200);
    expect(await activity.json()).toMatchObject({ events: [], warnings: [] });
  });

  it("records mutating operations as activity but not previews or dry-runs", async () => {
    await c.env.fs.mkdir(join(c.root, "home", ".claude"), { recursive: true });
    await c.env.fs.writeFile(join(c.root, "home", ".claude", "CLAUDE.md"), "# Team rules");

    await c.app.request("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "claude-code", scope: "global", capabilities: ["rules"] }),
    });
    expect((await (await c.app.request("/api/activity")).json()).events).toHaveLength(0);

    await c.app.request("/api/scan/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "claude-code", scope: "global", capabilities: ["rules"] }),
    });
    await c.app.request("/api/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], scope: "global", capabilities: ["rules"] }),
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

  it("serves available and unavailable drift diffs without plaintext secrets", async () => {
    await c.env.fs.writeFile(join(c.storeRoot, "store", "rules", "style.md"), "# style");
    await c.app.request("/api/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], scope: "global", capabilities: ["rules"] }),
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
      available: true,
      before: "[redacted secret content]",
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

  it("plan response never contains a real secret value (env mode forced)", async () => {
    await c.env.fs.writeFile(
      join(c.storeRoot, "store", "mcp", "ctx.json"),
      JSON.stringify({ command: "npx", env: { API_KEY: CELLARER_SECRET_REF } }),
    );
    const res = await c.app.request("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], scope: "global", capabilities: ["mcp"] }),
    });
    const text = await res.text();
    expect(text).not.toContain(REAL); // 真值绝不出现在响应
    expect(text).toContain(ENV_SECRET_REF); // env 引用形态
  });

  it("secrets endpoint lists only reference names, never values", async () => {
    // 先 apply 一个带 secretRef 的 mcp,使台账记录引用名。
    await c.env.fs.writeFile(
      join(c.storeRoot, "store", "mcp", "ctx.json"),
      JSON.stringify({ command: "npx", env: { API_KEY: CELLARER_SECRET_REF } }),
    );
    await c.app.request("/api/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], scope: "global", capabilities: ["mcp"] }),
    });
    const res = await c.app.request("/api/secrets");
    const body = await res.json();
    expect(body.names).toContain("C7_KEY");
    expect(body.refs).toContainEqual({ name: "C7_KEY", ledgerEntryCount: 1 });
    expect(JSON.stringify(body)).not.toContain(REAL);
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

  it("imports scan candidates and refreshes the artifact inventory", async () => {
    await c.env.fs.mkdir(join(c.root, "home", ".claude"), { recursive: true });
    await c.env.fs.writeFile(join(c.root, "home", ".claude", "CLAUDE.md"), "# Team rules");

    const res = await c.app.request("/api/scan/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude-code",
        scope: "global",
        capabilities: ["rules"],
        intoChannel: "common",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toContainEqual(
      expect.objectContaining({ kind: "rules", name: "claude-code", action: "import" }),
    );

    const artifacts = await (await c.app.request("/api/artifacts")).json();
    expect(artifacts.rules).toContainEqual(
      expect.objectContaining({ name: "claude-code", channels: ["common"] }),
    );
  });

  it("imports only selected scan rows when different kinds share a name", async () => {
    await c.env.fs.mkdir(join(c.root, "home", ".claude"), { recursive: true });
    await c.env.fs.writeFile(join(c.root, "home", ".claude", "CLAUDE.md"), "# Team rules");
    await c.env.fs.writeFile(
      join(c.root, "home", ".claude", "mcp.json"),
      JSON.stringify({ mcpServers: { "claude-code": { command: "npx" } } }),
    );

    const res = await c.app.request("/api/scan/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude-code",
        scope: "global",
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

    const artifacts = await (await c.app.request("/api/artifacts")).json();
    expect(artifacts.rules.map((a: { name: string }) => a.name)).toContain("claude-code");
    expect(artifacts.mcp.map((a: { name: string }) => a.name)).not.toContain("claude-code");
  });

  it("does not expose plaintext secrets while importing scanned MCP config", async () => {
    await c.env.fs.mkdir(join(c.root, "home", ".claude"), { recursive: true });
    await c.env.fs.writeFile(
      join(c.root, "home", ".claude", "mcp.json"),
      JSON.stringify({ mcpServers: { ctx: { command: "npx", env: { API_KEY: REAL } } } }),
    );

    const res = await c.app.request("/api/scan/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "claude-code", scope: "global", capabilities: ["mcp"] }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(REAL);
    expect(text).toContain("MCP_CTX_API_KEY");
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
    expect(JSON.stringify(body)).not.toContain("Error:");
  });

  it("requires a dry-run preview before the UI can safely call revert", async () => {
    await c.env.fs.writeFile(join(c.storeRoot, "store", "rules", "style.md"), "# style");
    await c.app.request("/api/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], scope: "global", capabilities: ["rules"] }),
    });

    const preview = await c.app.request("/api/revert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], dryRun: true }),
    });
    expect(preview.status).toBe(200);
    expect((await preview.json()).reverted).toHaveLength(1);
    expect((await (await c.app.request("/api/status")).json()).items).toHaveLength(1);

    const apply = await c.app.request("/api/revert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], dryRun: false }),
    });
    expect(apply.status).toBe(200);
    expect((await apply.json()).reverted).toHaveLength(1);
    expect((await (await c.app.request("/api/status")).json()).items).toHaveLength(0);
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

  it("rejects project-scope apply without a dir (would write into server cwd)", async () => {
    const res = await c.app.request("/api/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], scope: "project", capabilities: ["rules"] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("project");
  });

  it("rejects project-scope scan without a dir (would read server cwd)", async () => {
    const res = await c.app.request("/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "claude-code", scope: "project" }),
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
    const res = await c.app.request("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});
