# CLI 参考

[文档索引](../README.md) | [English](../en/cli-reference.md)

源码构建后运行:

```bash
node packages/cli/dist/bin.js <command>
```

## `init`

初始化库房。

```bash
node packages/cli/dist/bin.js init
```

选项:

| 选项 | 说明 |
| --- | --- |
| `--global` | 为清晰度保留;当前默认就是初始化全局库房。 |

## `add <source>`

将本地 rules/MCP 文件或本地/GitHub skill 来源导入库房。

```bash
node packages/cli/dist/bin.js add ./my-rules.md
node packages/cli/dist/bin.js add ./server.json --force
node packages/cli/dist/bin.js add ./my-skill/
node packages/cli/dist/bin.js add vercel-labs/skills --list
node packages/cli/dist/bin.js add vercel-labs/skills --skill nextjs --channel public
node packages/cli/dist/bin.js add https://github.com/vercel-labs/skills/tree/main/skills/web-design-guidelines --json
```

选项:

| 选项 | 说明 |
| --- | --- |
| `--force` | 覆盖同名制品。 |
| `--list` | 只列出 skill candidates,不写库房。 |
| `--skill <name>` | 导入指定 skill,可重复传入。 |
| `--all` | 从 multi-skill source 导入所有 eligible skills。 |
| `--channel <name>` | 给导入制品打 channel 标签。`internal` 也会包含 internal skills。 |
| `--yes` | 跳过确认提示。当前 `add` 为非交互。 |
| `--json` | 输出 JSON candidate list 或 import report。 |

支持的来源:

| 来源 | 制品类型 |
| --- | --- |
| `.md` 文件 | rules |
| `.json` 文件 | MCP server |
| 本地 skill 目录或父目录 | skills |
| GitHub `owner/repo` | skills |
| GitHub repository URL | skills |
| GitHub `/tree/<ref>/<subpath>` URL | 该 subpath 下的 skills |

Skill 导入要求 `SKILL.md` frontmatter 包含 `name` 与 `description`。
`metadata.internal: true` 的 candidates 默认不会出现在普通 `--list`,也会被
`--all` 跳过;传入 `--channel internal` 才会包含它们。GitLab 与 arbitrary git
URLs 不属于 M2 导入面。

## `ls`

列出库房制品与 channel 标签。

```bash
node packages/cli/dist/bin.js ls
node packages/cli/dist/bin.js ls --channel internal
```

选项:

| 选项 | 说明 |
| --- | --- |
| `--channel <channel>` | 只显示某个 channel 可见的制品。 |

## `agents`

展示已注册 agent adapter、探测结果、当前 scope 支持的能力和目标路径。

```bash
node packages/cli/dist/bin.js agents
node packages/cli/dist/bin.js agents -a codex,claude-code --dir /path/to/project --json
```

选项:

| 选项 | 说明 |
| --- | --- |
| `-a, --agent <ids>` | 只展示这些逗号分隔的 agent id。 |
| `--dir <path>` | project scope 根目录。不传时为 global scope。 |
| `--json` | 输出机器可读结果。 |

## `doctor`

检查库房初始化、`config.json`、store 目录、adapter 加载、agent 探测和目标路径写权限,
且不会写入文件。

```bash
node packages/cli/dist/bin.js doctor
node packages/cli/dist/bin.js doctor -a codex --json
```

选项:

| 选项 | 说明 |
| --- | --- |
| `-a, --agent <ids>` | 只检查这些逗号分隔的 agent id。 |
| `--dir <path>` | project scope 根目录。不传时为 global scope。 |
| `--json` | 输出机器可读结果。 |

## `apply`

生成计划或写入制品到选中的 agent。

```bash
node packages/cli/dist/bin.js apply --dry-run --agent claude-code,codex
node packages/cli/dist/bin.js apply --agent claude-code,codex --dir /path/to/project --rules
```

选项:

| 选项 | 说明 |
| --- | --- |
| `-a, --agent <ids>` | 必填。逗号分隔的 agent id。 |
| `--dir <path>` | project scope 根目录。不传时为 global scope。 |
| `--channel <channel>` | 按 channel 过滤制品。 |
| `--rules` | 包含 rules。不传任何能力 flag 时默认包含全部能力。 |
| `--mcp` | 包含 MCP servers。 |
| `--skills` | 包含 skills。 |
| `--copy` | skills 优先 copy 而非 symlink。 |
| `--mcp-overwrite` | MCP server 组使用 overwrite,而非默认 merge。 |
| `--secret-mode <mode>` | `env`、`vault` 或 `keychain`。 |
| `--vault-passphrase <pp>` | `--secret-mode vault` 时使用的 vault 口令。 |
| `--dry-run` | 只打印计划,不写入。 |

## `scan`

读取 agent 原生配置,规范化后导入库房。

```bash
node packages/cli/dist/bin.js scan --agent codex --dry-run
node packages/cli/dist/bin.js scan --agent codex --into-channel common --conflict copy
```

选项:

| 选项 | 说明 |
| --- | --- |
| `-a, --agent <id>` | 必填。只能传一个 agent id。 |
| `--dir <path>` | project scope 根目录。不传时为 global scope。 |
| `--rules` | 只扫描 rules。 |
| `--mcp` | 只扫描 MCP servers。 |
| `--skills` | 只扫描 skills。 |
| `--into-channel <channel>` | 给导入制品打上该 channel。 |
| `--conflict <strategy>` | `keep-theirs`、`keep-mine` 或 `copy`。 |
| `--select <names>` | 逗号分隔的制品名白名单。 |
| `--dry-run` | 只展示候选项,不写入。 |
| `--json` | 输出 JSON。 |

## `status`

用文件系统状态检查 apply 台账。

```bash
node packages/cli/dist/bin.js status
node packages/cli/dist/bin.js status --agent codex --json
```

选项:

| 选项 | 说明 |
| --- | --- |
| `-a, --agent <ids>` | 按逗号分隔的 agent id 过滤。 |
| `--dir <path>` | 按 project 根目录过滤。 |
| `--json` | 输出机器可读结果。 |

## `revert`

回滚台账条目。

```bash
node packages/cli/dist/bin.js revert --agent codex
node packages/cli/dist/bin.js revert --all --dry-run
```

选项:

| 选项 | 说明 |
| --- | --- |
| `-a, --agent <ids>` | 按逗号分隔的 agent id 过滤。 |
| `--dir <path>` | 按 project 根目录过滤。 |
| `--all` | 不传其他选择器时,回滚全部必须显式使用。 |
| `--keep-backups` | 保留 `.bak` 备份。 |
| `--dry-run` | 预览回滚动作。 |

## `secret`

管理加密 vault。`ls` 永不打印真值。

```bash
node packages/cli/dist/bin.js secret add OPENAI_API_KEY "$OPENAI_API_KEY" --passphrase "$CELLARER_VAULT_PASSPHRASE"
node packages/cli/dist/bin.js secret ls --passphrase "$CELLARER_VAULT_PASSPHRASE"
node packages/cli/dist/bin.js secret rm OPENAI_API_KEY --passphrase "$CELLARER_VAULT_PASSPHRASE"
```

当前 `secret add <name> <value>` 会把真值作为命令参数传入。在 hidden prompt
或 stdin 模式实现前,请注意 shell history 风险。

## `ui`

启动本地 Web 控制台。

```bash
node packages/cli/dist/bin.js ui
node packages/cli/dist/bin.js ui --port 4317 --token local-token
```

选项:

| 选项 | 说明 |
| --- | --- |
| `--port <port>` | 端口,默认 `4317`。 |
| `--token <token>` | API 请求需要 `Authorization: Bearer <token>`。 |
