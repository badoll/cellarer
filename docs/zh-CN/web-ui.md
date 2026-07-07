# Web UI

[文档索引](../README.md) | [English](../en/web-ui.md)

Web UI 是用于查看和操作 cellarer 库房的本地控制台。它是 `@cellarer/core` 的薄壳。

## 启动

```bash
pnpm build
node packages/cli/dist/bin.js ui
node packages/cli/dist/bin.js ui --port 4317 --token local-token
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
| `POST /api/import/plan` | 导入预览。 |
| `POST /api/import/apply` | 导入已预览并选择的资源。 |
| `POST /api/sync/plan` | 同步预览。 |
| `POST /api/sync/apply` | 将已预览的资源同步到 agents。 |
| `GET /api/agents` | 已注册适配器、启用状态、能力矩阵与 global 探测状态。 |
| `GET /api/settings` | 库房默认值、collections、adapter ids 与密钥引用。 |
| `GET /api/status` | 台账漂移状态。 |
| `GET /api/secrets` | 只返回密钥引用名。 |

project scope 请求必须包含 `dir`。

## 安全行为

- API 可以用 bearer token 保护。
- 校验 Host header 以降低 DNS rebinding 风险。
- Web 下发永远使用 `secretMode: "env"`。
- API 响应不返回密钥真值。

## 当前边界

- UI 中导入和同步都要求先预览。
- Project-level 同步必须显式填写项目路径。
- 密钥真值永不展示,只显示引用名。
