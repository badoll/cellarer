# 核心概念

[文档索引](../README.md) | [English](../en/concepts.md)

## 库房

库房是本机唯一真源。默认位于 `~/.cellarer`;也可以用 `CELLARER_HOME`
指向另一个库房。

典型结构:

```text
~/.cellarer/
├── store/
│   ├── rules/
│   ├── mcp/
│   └── skills/
├── config.json
├── state.json
└── secrets/
```

## 制品

制品是一个可分发单元:

- rule 文件或 rule 片段
- 一个 canonical MCP server 定义
- 一个 skill 目录

## Channel

Channel 用于给制品标记使用场景。常见例子是 `common` 与 `internal`。下发时可以按
一个 channel 过滤。

## Agent Adapter

适配器知道某个 agent 的 rules、MCP servers、skills 存放位置。基础适配器随包发布;
`config.json` 保存内置适配器的 key-based override,以及新增 agent 的自定义适配器。

## Scope

Scope 决定制品落点:

- `global`: agent 的家目录配置
- `project`: 通过 `--dir` 指定的项目目录

## Plan 与 Apply

下发被拆成两个阶段:

- plan: 计算动作与预览
- apply: 执行计划并写入台账

`--dry-run` 只返回 plan。

## 台账

`state.json` 记录已下发的 target、method、checksum、backup 和 secret refs。
`status` 与 `revert` 使用这份台账工作。

## 密钥

库房制品与生成文件不应包含明文密钥。制品应使用环境变量引用,例如
`${OPENAI_API_KEY}`,或 cellarer 密钥引用,例如
`${CELLARER_SECRET:OPENAI_API_KEY}`。

## 非目标

cellarer 不运行 MCP proxy,不提供云端 registry,不管理 agent 安装,也不提供多人服务端。
