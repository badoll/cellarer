// 本地 server 入口:@hono/node-server 起服务,仅绑 127.0.0.1(安全:不暴露到网络)。
// 生产时把 client/dist 的 SPA 静态挂载;开发期前端用 vite dev server 代理 /api。

import { join } from "node:path";
import type { Readable } from "node:stream";
import { CLIENT_API_CONTRACT_ID, CLIENT_API_VERSION, type Env } from "@cellarer/core";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { type AppAuthentication, bindInventorySecretAdoptionService, createApp } from "./app.js";
import { cspHeader, hostGuard } from "./security.js";

export interface ServeOptions {
  port?: number;
  auth: SidecarAuthentication;
  env: Env;
  storeRoot: string;
  // SPA 静态根(绝对路径)。由调用方(cli/ui.ts)解析 @cellarer/web 包内 client/dist 后传入;
  // 不设默认 cwd 相对路径(那只在 cwd=仓库根时碰巧可用,是会掩盖误配的死默认值)。
  staticRoot: string;
  // Managed callers keep this inherited channel open for the sidecar lifetime. EOF means the
  // owner is gone and must converge on the same shutdown state machine as close()/signals.
  lifetime?: Readable;
  shutdownTimeoutMs?: number;
}

export type SidecarAuthentication =
  | { readonly mode: "bearer"; readonly token: string }
  | { readonly mode: "browser-session" };

export interface SidecarReadyRecord {
  readonly schemaVersion: 1;
  readonly apiVersion: typeof CLIENT_API_VERSION;
  readonly contractId: typeof CLIENT_API_CONTRACT_ID;
  readonly lifecycle: "owned-v1";
  readonly authMode: "bearer" | "browser-session";
  readonly pid: number;
  readonly baseUrl: string;
}

export interface SidecarHandle {
  readonly port: number;
  readonly ready: SidecarReadyRecord;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

// 组装完整 server app(API + SPA 静态 + 安全加固),不启动监听 —— 便于测试页面门禁/CSP/Host。
// 安全加固(横评 §5.2,移植自参照实现 A):
//   - Host 白名单(DNS-rebinding 防护)覆盖全路由;
//   - CSP 响应头覆盖静态页面;
//   - Managed bearer and bundled browser-session modes are composed explicitly.
export function buildServerApp(opts: Omit<ServeOptions, "port">): Hono {
  const app = new Hono();
  const auth: AppAuthentication =
    opts.auth.mode === "bearer"
      ? opts.auth
      : { mode: "browser-session", sessionId: opts.env.randomId() };

  // Host 白名单 + CSP 覆盖全路由(API app 内部亦有 hostGuard,重复无害且守住静态路由)。
  app.use("*", hostGuard);
  app.use("*", cspHeader);
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/v1/")) return next();
    return c.notFound();
  });

  // /api 路由(core 能力)。
  // Credentials are loaded by the outer CLI/server composition. Route handlers receive only the
  // already constructed in-memory capability through Env and never access the credential manager.
  app.route(
    "/",
    createApp({
      env: opts.env,
      storeRoot: opts.storeRoot,
      auth,
      inventorySecretAdoption: bindInventorySecretAdoptionService(opts.env, opts.storeRoot),
    }),
  );

  // SPA 静态资源 + 回退到 index.html(client-side routing)。
  const root = opts.staticRoot;
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ path: `${root}/index.html` }));

  return app;
}

export async function startServer(opts: ServeOptions): Promise<SidecarHandle> {
  const indexPath = join(opts.staticRoot, "index.html");
  const indexStat = await opts.env.fs.stat(indexPath).catch(() => null);
  if (!indexStat?.isFile()) {
    throw new Error(`sidecar static entry is unavailable: ${indexPath}`);
  }
  const port = opts.port ?? 4317;
  const app = buildServerApp({
    auth: opts.auth,
    staticRoot: opts.staticRoot,
    env: opts.env,
    storeRoot: opts.storeRoot,
  });

  const server = serve({
    fetch: app.fetch,
    port,
    // 安全红线:仅监听回环地址,绝不 0.0.0.0。
    hostname: "127.0.0.1",
  });

  await waitUntilListening(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("sidecar did not publish a TCP listening address");
  }
  const actualPort = address.port;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= closeServer(server, opts.shutdownTimeoutMs).finally(() => resolveClosed?.());
    return closePromise;
  };
  server.once("close", () => resolveClosed?.());
  const lifetime = opts.lifetime;
  if (lifetime) {
    const ownerClosed = () => {
      void close();
    };
    lifetime.once("end", ownerClosed);
    lifetime.once("close", ownerClosed);
    lifetime.once("error", ownerClosed);
    lifetime.resume();
    void closed.finally(() => {
      lifetime.off("end", ownerClosed);
      lifetime.off("close", ownerClosed);
      lifetime.off("error", ownerClosed);
    });
  }
  return {
    port: actualPort,
    ready: {
      schemaVersion: 1,
      apiVersion: CLIENT_API_VERSION,
      contractId: CLIENT_API_CONTRACT_ID,
      lifecycle: "owned-v1",
      authMode: opts.auth.mode,
      pid: process.pid,
      baseUrl: `http://127.0.0.1:${actualPort}`,
    },
    closed,
    close,
  };
}

async function waitUntilListening(server: ReturnType<typeof serve>): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

function closeServer(server: ReturnType<typeof serve>, timeoutMs = 5_000): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        if ("closeAllConnections" in server) server.closeAllConnections();
      },
      Math.max(0, timeoutMs),
    );
    timer.unref();
    server.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}
