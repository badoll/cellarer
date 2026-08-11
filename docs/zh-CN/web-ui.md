# Web UI 与本地 Client API

[文档索引](../README.md) | [English](../en/web-ui.md)

Web UI 是建立在版本化 Hono client API 上的本地 React 控制台。两者都只是
`@cellarer/core` 的薄展示层；浏览器不会直接写文件，也不会重建 mutation 决策。

## 启动

启动内置浏览器 session：

```bash
pnpm build
node packages/cli/dist/bin.js ui
```

Managed client 应通过两个独立的受保护继承描述符传递 bearer 与进程所有权：

```bash
node packages/cli/dist/bin.js --output json ui --port 0 \
  --token-fd 3 --lifetime-fd 4 3< /path/to/ui-token 4< /path/to/lifetime-pipe
```

Server 只绑定 `127.0.0.1`。端口 `0` 表示由 OS 分配端口；只有 socket、认证、静态
资源、API contract 与 Core composition 全部就绪后，版本化 ready result 才会报告实际
base URL。

## 版本化 Contract

所有支持的 operation 都位于 `/api/v1`。`GET /api/v1/openapi.json` 通过标准 result
envelope 返回实际实现的 OpenAPI 3.1；`GET /api/v1/capabilities` 返回 operation IDs。
内置 client 会在普通请求前协商精确 API version 与 contract ID。

| 路由族 | 用途 |
| --- | --- |
| `GET /api/v1/health` | 最小、无需认证的 transport liveness。 |
| `GET /api/v1/version`、`/capabilities`、`/openapi.json` | 需要认证的 contract discovery。 |
| `GET /api/v1/readiness` | Typed Store、authority、lock 与 recovery blockers；not-ready 使用 HTTP 503 加 success envelope。 |
| `/api/v1/resources`、`/agents`、`/collections`、`/config`、`/settings` | 只读 control-plane DTO。 |
| `/api/v1/discovery`、`/diff`、`/status`、`/verify`、`/summary`、`/activity`、`/operations` | Discovery、verification、status 与 operation evidence。 |
| `/api/v1/{sync,scan,import,revert}/{plan,apply}` | 精确 preview/apply workflow。 |
| `/api/v1/resources/*/{plan,apply}` | Resource update、rename、remove、export 与 bundle-import workflow。 |
| `/api/v1/profiles/*` | Profile definition、sync、verification 与 uninstall workflow。 |
| `GET /api/v1/recovery`、`POST /api/v1/recovery/apply` | 诊断并执行已授权的中断 operation 恢复。 |

未版本化 `/api/*` surface 已删除，并会在 Core interaction 前返回 not found。

## Result 与 Mutation 语义

所有 JSON operation 都返回稳定的 `apiVersion`、`requestId`、`status`、`warnings`
envelope，以及 `data` 或 typed `error`。Planning endpoint 返回 authority-sealed
`MutationPlan`；匹配的 apply endpoint 只接受这份精确不可变 plan。浏览器不会重新
scan、replan，也不会根据 HTTP 文本推断成功。成功 apply 会返回 Core operation receipt，
其中包含已提交 revision 与逐 action outcome。

Project-scope 请求必须显式给出 project path。Profile scope 为 project 时，每次调用都
必须提供 `workspaceRoot`；profile definition 不会持久化本机路径。

## 认证与所有权

启动时必须且只能选择一种模式：

- Browser mode 每次启动都创建新的随机 session。SPA 通过精确同源 Host、Origin 与
  Fetch Metadata 检查完成 bootstrap。Cookie 使用 `HttpOnly`、`SameSite=Strict`，且
  scope 为 `/api/v1`；每个 mutation 都要求精确 loopback Origin。
- Managed mode 只接受 `Authorization: Bearer ...`。Token 从 `--token-fd` 读取；argv、
  environment fallback、query string、ready record、log 与 response body 都不接受或
  暴露 token。

API 中只有 `/api/v1/health` 是公开 liveness。静态资源保持无凭证，便于浏览器加载
shell，但仍受 Host 与 CSP policy 保护。Web 只得到窄的内存 mutation authority，不会
得到通用 `SecretStore` 或 plaintext resolver。最终 `/api/v1` serialization 统一经过
reference-only secret guard。

Programmatic close、lifetime descriptor EOF、SIGINT 与 SIGTERM 共用一个幂等、有界的
shutdown 路径。它先停止接收请求，在限制内 drain in-flight work；若 mutation 被中断，
Core journal evidence 会保留供后续正常恢复。
