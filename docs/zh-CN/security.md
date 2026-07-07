# 安全

[文档索引](../README.md) | [English](../en/security.md)

cellarer 是本地配置工具,但密钥处理仍是硬边界。

## 明文密钥边界

库房资源和生成文件不得包含明文密钥。应使用引用:

```json
{
  "command": "example-server",
  "env": {
    "OPENAI_API_KEY": "${OPENAI_API_KEY}"
  }
}
```

或:

```json
{
  "command": "example-server",
  "env": {
    "OPENAI_API_KEY": "${CELLARER_SECRET:OPENAI_API_KEY}"
  }
}
```

## 密钥模式

| 模式 | 行为 |
| --- | --- |
| `env` | 将密钥引用渲染为环境变量引用。默认且最适合生成文件。 |
| `vault` | 显式请求时从 age 加密 vault 解析。 |
| `keychain` | 可用时通过注入的系统 secret store 解析。 |

如果 vault 或 keychain 无法安全解析,cellarer 会回退到环境变量引用,而不是写入 agent
无法理解的内部占位符。

## 导入与扫描护栏

- `add` 会拒绝包含高置信明文密钥的导入来源。
- `scan` 在写库房前会脱敏结构化 MCP 密钥字段。
- 写库房前还有最终明文护栏。
- `add` 会拒绝包含 symlink 的 skill 目录,因为 symlink 目标不能作为库房内容被安全扫描。

## Web UI 安全

Web server:

- 只监听 `127.0.0.1`
- 支持可选 bearer token
- 校验 Host header 以降低 DNS rebinding 风险
- Web 下发固定使用 `secretMode: "env"`
- API 响应不返回密钥真值

## 已知边界

密钥检测是防御性能力,但不可能完美。低熵密码、自定义 token 格式或少见字段中的凭证仍需要人工审查。
涉及敏感配置时,请把 `--dry-run`、代码审查和仓库扫描纳入流程。

当前 `secret add <name> <value>` 会把真值作为 CLI 参数接收。在 hidden input 或 stdin 模式实现前,
请注意 shell history 风险。
