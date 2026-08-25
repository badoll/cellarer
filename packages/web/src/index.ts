// @cellarer/web 对外:Hono app 工厂 + RPC 类型 + server 启动。
import { fileURLToPath } from "node:url";

export const WEB_CLIENT_ASSET_ROOT = fileURLToPath(new URL("../client/dist", import.meta.url));
export {
  CLIENT_API_ROUTES,
  type ClientApiAuthentication,
  type ClientApiMethod,
  type ClientApiRouteDefinition,
  createClientOpenApiDocument,
} from "./api-contract.js";
export {
  type AppDeps,
  type AppType,
  bindInventorySecretAdoptionService,
  createApp,
  type InventorySecretAdoptionService,
} from "./app.js";
export {
  type ServeOptions,
  type SidecarAuthentication,
  type SidecarHandle,
  type SidecarReadyRecord,
  startServer,
} from "./server.js";
