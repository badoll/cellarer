// Web 安全加固共享件(移植自参照实现 A 的 server.ts,见横评 §5.2)。
// 仅 @cellarer/web 使用;web 是 Node 包,可 import node:crypto(不变量 2 只约束 @cellarer/core)。
import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";

// 内容安全策略:B 的 SPA(Vite 产物)只用外链 script/style(见 client/dist/index.html),
// 故 script-src 可严格为 'self';style 放宽 'unsafe-inline' 容纳 React 行内 style 属性;
// connect-src 'self' 限制 XHR/fetch 回源。防 XSS 注入外部脚本。
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";

// 常量时间比较,消除 token 校验的时序侧信道(长度不等直接 false,不进入 timingSafeEqual)。
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// 仅允许本机 Host,挡住 DNS rebinding(攻击者把域名解析到 127.0.0.1 借浏览器发起本地请求)。
// 精确匹配(剥离端口后全等):不能用 startsWith —— 否则 `127.0.0.1.evil.com` /
// `localhost.evil.com` 会被误判为本机，绕过认证前的 authority 边界。
export function isLoopbackHost(host: string): boolean {
  if (host === "") return false;
  const h = stripPort(host);
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
}

// 从 Host 头剥离端口:IPv6 括号形式 `[::1]:4317` → `[::1]`;其余 `host:4317` → `host`。
function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(0, end + 1) : host;
  }
  const colon = host.indexOf(":");
  return colon >= 0 ? host.slice(0, colon) : host;
}

// Host 白名单中间件:非本机 Host → 403。
export async function hostGuard(c: Context, next: Next): Promise<Response | undefined> {
  const effectiveHost = c.req.header("host") ?? new URL(c.req.url).host;
  if (!isLoopbackHost(effectiveHost)) {
    return c.text("forbidden host", 403);
  }
  await next();
  return undefined;
}

// CSP 响应头中间件(处理完再补头,覆盖静态页面与 API 响应)。
export async function cspHeader(c: Context, next: Next): Promise<void> {
  await next();
  c.header("Content-Security-Policy", CSP);
}
