# M4 设计:Web UI(Hono RPC + React/Vite SPA)

> 承 [kickoff.md](../kickoff.md) §12 与实施计划 §9 的 M4。把 `@cellarer/core` 暴露为本地 HTTP 可视化界面。
> 安全红线见 [AGENTS.md](../../AGENTS.md):仅 127.0.0.1、密钥不明文回显。

## 1. 结构

`@cellarer/web` 一包两件,构建分离:

- **server**(`src/`,tsc -b 编译 + 类型导出):Hono app + @hono/node-server。
- **client**(`client/`,Vite 构建,独立 tsconfig `Bundler`+`DOM`,**排除出 `tsc -b`**):React SPA。

`web` 的 `build = tsc -b && vite build client`;SPA 产物 `client/dist` 列入 turbo `outputs`,
故 clean checkout 跑 `pnpm build` 就能产出可用 UI(评审修复:`build:ui` 曾是孤儿脚本)。

## 2. RPC server(`src/app.ts`)

`createApp({ env, storeRoot, token? })` 可注入(便于测试)。路由 = core 能力薄壳(不变量 1):

| 路由 | 能力 |
| --- | --- |
| `GET /api/artifacts` | 库房三类制品 + 通道标签 |
| `GET /api/agents` | 适配器与能力矩阵 |
| `POST /api/plan` | 下发预览(dry-run) |
| `POST /api/apply` | 执行下发 |
| `POST /api/scan` | 扫描回写预览(只读) |
| `GET /api/status` | 漂移检测 |
| `GET /api/secrets` | 密钥引用名(只名;走 core `collectLedgerSecretRefs`) |

`AppType = ReturnType<typeof createApp>` 导出,前端 `hc<AppType>` 取端到端类型。

## 3. 安全模型

- **仅 127.0.0.1**:`server.ts` 给 `serve()` 传 `hostname:"127.0.0.1"`(@hono/node-server v2 正确键),绝不 0.0.0.0。
- **密钥不明文回显**:`distributeOpts` 末位 pin `secretMode:"env"`(body 无 secretMode 字段,无法覆盖)。
  env 模式下 plan 的 `preview.after` 只含 `${ENV}` 占位;统一 secret-scan 护栏命中还会清空 preview。
  `/api/secrets` 只列引用名;`/api/scan` 的 ScanItem 不含真值。测试以「响应 grep 无真值」断言。
- **可选 token**:`--token` 设置后 `/api/*` 需 `Authorization: Bearer <token>`;SPA 从 `?token=` 读取并附头。
- **project scope 必须带 dir**:否则 core 以 server cwd 为工程根写文件 → 路由层 400 拦截(评审修复)。
- **健壮性**:`app.onError` 把 JSON 解析失败 / core 抛错转 400 JSON,不裸 500/栈。

## 4. 前端(`client/`)

React + Vite SPA。页:Dashboard(总览)/ 制品 / 下发(agent×能力 矩阵 → plan 预览 → apply)/
扫描(dry-run 发现项)/ 密钥(引用名 + 掩码)。开发期 Vite 代理 `/api` 到内嵌 server(默认 4317)。

## 5. `cellarer ui`

`cellarer ui [--port] [--token]`:经 `require.resolve("@cellarer/web/package.json")` 定位包内 `client/dist`
作静态根,起 server 并打印 `http://127.0.0.1:<port>`。

## 6. 遗留到 M5(评审记下)

- 前端改用 `InferResponseType<typeof client.api.x.$get>` 替代手写响应类型(当前 cast 丢了 RPC 类型红利)。
- web 请求体类型由 `Pick<DistributeOptions, …>` 派生,避免与 core 漂移。
- token 比较换 `timingSafeEqual`(loopback-only 风险低);未知 `/api/*` 返回 JSON 404 而非 SPA 回退。
- 抽 `useAgents` hook 去重三处相同 fetch。
