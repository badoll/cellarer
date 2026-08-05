import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealEnv, type Env, initializeStore, type MutationAuthority } from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServerApp } from "../src/server.js";

// server.ts 组装的完整 app(API + 静态 SPA + 安全加固)的集成测试。
// 关注 app.ts 覆盖不到的部分:页面级 token 门禁、CSP 响应头、静态页面的 Host 白名单。
describe("web server app — page gate / CSP / host", () => {
  let root: string;
  let staticRoot: string;
  let env: Env;
  let storeRoot: string;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-srv-")));
    staticRoot = join(root, "dist");
    const real = createRealEnv();
    const home = join(root, "home");
    env = {
      ...real,
      fs: real.fs,
      homedir: () => home,
      cwd: () => join(root, "cwd"),
      platform: "darwin",
      now: () => new Date("2026-06-30T08:00:00.000Z"),
      env: {},
    };
    storeRoot = join(home, ".cellarer");
    await fs.mkdir(join(staticRoot, "assets"), { recursive: true });
    // 忠实模拟 Vite 产物:HTML 入口引用外链 JS/CSS(带 ?token 的页面请求不会把 token 传给子资源)。
    await fs.writeFile(
      join(staticRoot, "index.html"),
      '<!doctype html><script type="module" src="/assets/app.js"></script><title>cellarer</title>',
    );
    await fs.writeFile(join(staticRoot, "assets", "app.js"), "console.log('spa')");
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  function makeApp(token?: string) {
    return buildServerApp({
      token,
      staticRoot,
      env,
      storeRoot,
    });
  }

  it("injects the preloaded authority into the Web app composition", async () => {
    let seals = 0;
    const authority: MutationAuthority = {
      seal: (request) => {
        seals += 1;
        return {
          schemaVersion: 1,
          domain: request.domain,
          algorithm: "HMAC-SHA-256",
          authorityId: "web-injected-authority",
          authorityEpoch: 1,
          seal: `hmac-sha256:${"a".repeat(64)}`,
        };
      },
      verify: () => true,
      isCurrent: async () => true,
      acquireLease: async () => ({
        isCurrent: async () => true,
        release: async () => undefined,
      }),
      publishJournalTip: async () => undefined,
      matchesJournalTip: async () => true,
    };
    env.mutationAuthority = authority;
    await initializeStore(env, storeRoot);
    seals = 0;

    const app = makeApp();
    const response = await app.request("/api/settings/collections", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        collections: {
          default: { description: "default" },
          secure: { description: "injected" },
        },
      }),
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(seals).toBeGreaterThan(0);
  });

  it("serves the SPA with a CSP header (no token)", async () => {
    const app = makeApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  it("gates the SPA page behind ?token= when a token is set", async () => {
    const app = makeApp("s3cret");
    // 无 ?token 的匿名页面请求 → 401(阻止拿到内联 token 的 HTML)。
    const anon = await app.request("/");
    expect(anon.status).toBe(401);
    // 带正确 ?token → 放行页面。
    const ok = await app.request("/?token=s3cret");
    expect(ok.status).toBe(200);
  });

  it("does NOT gate /assets/* (sub-resources have no ?token; gating them white-screens the SPA)", async () => {
    const app = makeApp("s3cret");
    // 浏览器请求 /assets/app.js 不带 ?token;门禁若拦它,带 token 的 SPA 也无法加载自身脚本。
    const asset = await app.request("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("spa");
  });

  it("still routes /api through Bearer (not ?token) when a token is set", async () => {
    const app = makeApp("s3cret");
    // /api 不看 ?token;无 Bearer → 401。
    const noBearer = await app.request("/api/agents");
    expect(noBearer.status).toBe(401);
    const withBearer = await app.request("/api/agents", {
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(withBearer.status).toBe(200);
  });

  it("does not let a /apiary-style path bypass the page gate (segment prefix, not string prefix)", async () => {
    const app = makeApp("s3cret");
    // /apiary 以 "/api" 开头但不是 API 段;不得借 startsWith 绕过 ?token 门禁。
    const res = await app.request("/apiary");
    expect(res.status).toBe(401);
  });

  it("forbids a non-loopback Host on the static page too", async () => {
    const app = makeApp();
    const res = await app.request("/", { headers: { host: "evil.example.com" } });
    expect(res.status).toBe(403);
  });
});
