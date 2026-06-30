import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 前端 SPA(client/)构建配置。开发期 /api 代理到内嵌 Hono server(默认 4317)。
// 产物输出 client/dist,由 server.ts 的 serveStatic 挂载。
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4317",
    },
  },
});
