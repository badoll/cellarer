// @cellarer/web 对外:Hono app 工厂 + RPC 类型 + server 启动。
export { type AppDeps, type AppType, createApp, createDefaultApp } from "./app.js";
export { type ServeOptions, startServer } from "./server.js";
