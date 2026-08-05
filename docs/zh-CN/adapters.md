# 自定义适配器

[文档索引](../README.md) | [English](../en/adapters.md)

适配器描述某个 AI agent 的 rules、MCP servers 和 skills 存放位置。cellarer 随包发布内置适配器。
用户配置只保存一个按 adapter id keyed 的 `adapters` 映射。

## 适配器位置

用户配置从以下位置加载:

- 库房配置: `~/.cellarer/config.json`
- 设置 `CELLARER_HOME` 时: `$CELLARER_HOME/config.json`

要修正内置适配器,写 `adapters["<built-in-id>"]`。要新增 agent,写
`adapters["<new-id>"]`。对象 key 就是 adapter id,adapter 对象内部不再重复写 `id`。

## 配置结构

`cellarer init` 会在缺失时创建 `config.json`,但不会覆盖已有文件。适配器定制结构如下:

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
  "agents": {},
  "adapters": {
    "claude-code": {
      "detect": {
        "global": ["~/Library/Application Support/Claude"]
      },
      "rules": {
        "global": "~/Library/Application Support/Claude/CLAUDE.md"
      },
      "mcp": {
        "global": "~/Library/Application Support/Claude/mcp.json"
      },
      "skills": {
        "global": "~/Library/Application Support/Claude/skills"
      }
    },
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

当 key 命中随包发布的内置适配器时,这个值就是 patch。没有写出的字段继续继承内置适配器,
所以版本升级时仍能拿到未覆盖字段的修正。Web UI 编辑内置适配器时,应只保存
`adapters["<built-in-id>"]`;重置默认值时删除这个 key。

当 key 没有命中内置适配器时,这个值就是自定义 adapter 定义,并且必须至少声明
`rules`、`mcp` 或 `skills` 之一。自定义 MCP adapter 还必须声明
`supportedSecretReferences`,且只能列出目标自身能够消费的引用种类。选中内容包含
不支持的种类时,planning 会跳过该目标;空数组会阻止所有带密钥的 MCP 内容,而不是写入明文。

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
优先扩展 schema 或共享 codec。内置适配器改动和新增 agent 条目都放在 `adapters`;
由 key 决定这个条目是在 patch 内置适配器,还是在定义自定义适配器。
