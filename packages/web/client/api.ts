// Hono RPC 客户端:端到端类型来自 server 的 AppType(type-only import,运行时只走 fetch)。
import { hc } from "hono/client";
import type { AppType } from "../src/app.js";

// 启用 --token 时,server 会 401 所有 /api;SPA 从 URL 的 ?token=... 读取并作为 Bearer 头附带,
// 这样 `cellarer ui --token X` 打开 http://127.0.0.1:port/?token=X 即可用(无 token 时此处为空,不附头)。
const token = new URLSearchParams(location.search).get("token");
const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

// 同源(server serveStatic + /api 同进程);开发期 vite 代理 /api。
export const client = hc<AppType>("/", { headers });
