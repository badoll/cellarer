// @cellarer/web 对外:Hono app 工厂 + RPC 类型 + server 启动。
import { fileURLToPath } from "node:url";

export const WEB_CLIENT_ASSET_ROOT = fileURLToPath(new URL("../client/dist", import.meta.url));
export { type AppDeps, type AppType, createApp } from "./app.js";
export { type ServeOptions, startServer } from "./server.js";
