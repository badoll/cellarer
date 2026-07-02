# 架构

[文档索引](../README.md) | [English](../en/architecture.md)

cellarer 是 TypeScript monorepo,并遵守严格的 core-first 边界。

## 包职责

| 包 | 职责 |
| --- | --- |
| `@cellarer/core` | 库房、适配器、plan、apply、scan、status、revert、密钥处理。 |
| `@cellarer/cli` | 命令行参数解析与输出展示。 |
| `@cellarer/web` | 本地 Hono API 与 React Web 控制台。 |

CLI 与 Web 不实现业务逻辑。它们只解析输入、调用 core、展示结果。

## Core 边界

core 通过 `Env` 接收副作用:

- 文件系统
- home 目录
- 当前工作目录
- 平台
- 环境变量
- 时间
- 可选 secret store

这让 core 行为可测试,并避免业务逻辑直接读取 `process`、`os` 或 `node:fs`。

## 下发流程

```text
store artifacts
  -> select agents, scope, channels, capabilities
  -> load adapters and config
  -> render rules, MCP, and skills actions
  -> run secret guards
  -> preview plan or apply writes
  -> update state.json
```

rules 与 MCP 渲染为内容写入。skills 使用 link 或 copy。

## 扫描流程

```text
agent files
  -> adapter paths and codecs
  -> canonical artifacts
  -> secret redaction
  -> conflict policy
  -> store writes
```

`scanPlan` 只读。`applyScan` 写入库房。

## 适配器

适配器暴露路径、能力、探测逻辑和 codec。随包发布的内置适配器和用户 `adapters`
条目会解析为共享的 `AgentSpec` 形态,因此常见新布局不需要在引擎里加分支。

## MCP 模型

MCP server 被规范化为 canonical 模型:

- `stdio`
- `remote`
- `custom`

codec 负责 JSON/TOML 格式与字段方言,例如 `command[]`、`environment` 或 `serverUrl`。

## 安全不变量

- 业务逻辑在 core。
- 副作用经 `Env` 注入。
- 下发拆分为 plan/apply。
- 新 agent 通过适配器扩展。
- apply 幂等并写入台账。
- 明文密钥不得写入库房或生成产物。
