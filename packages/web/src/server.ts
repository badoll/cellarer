// 本地 server 入口:@hono/node-server 起服务,仅绑 127.0.0.1(安全:不暴露到网络)。
// 生产时把 client/dist 的 SPA 静态挂载;开发期前端用 vite dev server 代理 /api。
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createDefaultApp } from "./app.js";

export interface ServeOptions {
  port?: number;
  token?: string;
  // SPA 静态根(绝对路径)。由调用方(cli/ui.ts)解析 @cellarer/web 包内 client/dist 后传入;
  // 不设默认 cwd 相对路径(那只在 cwd=仓库根时碰巧可用,是会掩盖误配的死默认值)。
  staticRoot: string;
}

export function startServer(opts: ServeOptions): { port: number; close: () => void } {
  const port = opts.port ?? 4317;
  const app = new Hono();

  // /api 路由(core 能力)。
  app.route("/", createDefaultApp(opts.token));

  // SPA 静态资源 + 回退到 index.html(client-side routing)。
  const root = opts.staticRoot;
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ path: `${root}/index.html` }));

  const server = serve({
    fetch: app.fetch,
    port,
    // 安全红线:仅监听回环地址,绝不 0.0.0.0。
    hostname: "127.0.0.1",
  });

  return { port, close: () => server.close() };
}
