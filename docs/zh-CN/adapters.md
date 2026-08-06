# 自定义适配器

[文档索引](../README.md) | [English](../en/adapters.md)

适配器描述某个 AI agent 的 rules、MCP servers 和 skills 存放位置。cellarer 随包发布内置适配器。
用户配置把内置 patch 与声明式自定义 adapter 分别保存在 `adapterOverrides` 和
`customAdapters`。

## 适配器位置

用户配置从以下位置加载:

- 库房配置: `~/.cellarer/config.json`
- 设置 `CELLARER_HOME` 时: `$CELLARER_HOME/config.json`

内置 adapter 使用 `cellarer agent configure|reset`;自定义 adapter 使用
`cellarer agent add|update|remove`。这些命令会验证 typed input,并通过带 revision 的
plan/receipt 修改配置,不需要手工编辑文件。`cellarer config show` 可查看解析后的用户配置。
对象 key 就是 adapter ID,adapter 对象内部不再重复写 `id`。

## 配置结构

`cellarer init --agent <ids>` 会在缺失时创建 `config.json`,但不会覆盖已有文件,并且只
启用精确指定的初始 adapter ID。适配器定制结构如下:

```json
{
  "version": 1,
  "defaults": {
    "method": "symlink",
    "collections": ["default"],
    "secretMode": "env"
  },
  "collections": {
    "default": {
      "description": "默认分组"
    }
  },
  "artifacts": {},
  "adapterOverrides": {
    "codex": {
      "enabled": true,
      "displayName": "Codex Local"
    }
  },
  "customAdapters": {
    "my-agent": {
      "displayName": "My Agent",
      "detect": {
        "global": ["~/.myagent"]
      },
      "rules": {
        "global": "~/.myagent/AGENTS.md",
        "project": "{dir}/.myagent/rules.md",
        "format": "markdown"
      },
      "mcp": {
        "global": "~/.myagent/mcp.json",
        "project": "{dir}/.myagent/mcp.json",
        "format": "json",
        "serversKey": "mcpServers",
        "supportedSecretReferences": ["environment", "cellarer"]
      },
      "skills": {
        "global": "~/.myagent/skills",
        "project": "{dir}/.myagent/skills",
        "format": "dir"
      },
      "capabilities": {
        "rules": ["global", "project"],
        "mcp": ["global", "project"],
        "skills": ["project"]
      }
    }
  }
}
```

`adapterOverrides["<built-in-id>"]` 是 patch。未指定字段继续继承 packaged built-in,
因此 package 更新仍能改善未覆盖字段;`enabled` 也位于这个映射。
`cellarer agent reset <built-in-id>` 会删除整个 override entry。

`customAdapters["<new-id>"]` 是完整声明式 adapter,必须至少声明 `rules`、`mcp` 或
`skills` 之一。自定义 MCP adapter 还必须声明
`supportedSecretReferences`,且只能列出目标自身能够消费的引用种类。选中内容包含
不支持的种类时,planning 会跳过该目标;空数组会阻止所有带密钥的 MCP 内容,而不是写入明文。

删除自定义 adapter 前先 disable,并 revert 所有 owned targets;否则 `agent remove` 会
返回精确依赖证据。

## 内置密钥引用兼容性

`supportedSecretReferences` 描述当前 adapter 实际输出的精确字节,不是 agent 在抽象意义上
能否使用环境变量。通用 renderer 会原样保留 `${ENV_VAR}`,不会把它翻译为另一种 token
dialect 或结构化环境变量 facility。

| 内置 adapter | 声明的支持 | 当前兼容边界 |
| --- | --- | --- |
| Claude Code | `environment` | 原生 MCP environment 配置会消费 renderer 输出的精确 `${VAR}` token。 |
| Gemini CLI | `environment` | 原生 MCP environment 配置会消费 renderer 输出的精确 `${VAR}` token。 |
| Codex | 无 | Codex 需要结构化 `env_vars` facility;当前尚未实现翻译。 |
| Cursor | 无 | 精确 `${VAR}` expansion 尚未进入 cellarer 已核验的当前 target contract。 |
| OpenCode | 无 | OpenCode 使用 `{env:NAME}`;当前尚未实现翻译。 |
| Windsurf | 无 | Windsurf 使用 `${env:NAME}`;当前尚未实现翻译。 |

当前没有任何内置 adapter 声明支持 `cellarer`。选中 MCP 内容使用目标声明之外的 reference
kind 时,planning 会 fail closed。因此在后续 adapter-specific renderer 实现并核验翻译之前,
Codex、Cursor、OpenCode 与 Windsurf 都会拒绝 `${ENV_VAR}`。

## 路径模板

| 模板 | 含义 |
| --- | --- |
| `~` 或 `~/...` | global scope 的 home 目录。 |
| `{dir}` | 通过 `--dir` 传入的项目根目录。 |
| 相对路径 | 相对当前受管根解析。 |

展开后的路径必须留在当前 scope 的受管根内。

## MCP 字段方言

适配器可以描述常见 MCP 结构差异:

```json
{
  "mcp": {
    "format": "json",
    "serversKey": "mcp",
    "supportedSecretReferences": ["environment"],
    "dialect": {
      "commandStyle": "array",
      "envKey": "environment",
      "urlKey": "serverUrl"
    }
  }
}
```

这些字段适用于把 command 参数存为数组、用 `environment` 代替 `env`,或用 `serverUrl`
表示 remote MCP server 的 agent。
字段形态 dialect 设置不会翻译密钥引用 token,也不能单独作为声明 `environment` 支持的依据。

## 示例

- [基础目录布局](../../examples/adapters/acme-agent.example.json)
- [MCP 字段方言](../../examples/adapters/quirky-agent.example.json)

## 配置不足时

当某个 agent 需要非平凡转换、多文件协调,或无法用路径加常见 JSON/TOML MCP 格式表达时,
优先扩展 schema 或共享 codec。内置 patch 只位于 `adapterOverrides`;新的声明式 agent
只位于 `customAdapters`。
