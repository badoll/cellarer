// 本地 server 入口:@hono/node-server 起服务,仅绑 127.0.0.1(安全:不暴露到网络)。
// 生产时把 client/dist 的 SPA 静态挂载;开发期前端用 vite dev server 代理 /api。
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createDefaultApp } from "./app.js";
import { cspHeader, hostGuard, safeEqual } from "./security.js";

export interface ServeOptions {
  port?: number;
  token?: string;
  // SPA 静态根(绝对路径)。由调用方(cli/ui.ts)解析 @cellarer/web 包内 client/dist 后传入;
  // 不设默认 cwd 相对路径(那只在 cwd=仓库根时碰巧可用,是会掩盖误配的死默认值)。
  staticRoot: string;
}

// 组装完整 server app(API + SPA 静态 + 安全加固),不启动监听 —— 便于测试页面门禁/CSP/Host。
// 安全加固(横评 §5.2,移植自参照实现 A):
//   - Host 白名单(DNS-rebinding 防护)覆盖全路由;
//   - CSP 响应头覆盖静态页面;
//   - 页面级 token 门禁:设了 token 时,SPA 入口需 ?token= 校验(常量时间),
//     否则匿名 loopback 客户端能拿到内联 token 的 HTML 再打 API。
export function buildServerApp(opts: { token?: string; staticRoot: string; apiApp?: Hono }): Hono {
  const app = new Hono();

  // Host 白名单 + CSP 覆盖全路由(API app 内部亦有 hostGuard,重复无害且守住静态路由)。
  app.use("*", hostGuard);
  app.use("*", cspHeader);

  // 页面级 token 门禁(纵深防御):对 SPA 的 HTML 入口/路由校验 ?token=。
  // 放行 /api/(走 Bearer)与 /assets/(Vite 产物 JS/CSS,无密钥;子资源请求不带页面的 ?token=,
  // 若一并门禁会把 SPA 自身脚本挡成 401 → 白屏)。用带尾斜杠的**段前缀**匹配,避免 /apiary、/assetsx
  // 之类误放行。注:token 从不内联进 HTML(client/api.ts 运行期从 ?token= 读),故此门禁是纵深防御,
  // 不是防「HTML 泄 token」——真正的访问控制是 /api 的 Bearer 校验。
  if (opts.token) {
    const token = opts.token;
    app.use("*", async (c, next) => {
      const path = c.req.path;
      if (path === "/api" || path.startsWith("/api/") || path.startsWith("/assets/")) {
        return next();
      }
      if (!safeEqual(c.req.query("token") ?? "", token)) {
        return c.text(
          "unauthorized: open the URL printed by `cellarer ui` (includes ?token=...)",
          401,
        );
      }
      await next();
    });
  }

  // /api 路由(core 能力)。
  app.route("/", opts.apiApp ?? createDefaultApp(opts.token));

  // SPA 静态资源 + 回退到 index.html(client-side routing)。
  const root = opts.staticRoot;
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ path: `${root}/index.html` }));

  return app;
}

export function startServer(opts: ServeOptions): { port: number; close: () => void } {
  const port = opts.port ?? 4317;
  const app = buildServerApp({ token: opts.token, staticRoot: opts.staticRoot });

  const server = serve({
    fetch: app.fetch,
    port,
    // 安全红线:仅监听回环地址,绝不 0.0.0.0。
    hostname: "127.0.0.1",
  });

  return { port, close: () => server.close() };
}
