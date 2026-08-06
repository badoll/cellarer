# Web UI

[文档索引](../README.md) | [English](../en/web-ui.md)

Web UI 是用于查看和操作 cellarer 库房的本地控制台。它是 `@cellarer/core` 的薄壳。

## 启动

```bash
pnpm build
node packages/cli/dist/bin.js ui
node packages/cli/dist/bin.js ui --port 4317 --token-fd 3 3< /path/to/ui-token
```

服务只监听 `127.0.0.1`。

## 运行形态

```text
React SPA -> Hono API -> @cellarer/web -> @cellarer/core -> Env -> local files
```

浏览器不会直接写文件。所有文件操作都经过 core。

## API 面

| 路由 | 用途 |
| --- | --- |
| `GET /api/resources` | 资源目录、状态计数、collections 与同步目标。 |
| `GET /api/resources/:kind` | 按 `skills`、`mcp` 或 `rules` 过滤的资源目录。 |
| `GET /api/discovery` | 可导入的既有 agent 文件。 |
| `POST /api/doctor` | 只读诊断,包括 typed mutation recovery evidence。 |
| `POST /api/plan` | 带 mutation plan identity 与 base revision 的下发预览。 |
| `POST /api/apply` | 通过 mutation receipt 边界 plan 并 apply 下发。 |
| `POST /api/import/plan` | 导入预览。 |
| `POST /api/import/apply` | 导入已预览并选择的资源。 |
| `POST /api/sync/plan` | 同步预览。 |
| `POST /api/sync/apply` | 将已预览的资源同步到 agents。 |
| `POST /api/resource-lifecycle/{dependencies,check}` | 读取精确 dependency 或 provenance DTO。 |
| `POST /api/resource-lifecycle/update/{plan,apply}` | Staging/planning 或应用绑定候选内容的 Store-only update。 |
| `POST /api/resource-lifecycle/{rename,remove,export,import}` | 计划或应用语义分离的对应生命周期 verb。 |
| `POST /api/resource-lifecycle/bundle/validate` | Import 前验证 portable bundle。 |
| `GET/POST /api/profiles`、`GET/PUT/DELETE /api/profiles/:id` | Profile list/show/create/update/delete。 |
| `POST /api/sync/profiles/:id/{plan,apply,verify,uninstall}` | 精确 profile workflow;project profile 要求 `workspaceRoot`。 |
| `POST /api/revert` | 通过同一 receipt 边界预览或执行 ledger revert。 |
| `POST /api/verify` | Desired-versus-applied、applied-versus-disk 与 recovery health。 |
| `GET /api/agents` | 已注册适配器、启用状态、能力矩阵与 global 探测状态。 |
| `GET /api/settings` | 库房默认值、collections、adapter ids 与密钥引用。 |
| `GET /api/status` | 台账漂移状态。 |
| `GET /api/secrets` | 只返回密钥引用名。 |

旧式 project-scope 下发请求必须包含 `dir`。基于 profile 的 project 请求每次都必须包含
绝对 `workspaceRoot`;profile 不会持久化本机 project path。

## Mutation 与 Verification 响应

Plan 响应包含安全的 `mutation` 摘要,其中有 `planId`、`planDigest`、operation 和
`baseRevision`。成功的 apply 与 revert 响应还会包含 operation receipt,其中有
resulting revision 和每个 action 的 outcomes。Typed conflicts 与 recovery errors 不会
暴露原始 plan content 或 state publication data;durable journal 对这些字段只保留
安全的引用和 digests。

当前本地 API 通过 `/api/doctor` 和 `/api/verify` 诊断中断 operation,但没有暴露
写侧 recovery 路由。不要按 lock 存续时间删除它。恢复必须由可信 Core 调用方使用
精确的诊断 operation id 执行,详见[核心概念](concepts.md#并发与中断-operation-恢复)。

`GET /api/status` 只返回 ledger-versus-disk items。完整报告请使用
`POST /api/verify`;`healthy` 要求两个 verification axes 都是 `converged`,且
recovery 为 `clean`。

## 安全行为

- API 可以用 bearer token 保护。
- 校验 Host header 以降低 DNS rebinding 风险。
- Web 下发永远使用 `secretMode: "env"`。
- API 响应不返回密钥真值。

## 当前边界

- UI 中导入和同步都要求先预览。
- Project-level 同步必须显式填写项目路径。
- 密钥真值永不展示,只显示引用名。
