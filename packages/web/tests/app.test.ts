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

  it("lists builtin agents with capabilities", async () => {
    const res = await c.app.request("/api/agents");
    const body = await res.json();
    expect(body.agents.map((a: { id: string }) => a.id)).toContain("claude-code");
  });
});

describe("web app — secret safety (red line)", () => {
  let c: Ctx;
  const REAL = "ghp_0123456789abcdefghijklmnopqrstuvwx";
  beforeEach(async () => {
    // 即便环境变量里有真值,web 也只写 ${ENV} 引用,响应里不得出现真值。
    c = makeCtx({ C7_KEY: REAL });
    await seedStore(c);
  });
  afterEach(() => c.cleanup());

  it("plan response never contains a real secret value (env mode forced)", async () => {
    await c.env.fs.writeFile(
      join(c.storeRoot, "store", "mcp", "ctx.json"),
      JSON.stringify({ command: "npx", env: { API_KEY: "${CELLARER_SECRET:C7_KEY}" } }),
    );
    const res = await c.app.request("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], scope: "global", capabilities: ["mcp"] }),
    });
    const text = await res.text();
    expect(text).not.toContain(REAL); // 真值绝不出现在响应
    expect(text).toContain("${C7_KEY}"); // env 引用形态
  });

  it("secrets endpoint lists only reference names, never values", async () => {
    // 先 apply 一个带 secretRef 的 mcp,使台账记录引用名。
    await c.env.fs.writeFile(
      join(c.storeRoot, "store", "mcp", "ctx.json"),
      JSON.stringify({ command: "npx", env: { API_KEY: "${CELLARER_SECRET:C7_KEY}" } }),
    );
    await c.app.request("/api/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agents: ["claude-code"], scope: "global", capabilities: ["mcp"] }),
    });
    const res = await c.app.request("/api/secrets");
    const body = await res.json();
    expect(body.names).toContain("C7_KEY");
    expect(JSON.stringify(body)).not.toContain(REAL);
  });
});

describe("web app — access token", () => {
  it("rejects /api without the configured bearer token", async () => {
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
    const app = createApp({ env, storeRoot: join(root, "home", ".cellarer"), token: "s3cret" });
    const unauth = await app.request("/api/agents");
    expect(unauth.status).toBe(401);
    const ok = await app.request("/api/agents", {
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(ok.status).toBe(200);
    await fs.rm(root, { recursive: true, force: true });
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

  it("returns 400 (not 500) on a malformed JSON body", async () => {
    const res = await c.app.request("/api/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});
