import { promises as fs, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { PassThrough } from "node:stream";
import { createRealEnv, type Env, initializeStore, type MutationAuthority } from "@cellarer/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WEB_CLIENT_ASSET_ROOT } from "../src/index.js";
import { buildServerApp, type SidecarAuthentication, startServer } from "../src/server.js";
import { deterministicMutationAuthority } from "./helpers/mutation-authority.js";

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
    const auth: SidecarAuthentication = token
      ? { mode: "bearer", token }
      : { mode: "browser-session" };
    return buildServerApp({
      auth,
      staticRoot,
      env,
      storeRoot,
    });
  }

  it("resolves packaged client assets from the Web ESM module location", () => {
    expect(WEB_CLIENT_ASSET_ROOT.split(sep).slice(-3)).toEqual(["web", "client", "dist"]);
    expect(WEB_CLIENT_ASSET_ROOT).not.toContain(env.cwd());
  });

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

    const app = makeApp("managed-test-token");
    const response = await app.request("/api/v1/collections/plan", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer managed-test-token",
      },
      body: JSON.stringify({
        action: "create",
        collectionName: "secure",
        description: "injected",
        resourceIds: [],
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

  it("serves the static shell without placing managed bearer material in the URL", async () => {
    const app = makeApp("s3cret");
    const anon = await app.request("/");
    expect(anon.status).toBe(200);
    expect(await anon.text()).not.toContain("s3cret");
  });

  it("does NOT gate /assets/* (sub-resources have no ?token; gating them white-screens the SPA)", async () => {
    const app = makeApp("s3cret");
    // 浏览器请求 /assets/app.js 不带 ?token;门禁若拦它,带 token 的 SPA 也无法加载自身脚本。
    const asset = await app.request("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("spa");
  });

  it("returns not found for legacy API routes before authentication or Core interaction", async () => {
    const app = makeApp("s3cret");
    const noBearer = await app.request("/api/agents");
    expect(noBearer.status).toBe(404);
    const withBearer = await app.request("/api/agents", {
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(withBearer.status).toBe(404);
  });

  it("does not treat an /apiary-style path as an API route", async () => {
    const app = makeApp("s3cret");
    const res = await app.request("/apiary");
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("s3cret");
  });

  it("requires a same-origin HttpOnly browser session for versioned API routes", async () => {
    const app = makeApp();
    const anonymous = await app.request("/api/v1/version");
    expect(anonymous.status).toBe(401);

    const bootstrap = await app.request("/api/v1/auth/session", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4317",
        origin: "http://127.0.0.1:4317",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.clone().json()).toMatchObject({
      status: "success",
      data: { authenticated: true, authMode: "browser-session" },
    });
    const cookie = bootstrap.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/v1");
    expect(cookie).not.toContain("s3cret");

    const authenticated = await app.request("/api/v1/version", {
      headers: { cookie: cookie.split(";")[0] ?? "" },
    });
    expect(authenticated.status).toBe(200);
  });

  it("rejects hostile browser bootstrap and mutation origins", async () => {
    const app = makeApp();
    const hostile = await app.request("/api/v1/auth/session", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4317",
        origin: "https://evil.example.com",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(hostile.status).toBe(403);
    expect(await hostile.text()).not.toContain(storeRoot);

    const bootstrap = await app.request("/api/v1/auth/session", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4317",
        origin: "http://127.0.0.1:4317",
        "sec-fetch-site": "same-origin",
      },
    });
    const cookie = (bootstrap.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const hostileMutation = await app.request("/api/v1/collections/plan", {
      method: "POST",
      headers: {
        cookie,
        host: "127.0.0.1:4317",
        origin: "https://evil.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "create",
        collectionName: "csrf",
        resourceIds: [],
      }),
    });
    expect(hostileMutation.status).toBe(403);

    const missingOrigin = await app.request("/api/v1/collections/plan", {
      method: "POST",
      headers: {
        cookie,
        host: "127.0.0.1:4317",
        "content-type": "application/json",
      },
      body: "{not-json",
    });
    expect(missingOrigin.status).toBe(403);
  });

  it("keeps browser bootstrap unavailable in managed bearer mode", async () => {
    const response = await makeApp("managed-token").request("/api/v1/auth/session", {
      method: "POST",
      headers: {
        host: "127.0.0.1:4317",
        origin: "http://127.0.0.1:4317",
        "sec-fetch-site": "same-origin",
      },
    });

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("managed-token");
  });

  it("rotates the browser session credential for every server composition", async () => {
    const bootstrap = async (app: ReturnType<typeof makeApp>) =>
      app.request("/api/v1/auth/session", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4317",
          origin: "http://127.0.0.1:4317",
          "sec-fetch-site": "same-origin",
        },
      });
    const first = await bootstrap(makeApp());
    const second = await bootstrap(makeApp());

    expect(first.headers.get("set-cookie")).not.toBe(second.headers.get("set-cookie"));
  });

  it("does not accept an attacker-selected browser session cookie", async () => {
    const app = makeApp();
    const response = await app.request("/api/v1/version", {
      headers: { cookie: "cellarer_session=attacker-fixed-session" },
    });

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("attacker-fixed-session");
  });

  it("keeps the bearer credential out of URLs and requires the Authorization header", async () => {
    const app = makeApp("s3cret");
    const query = await app.request("/api/v1/version?token=s3cret");
    expect(query.status).toBe(401);
    const bearer = await app.request("/api/v1/version", {
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(bearer.status).toBe(200);
    expect(await (await app.request("/")).text()).not.toContain("s3cret");
  });

  it("forbids a non-loopback Host on the static page too", async () => {
    const app = makeApp();
    const res = await app.request("/", { headers: { host: "evil.example.com" } });
    expect(res.status).toBe(403);
  });

  it("publishes readiness after an ephemeral port is actually bound and closes idempotently", async () => {
    const handle = await startServer({
      port: 0,
      auth: { mode: "browser-session" },
      staticRoot,
      env,
      storeRoot,
    });
    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.ready).toEqual({
        schemaVersion: 1,
        apiVersion: "1.0",
        contractId: "cellarer-local-client-api-v1",
        lifecycle: "owned-v1",
        authMode: "browser-session",
        pid: process.pid,
        baseUrl: `http://127.0.0.1:${handle.port}`,
      });
      const health = await fetch(`${handle.ready.baseUrl}/api/v1/health`);
      expect(health.status).toBe(200);
    } finally {
      await handle.close();
      await handle.close();
    }
  });

  it("does not publish readiness when the packaged SPA entry is missing", async () => {
    await expect(
      startServer({
        port: 0,
        auth: { mode: "browser-session" },
        staticRoot: join(root, "missing-dist"),
        env,
        storeRoot,
      }),
    ).rejects.toThrow("index.html");
  });

  it("closes the owned sidecar when its lifetime channel reaches EOF", async () => {
    const lifetime = new PassThrough();
    const handle = await startServer({
      port: 0,
      auth: { mode: "browser-session" },
      staticRoot,
      env,
      storeRoot,
      lifetime,
    } as Parameters<typeof startServer>[0] & { lifetime: PassThrough });

    lifetime.end();
    await expect(
      Promise.race([
        handle.closed.then(() => "closed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 250)),
      ]),
    ).resolves.toBe("closed");
  });

  it("stops accepting and drains an in-flight request before graceful close completes", async () => {
    const entered = deferred();
    const release = deferred();
    const baseFs = env.fs;
    const drainingEnv: Env = {
      ...env,
      fs: {
        ...baseFs,
        readdir: async (path) => {
          if (path === join(storeRoot, "store", "rules")) {
            entered.resolve();
            await release.promise;
          }
          return baseFs.readdir(path);
        },
      },
    };
    const handle = await startServer({
      port: 0,
      auth: { mode: "bearer", token: "drain-token" },
      staticRoot,
      env: drainingEnv,
      storeRoot,
      shutdownTimeoutMs: 1_000,
    });
    const request = fetch(`${handle.ready.baseUrl}/api/v1/resources/rules`, {
      headers: { authorization: "Bearer drain-token" },
    });
    await entered.promise;

    const closing = handle.close();
    await expect(
      Promise.race([
        closing.then(() => "closed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("draining"), 25)),
      ]),
    ).resolves.toBe("draining");
    release.resolve();

    expect((await request).status).toBe(200);
    await closing;
  });

  it("bounds drain time when an in-flight request cannot complete", async () => {
    const entered = deferred();
    const release = deferred();
    const baseFs = env.fs;
    const blockedEnv: Env = {
      ...env,
      fs: {
        ...baseFs,
        readdir: async (path) => {
          if (path === join(storeRoot, "store", "rules")) {
            entered.resolve();
            await release.promise;
          }
          return baseFs.readdir(path);
        },
      },
    };
    const handle = await startServer({
      port: 0,
      auth: { mode: "bearer", token: "bounded-token" },
      staticRoot,
      env: blockedEnv,
      storeRoot,
      shutdownTimeoutMs: 20,
    });
    const request = fetch(`${handle.ready.baseUrl}/api/v1/resources/rules`, {
      headers: { authorization: "Bearer bounded-token" },
    }).catch(() => undefined);
    await entered.promise;

    await expect(
      Promise.race([
        handle.close().then(() => "closed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500)),
      ]),
    ).resolves.toBe("closed");
    release.resolve();
    await request;
  });

  it("preserves an active Core journal when bounded shutdown closes its connection", async () => {
    env.mutationAuthority = deterministicMutationAuthority();
    await initializeStore(env, storeRoot);
    const journalPublished = deferred();
    const releaseJournal = deferred();
    const baseFs = env.fs;
    const mutationEnv: Env = {
      ...env,
      fs: {
        ...baseFs,
        publishFileAtomically: async (path, data, options) => {
          await baseFs.publishFileAtomically(path, data, options);
          if (path === join(storeRoot, "operations", "active.json")) {
            journalPublished.resolve();
            await releaseJournal.promise;
          }
        },
      },
    };
    const handle = await startServer({
      port: 0,
      auth: { mode: "bearer", token: "journal-token" },
      staticRoot,
      env: mutationEnv,
      storeRoot,
      shutdownTimeoutMs: 20,
    });
    const headers = {
      authorization: "Bearer journal-token",
      "content-type": "application/json",
    };
    const plannedResponse = await fetch(`${handle.ready.baseUrl}/api/v1/collections/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "create",
        collectionName: "shutdown-journal",
        resourceIds: [],
      }),
    });
    const planned = (await plannedResponse.json()) as {
      data: { plan: Record<string, unknown> };
    };
    const applying = fetch(`${handle.ready.baseUrl}/api/v1/mutations/apply`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mutationPlan: planned.data.plan }),
    }).catch(() => undefined);
    await journalPublished.promise;

    await handle.close();
    await expect(env.fs.readFile(join(storeRoot, "operations", "active.json"))).resolves.toContain(
      '"operationId"',
    );

    releaseJournal.resolve();
    await applying;
    await waitUntilAbsent(env, join(storeRoot, "operations", "active.json"));
  });
});

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntilAbsent(env: Env, path: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const exists = await env.fs
      .lstat(path)
      .then(() => true)
      .catch((error: unknown) => (error as { code?: string }).code !== "ENOENT");
    if (!exists) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for path removal: ${path}`);
}
