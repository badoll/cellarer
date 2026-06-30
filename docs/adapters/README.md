# 自定义适配器(声明式)编写指南

cellarer 支持用一份 TOML 声明一个全新 agent,无需改代码、无需等发版(kickoff §6.6)。
放置位置(后者覆盖前者同名 id):

- 全局:`~/.cellarer/adapters/<id>.toml`
- 工程:`<project>/.cellarer/adapters/<id>.toml`

加载时 zod 校验;非法配置跳过并告警,不影响其余适配器。本目录的 `*.example.toml` 可直接拷贝改用。

## 字段

```toml
id = "my-agent"                 # 必填,唯一
displayName = "My Agent"        # 可选,缺省用 id

[detect]                        # 可选:命中任一路径视为已安装(缺省回退到 rules/mcp/skills 路径父目录)
global = ["~/.myagent"]
project = [".myagent"]

[rules]                         # markdown:多 rule 片段 concat 写入
global = "~/.myagent/AGENTS.md"
project = "{dir}/.myagent/rules.md"
format = "markdown"

[mcp]
global = "~/.myagent/mcp.json"
project = "{dir}/.myagent/mcp.json"
format = "json"                 # json | toml
servers_key = "mcpServers"      # server 列表所在键(codex 用 mcp_servers,opencode 用 mcp)
merge_strategy = "merge"        # merge(默认)| overwrite
# 字段方言(可选,覆盖默认 command+args/env/url):
# command_style = "array"       # array:command[0]=cmd,command[1:]=args(opencode)
# env_key = "environment"       # env 字段名(opencode)
# url_key = "serverUrl"         # remote url 字段名(windsurf)

[skills]
global = "~/.myagent/skills"
project = "{dir}/.myagent/skills"
format = "dir"

# 能力声明(可选):未列出的 scope 下发时跳过并告警。
# 缺省从已声明的路径模板推断(声明了 rules.global 即视为支持 rules/global)。
capabilities = { rules = ["global", "project"], mcp = ["global", "project"], skills = ["project"] }
```

## 路径模板占位符

- `~` / `~/...` → 用户家目录。
- `{dir}` → 工程根(`--dir`)。

## 何时退回内置(代码)适配器

声明式覆盖「路径模板 + 常见格式(markdown/json/toml)+ servers_key + merge 策略 + 字段方言」。
若某 agent 需要非平凡转换(自定义编码、多源合并),退回内置代码适配器(`packages/core/src/adapters/builtin.ts`)。
