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
| `GET /api/artifacts` | 库房制品与 channel 标签。 |
| `GET /api/agents` | 已注册适配器、能力矩阵与 global 探测状态。 |
| `POST /api/plan` | 下发预览。 |
| `POST /api/apply` | 执行下发。 |
| `POST /api/scan` | 只做扫描预览。 |
| `GET /api/status` | 台账漂移状态。 |
| `GET /api/secrets` | 只返回密钥引用名。 |

project scope 请求必须包含 `dir`。

## 安全行为

- API 可以用 bearer token 保护。
- 校验 Host header 以降低 DNS rebinding 风险。
- Web 下发永远使用 `secretMode: "env"`。
- API 响应不返回密钥真值。

## 当前边界

- Web 扫描只是预览;写入扫描结果仍走 CLI。
- status 暴露漂移状态,没有独立 diff API。
- 当前没有独立于 apply 台账之外的活动历史。
