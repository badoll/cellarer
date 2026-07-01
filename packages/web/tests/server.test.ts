import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServerApp } from "../src/server.js";

// server.ts 组装的完整 app(API + 静态 SPA + 安全加固)的集成测试。
// 关注 app.ts 覆盖不到的部分:页面级 token 门禁、CSP 响应头、静态页面的 Host 白名单。
describe("web server app — page gate / CSP / host", () => {
  let root: string;
  let staticRoot: string;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cellarer-srv-")));
    staticRoot = join(root, "dist");
    await fs.mkdir(join(staticRoot, "assets"), { recursive: true });
    // 忠实模拟 Vite 产物:HTML 入口引用外链 JS/CSS(带 ?token 的页面请求不会把 token 传给子资源)。
    await fs.writeFile(
      join(staticRoot, "index.html"),
      '<!doctype html><script type="module" src="/assets/app.js"></script><title>cellarer</title>',
    );
    await fs.writeFile(join(staticRoot, "assets", "app.js"), "console.log('spa')");
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it("serves the SPA with a CSP header (no token)", async () => {
    const app = buildServerApp({ staticRoot });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
  });

  it("gates the SPA page behind ?token= when a token is set", async () => {
    const app = buildServerApp({ token: "s3cret", staticRoot });
    // 无 ?token 的匿名页面请求 → 401(阻止拿到内联 token 的 HTML)。
    const anon = await app.request("/");
    expect(anon.status).toBe(401);
    // 带正确 ?token → 放行页面。
    const ok = await app.request("/?token=s3cret");
    expect(ok.status).toBe(200);
  });

  it("does NOT gate /assets/* (sub-resources have no ?token; gating them white-screens the SPA)", async () => {
    const app = buildServerApp({ token: "s3cret", staticRoot });
    // 浏览器请求 /assets/app.js 不带 ?token;门禁若拦它,带 token 的 SPA 也无法加载自身脚本。
    const asset = await app.request("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("spa");
  });

  it("still routes /api through Bearer (not ?token) when a token is set", async () => {
    const app = buildServerApp({ token: "s3cret", staticRoot });
    // /api 不看 ?token;无 Bearer → 401。
    const noBearer = await app.request("/api/agents");
    expect(noBearer.status).toBe(401);
    const withBearer = await app.request("/api/agents", {
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(withBearer.status).toBe(200);
  });

  it("forbids a non-loopback Host on the static page too", async () => {
    const app = buildServerApp({ staticRoot });
    const res = await app.request("/", { headers: { host: "evil.example.com" } });
    expect(res.status).toBe(403);
  });
});
