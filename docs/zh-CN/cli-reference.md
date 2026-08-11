# CLI 参考

[文档索引](../README.md) | [English](../en/cli-reference.md)

源码构建后运行:

```bash
node packages/cli/dist/bin.js <command>
```

## 机器协议

所有已注册命令都使用 CLI protocol `1.0`,并接受同一组全局 transport 选项:

| 选项 | 说明 |
| --- | --- |
| `--output text\|json\|jsonl` | 选择人类文本、单个 terminal JSON envelope 或逐行 protocol records。默认 `text`。 |
| `--non-interactive` | 禁止 prompt;缺少必需输入或确认时返回 `INPUT_REQUIRED`。 |
| `--input <path\|->` | 从文件或 stdin (`-`) 读取版本化 command request,在调用 Core 前完成校验。 |

脚本应把全局选项放在命令前。`--output json`、`--output jsonl`、`--input -`
以及非 TTY 调用都会隐含 non-interactive。旧的命令级 `--json` 保留为
`--output json` 的兼容别名;显式 `--output` 优先。新自动化应使用适用于全部已注册命令的
`--output`。

### 结构化输入

命令仍保留在 argv 中,以便审计路由。Request 会重复该 identity,并把命令领域字段放在
`input` 下:

```json
{
  "protocolVersion": "1.0",
  "command": "status",
  "requestId": "ci:status:42",
  "input": {
    "agents": ["codex"],
    "dir": "/workspace/project"
  }
}
```

```bash
node packages/cli/dist/bin.js --output json --input request.json status
node packages/cli/dist/bin.js --output json --input - status < request.json
```

Request 必须通过该命令公布的 input schema。同一领域字段不能同时出现在 argv 与
`input`;重复会在调用 Core 前返回 `INPUT_AMBIGUITY`。`--output` 等 transport flags
仍放在 argv 中。密钥真值与口令不得进入 request JSON;应使用 `--stdin`、继承的 `--fd`
或命令专用的受保护 passphrase/token FD。

### JSON 结果与 JSONL 完成语义

JSON mode 只向 stdout 写一个紧凑 terminal envelope:

```json
{
  "protocolVersion": "1.0",
  "command": "status",
  "requestId": "req-...",
  "status": "success",
  "data": { "items": [] },
  "warnings": []
}
```

Handled failure 使用同一 envelope,但 `status` 为 `"error"`,并包含 typed `error`。
可选 `data` 仍由命令定义。在 `json`/`jsonl` mode 中,stdout 只能包含 protocol records,
不能出现 prompt、颜色、spinner、banner 或诊断;脱敏诊断写入 stderr。

公布 `streaming: true` 的命令(`apply`、`scan`、`revert`)可在结果前输出 JSONL event
envelopes。stdout 每个非空行都是完整 JSON object;event `sequence` 从 1 开始,最后一行
必须是且只能有一个 terminal result envelope。若 stream 结束时没有 terminal record,
应判定为 transport-interrupted,不能视为成功。非 streaming 命令选择
`--output jsonl` 时只输出 terminal 行。

### Exit classes 与稳定错误

自动化应按稳定的 `error.code` 分支;本地化 `message` 只供人阅读。Exit code 只做粗粒度
分类:

| Exit | 含义 | Error codes |
| ---: | --- | --- |
| `0` | 成功 | — |
| `2` | Usage、input schema、歧义或缺少输入 | `INVALID_USAGE`、`INVALID_INPUT`、`INPUT_REQUIRED`、`INPUT_AMBIGUITY` |
| `3` | Policy 或 domain validation | `POLICY_VIOLATION`、`DOMAIN_VALIDATION_FAILED` |
| `4` | 并发或前置条件冲突 | `STALE_REVISION`、`LOCK_CONFLICT`、`TARGET_CONFLICT` |
| `5` | Execution 或 partial failure | `EXECUTION_FAILED`、`PARTIAL_FAILURE` |
| `6` | 需要人工 recovery | `RECOVERY_REQUIRED` |
| `70` | 未预期内部失败;细节会脱敏 | `INTERNAL_ERROR` |

### Capability 与 schema discovery

Discovery 完全在本地完成,不需要网络:

```bash
node packages/cli/dist/bin.js --output json capabilities
node packages/cli/dist/bin.js --output json schema
node packages/cli/dist/bin.js --output json schema \
  urn:cellarer:cli:protocol:1.0:command:status:output
```

`capabilities` 返回支持的 protocol versions,以及每个命令的 mutability、streaming、
input/output schema ID、可选 event schema ID 与 required features。
`schema [schema-id]` 会在 terminal envelope 的 `data` 中返回选定 JSON Schema;省略 ID 时
返回确定性的本地 bundle。应从 `capabilities` 取得 schema IDs,不要自行拼接。
`--version` 来自已安装 CLI package metadata。

## `init`

通过已签名的 mutation journal 初始化库房。产品目录与 `config.json` 都会取得 action
receipt,`config.json` 使用原子发布;成功会推进 store revision,并输出 operation id 与
结果 revision。若已有并发 mutation 或 recovery claim,命令至多创建幂等的协议骨架,
不会创建产品目录或 config。

进入 Core 初始化前,`init` 会加载 Store 范围的 mutation authority。若 keychain 条目不
存在,`init` 会在操作系统 credential manager 中生成随机 256-bit key,并进行精确回读
校验。其他命令不会 provision 或隐式轮换缺失的 authority。Headless 系统必须由 runner
注入下述受保护环境通道。

`init` 会预览 supported/detected/configured agent,但绝不会把所有 detected agent
隐式变成 mutation target。当前源码 CLI 在 human 与 machine 调用中都要求显式提供
精确初始 target 集合:

```bash
node packages/cli/dist/bin.js init --agent codex,claude-code
```

选项:

| 选项 | 说明 |
| --- | --- |
| `--global` | 为清晰度保留;当前默认就是初始化全局库房。 |
| `-a, --agent <ids>` | 必填的精确 adapter ID 列表,以逗号分隔。初始配置只启用这些 agent。 |

省略 `--agent` 会返回带 agent inventory 的 `INPUT_REQUIRED`,且不创建产品配置。
未知 ID 返回 `INVALID_INPUT`;不存在“全部 detected agents”的隐式 mutation 默认值。

## Mutation authority 与 headless 运行

可执行 planning、mutation 和自动 recovery 都要求持久、Store 范围的 authority。本地
默认 backend 是操作系统 credential manager。key 不会写入 `CELLARER_HOME`、配置、
plan、journal、日志或命令输出。provider 不可用时,`ls`、`agents`、`status`、
`doctor`、`secret ls`、`add --list` 等只读命令仍可使用,但它们不会把 unsigned state
当成可执行 authority。

Authority credential 使用保留的 credential-manager service
`dev.cellarer.mutation-authority.v1`,以及以
`__cellarer_internal__:mutation-authority:v1:` 开头的内部 accounts。普通密钥的创建、
读取、更新与删除路径会在调用 credential provider 前拒绝任一保留 namespace;该内部
account grammar 也不是合法的 `${CELLARER_SECRET:name}`。不要通过 `cellarer secret` 或
通用 credential 管理脚本检查、编辑或删除这些 entries。

Headless/CI runner 只有一个替代通道:

```text
CELLARER_MUTATION_AUTHORITY=v1:<正整数-epoch>:<43-字符-无填充-base64url-key>
```

解码后的 key 必须恰好为 32 bytes。请通过 runner 的受保护 environment/secret facility
设置它;不要把字面量赋值写入脚本、命令参数、JSON 请求、配置文件、Store 文件、日志、
stdout 或 stderr。显式存在但 malformed 的值会 fail closed,绝不会回退到 keychain。
同一 master value 仍会在密码学上绑定 normalized Store root。

加载 authority 前,CLI 会通过注入的 `realpath` 边界解析请求的 Store。同一物理 Store 的
relative、symlink 与文件系统 case alias 因此共用 credential account、headless owner、
Core/Web scope、seal、journal 与 lock。只有 `init` 会在 canonicalization 前创建缺失的
Store root。

Headless mutation-capable 进程还会为该 Store 获取由 kernel 持有的 lifetime lease:它只在
`127.0.0.1` 上独占监听由 Store scope 确定性得到的本地 port,不会连接现有占用者,并对
listener 执行 unref,因此不会阻止命令退出。lease 存活时,第二个进程会 fail closed,即使它
配置了更新 epoch。进程退出时 kernel 自动释放 lease;下一进程必须先取得 lease 才能
planning。删除、替换或重放任何 Store 文件都不能改变 currentness;无关本地 listener 或
确定性 port collision 也会 fail closed。不要让多个 headless mutation-capable 进程并发使用
同一个 Store。

authority 加载失败时,应恢复已有 credential manager 的访问能力,或恢复完全相同的受保护
headless value 后重试。不要删除 active journal,也不要用 provision 新 authority 作为
recovery 捷径。Unsigned records、来自其他 Store root 的 records,以及 unknown/old epoch
records 属于 breaking change:它们只能显式人工处理,不会通过 legacy compatibility 接受。

首次 provisioning 与 rotation 由 Store 范围的 authority coordination boundary 串行化。
Rotation 还会排除 mutation/recovery,且任意 active journal 存在时都会拒绝。可执行
operation 会在 canonical replanning 前、持有 authority lease 时以及 Store mutation lock
内再次检查当前 epoch。因此,长期运行的 CLI 或 Web 进程若持有 stale epoch,在 rotation
先取得串行顺序后不能观察产品状态或执行外部 effect。

每次持久 journal publication 还会在 credential manager 中保存只含
`{ operationId, sequence, seal }` 的受保护 replay tip。自动 recovery 要求 active journal
与该 tip 精确匹配;tip 缺失、不可读、过期或不匹配时,在 claim、credential provider、
产品状态观察或 compensation 之前就转为 manual-only。Headless authority 只在观察到该
publication 的当前进程中保存 tip。即使重启后恢复完全相同的
`CELLARER_MUTATION_AUTHORITY`,只要存在 active journal,recovery 仍是 manual-only。

## `add <source>`

将本地 rules/MCP 文件或本地/GitHub skill 来源导入库房。

```bash
node packages/cli/dist/bin.js add ./my-rules.md
node packages/cli/dist/bin.js add ./server.json --force
node packages/cli/dist/bin.js add ./my-skill/
node packages/cli/dist/bin.js add vercel-labs/skills --list
node packages/cli/dist/bin.js add vercel-labs/skills --skill nextjs --collection public
node packages/cli/dist/bin.js --output json add https://github.com/vercel-labs/skills/tree/main/skills/web-design-guidelines
```

普通单文件 Rule/MCP import 使用可移植的 no-follow identity handshake,在 Windows 上仍可用。
递归 Skill snapshot 使用独立的 dependency-free Node boundary,以 no-follow open 与稳定
file/directory identity 检查保护。递归 traversal 当前支持 Darwin/Linux x64/arm64;其他
platform/architecture 组合会在读取或复制目录内容前返回 unsupported unsafe-source,不会
退化为按路径递归 copy。

选项:

| 选项 | 说明 |
| --- | --- |
| `--force` | 覆盖同名资源。 |
| `--list` | 只列出 skill candidates,不写库房。 |
| `--skill <name>` | 导入指定 skill,可重复传入。 |
| `--all` | 从 multi-skill source 导入所有 eligible skills。 |
| `--collection <name>` | 给导入资源打 collection 标签。`internal` 也会包含 internal skills。 |
| `--yes` | 跳过确认提示。当前 `add` 为非交互。 |
| `--json` | `--output json` 的兼容别名;command data 包含 candidate list 或 import report。 |

支持的来源:

| 来源 | 资源类型 |
| --- | --- |
| `.md` 文件 | rules |
| `.json` 文件 | MCP server |
| 本地 skill 目录或父目录 | skills |
| GitHub `owner/repo` | skills |
| GitHub repository URL | skills |
| GitHub `/tree/<ref>/<subpath>` URL | 该 subpath 下的 skills |

Skill 导入要求 `SKILL.md` frontmatter 包含 `name` 与 `description`。
`metadata.internal: true` 的 candidates 默认不会出现在普通 `--list`,也会被
`--all` 跳过;传入 `--collection internal` 才会包含它们。GitLab 与 arbitrary git
URLs 不属于 M2 导入面。

## `ls`

列出库房资源与 collection 标签。

```bash
node packages/cli/dist/bin.js ls
node packages/cli/dist/bin.js ls --collection default
```

选项:

| 选项 | 说明 |
| --- | --- |
| `--collection <collection>` | 只显示某个 collection 可见的资源。 |

## `agents`

展示已注册 agent adapter、探测结果、当前 scope 支持的能力和目标路径。

```bash
node packages/cli/dist/bin.js agents
node packages/cli/dist/bin.js --output json agents -a codex,claude-code --dir /path/to/project
```

选项:

| 选项 | 说明 |
| --- | --- |
| `-a, --agent <ids>` | 只展示这些逗号分隔的 agent id。 |
| `--dir <path>` | project scope 根目录。不传时为 global scope。 |
| `--json` | `--output json` 的兼容别名。 |

`agents` 是早期检查命令。完整 control-plane 使用下面的单数 `agent` 命令组。

## Resource、agent、collection 与 config control plane

这些命令与重叠的 Web routes 调用相同 Core DTO/service。只读命令不需要 mutation
authority。Control-plane `--dry-run` 返回 `{ plan, changedFields }` 且不写入。直接执行
同一 mutation 返回 `{ plan, changedFields, receipt }`;把 sealed plan 交给
`apply --plan` 后,成功时返回 `{ plan, changedFields, mutation, receipt }`。

每个 `agent`、自定义 adapter、`collection` 与 `config` mutation 都支持精确的
dry-run→apply round trip。从 JSON envelope 取出完整 `data.plan` 对象,将原字节提交给
`apply --plan`:

```bash
PLAN_JSON=$(node packages/cli/dist/bin.js --output json \
  agent disable codex --dry-run | \
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).data.plan)))')
node packages/cli/dist/bin.js --output jsonl apply --plan "$PLAN_JSON"
```

相同模式适用于 `agent add|update|remove`、collection members/defaults 与
`config update|reset`。`apply` 消费 exact authority-sealed plan,不会 replan。revision、
target、config、ownership ledger 或 artifact membership 变化都会返回 typed conflict,
且没有 receipt。Settings plan 内自包含的 publication data 只能是 reference-safe config
bytes,写入前还会再次经过 final secret guard。

### `resource list|show`

```bash
node packages/cli/dist/bin.js resource list --kind rules --state managed \
  --source /absolute/path/to/rules.md --no-include-discovered
node packages/cli/dist/bin.js resource show rules/team-rules
```

`resource list` 支持 `--kind <rules|mcp|skills>`、逗号分隔的 `--state`、精确且
逗号分隔的 `--source`、`--agent`、`--collection`、
`--destination <user|project>`、`--dir` 与 `--no-include-discovered`。
`resource show` 支持相同查询选项,并要求一个类似 `rules/team-rules` 的不可变 resource
ID。单独 name 只能用于只读过滤,绝不能作为 mutation identity。

### 资源生命周期

生命周期 mutation 始终使用不可变 resource ID。创建 mutation plan 前先检查依赖和
source evidence:

```bash
node packages/cli/dist/bin.js resource dependencies rules/team-rules
node packages/cli/dist/bin.js resource check rules/team-rules
node packages/cli/dist/bin.js --output json resource rename \
  rules/team-rules team-rules-v2 --dry-run
node packages/cli/dist/bin.js --output json resource remove \
  rules/team-rules --cascade --dry-run
node packages/cli/dist/bin.js --output json resource export \
  rules/team-rules /tmp/team-rules.cellarer.json --dry-run
node packages/cli/dist/bin.js --output json resource import \
  /tmp/team-rules.cellarer.json --dry-run
```

`resource check` 只读。Local snapshot 仍可使用,但会返回 `uncheckable` 和
`no-verifiable-remote-source`;cellarer 不会为 legacy 内容虚构远程 provenance。内置 CLI
只会在显式执行 `resource check` 或 `resource update` 时调用网络或 Git。Git evidence
绑定完整 repository URL、ref、resolved commit 与 subpath;staging 会 checkout 该 ref,
若 commit 已移动则拒绝。URL check 拒绝 redirect,绑定 content integrity 与可用的
ETag/Last-Modified validators;staging 使用这些 validators 做条件请求,然后再次验证
integrity。支持 direct file 与仅包含普通文件/目录的安全 tar archive;不安全 archive
entry 会 fail closed。Lifecycle error 不复制 source URL、命令 stderr 或 response body。

`resource update <id> --dry-run` 会 check、私有 staging、
validate、scan,并返回绑定候选内容的 update plan。再以
`--plan '<data.plan JSON>'` 应用该 exact staged revision 到 Store。Store update 不会下发
agent targets;下发必须另建 sync plan。

各生命周期 verb 有意保持分离:

- `resource remove` 只在精确依赖检查后删除 Store 内容。
- `sync uninstall` 只删除 profile 选中的 intact owned targets,保留 profile 和 Store
  resources。
- `revert` 恢复历史 target operation 记录的 before-state。
- `resource rename` 对可编辑 metadata 保留不可变 ID;source-defined identity 会变化时
  必须显式使用 `--local-fork`。
- `resource export` 生成可验证的 reference-only bundle,不包含 vault values、绝对本机
  路径、journals、snapshots 或 ownership records。

### `profile` 与基于 profile 的 `sync`

Profile 保存精确 agent IDs、resource/collection IDs、capabilities、scope、placement
method 与 merge policy。它绝不保存 secrets、绝对 project paths 或持久化的
force/drift acknowledgements。

```bash
node packages/cli/dist/bin.js profile create project-team --desired \
  '{"agentIds":["codex","claude-code"],"scope":"project","resourceIds":["rules/team-rules"],"collectionIds":[],"capabilities":["rules"],"method":"copy","mergePolicy":"merge"}'
node packages/cli/dist/bin.js profile list
node packages/cli/dist/bin.js profile show project-team
node packages/cli/dist/bin.js --output json sync plan project-team \
  --workspace-root /workspace/app
node packages/cli/dist/bin.js --output json sync apply project-team \
  --workspace-root /workspace/app --plan '<data.mutationPlan JSON>'
node packages/cli/dist/bin.js sync verify project-team \
  --workspace-root /workspace/app
node packages/cli/dist/bin.js --output json sync uninstall project-team \
  --workspace-root /workspace/app --dry-run
```

用 `profile update <id> --desired '<JSON>'` 替换 desired state,用
`profile delete <id> [--dry-run]` 删除 profile 文档。Project-scoped profile 的每次
`sync plan|apply|verify|uninstall` 调用都必须显式传入
`--workspace-root <absolute-path>`;不会静默使用 process working directory。
`--replace-unowned`、`--override-drift` 与 uninstall `--acknowledge` tokens 都只属于
当前 invocation 并绑定 plan,不会持久化到 profile。

### `agent list|show|enable|disable|configure|reset|add|update|remove`

```bash
node packages/cli/dist/bin.js agent list --scope project --dir /workspace/app \
  --agent codex,claude-code
node packages/cli/dist/bin.js agent show codex --scope global
node packages/cli/dist/bin.js agent disable codex --dry-run
node packages/cli/dist/bin.js agent configure codex \
  --adapter '{"displayName":"Codex Local"}'
node packages/cli/dist/bin.js agent add my-agent \
  --adapter '{"displayName":"My Agent","rules":{"project":"{dir}/.my-agent/RULES.md"}}'
node packages/cli/dist/bin.js agent update my-agent \
  --adapter '{"displayName":"My Agent","rules":{"global":"~/.my-agent/RULES.md"}}'
node packages/cli/dist/bin.js agent remove my-agent
```

`list` 与 `show` 报告 supported、detected、configured、enabled、detection evidence、
capability scopes、target paths 与 validation issues。`configure`、`reset` 只用于随包
发布的内置 adapter,并且只持久化到 `adapterOverrides`;`add`、`update`、`remove` 管理
`customAdapters`。仍有 owned target 或 enabled desired selection 依赖时,自定义 adapter
删除会被阻止。每个 mutation 都支持 `--dry-run`。

### `collection list|show|create|update|delete|members set|defaults set`

```bash
node packages/cli/dist/bin.js collection create work \
  --description "工作资源" --resource rules/team-rules,skills/review
node packages/cli/dist/bin.js collection members set work \
  --resource rules/team-rules
node packages/cli/dist/bin.js collection defaults set --collection default,work
node packages/cli/dist/bin.js collection show work
```

Collection membership 只接受不可变 ID。用 `members set --resource ""` 清空成员。
`update` 要求 `--description`;collection 仍位于 `defaults.collections` 时 `delete` 会被
阻止。所有 mutation 都支持 `--dry-run`。

### `config show|validate|update|reset`

```bash
node packages/cli/dist/bin.js config show
node packages/cli/dist/bin.js config validate \
  --config '{"version":1,"defaults":{"method":"copy"}}'
node packages/cli/dist/bin.js config update \
  --settings '{"method":"copy","secretMode":"env"}'
node packages/cli/dist/bin.js config reset --field method,secretMode
```

`config update` 只接受 typed non-secret defaults:`method`、`secretMode` 与 `os` 下
各平台的 `method`。`config reset` 接受 `method`、`secretMode`、`os`;省略 `--field`
会重置三者。未知或 secret-shaped 字段返回 `INVALID_INPUT`,且不写入。

### `diff`、`verify`、`discovery summary` 与 `operation list|show|recover`

```bash
node packages/cli/dist/bin.js diff --scope project --dir /workspace/app \
  --agent codex,claude-code --collection work --rules --method copy
node packages/cli/dist/bin.js verify --scope project --dir /workspace/app \
  --agent codex,claude-code --collection work --rules --method copy
node packages/cli/dist/bin.js discovery summary --destination project \
  --dir /workspace/app --agent codex,claude-code
node packages/cli/dist/bin.js operation list --limit 20
node packages/cli/dist/bin.js operation show operation-<id>
node packages/cli/dist/bin.js --output json operation recover operation-<id> --dry-run
node packages/cli/dist/bin.js --output json operation recover operation-<id>
```

`diff` 报告 desired-versus-applied actions;`verify` 还会分离 disk drift、secret-
reference readiness 与 recovery health。验证命令支持 `--scope`、`--dir`、`--agent`、
`--collection`、`--rules`、`--mcp`、`--skills`、
`--method <symlink|copy>` 与 `--mcp-strategy <merge|overwrite>`。Operation 输出始终脱敏。
始终先运行 `operation recover <id> --dry-run` 诊断。只有诊断允许 evidence-based recovery
时才去掉 `--dry-run`。`RECOVERY_REQUIRED` 会返回 typed recovery evidence;不要手动删除
lock 或 journal。

## `doctor`

检查库房初始化、`config.json`、store 目录、adapter 加载、agent 探测、目标路径写权限
与 mutation recovery evidence,且不会写入文件。

```bash
node packages/cli/dist/bin.js doctor
node packages/cli/dist/bin.js --output json doctor -a codex
```

选项:

| 选项 | 说明 |
| --- | --- |
| `-a, --agent <ids>` | 只检查这些逗号分隔的 agent id。 |
| `--dir <path>` | project scope 根目录。不传时为 global scope。 |
| `--json` | `--output json` 的兼容别名。 |

JSON 报告包含 `mutationRecovery`。`clean` 表示没有未完成 operation;
`incomplete` 与 `manual-recovery-required` 会包含 typed error 和 operation evidence。
`doctor` 只诊断,不修复 operation。不要手动删除旧 lock;请按[核心概念](concepts.md#并发与中断-operation-恢复)
中基于 evidence 的流程处理。

## `apply`

生成计划或写入资源到选中的 agent。

```bash
node packages/cli/dist/bin.js --output json plan \
  --agent claude-code,codex --scope global --rules --mcp --skills
node packages/cli/dist/bin.js apply --agent claude-code,codex --collection default
node packages/cli/dist/bin.js --output json apply --dry-run --agent claude-code --rules
node packages/cli/dist/bin.js --output jsonl apply --plan "$PLAN_JSON"
```

选项:

| 选项 | 说明 |
| --- | --- |
| `-a, --agent <ids>` | 仅当 `apply` 从这些选项 planning 时必填（包括 `--dry-run`）;`apply --plan` 已由 sealed plan 绑定 target,不需要此项。 |
| `--plan <json>` | 应用 `plan` 或 control-plane mutation dry-run 返回的 exact authority-sealed `data.plan`;不能与 planning inputs 或 `--dry-run` 同用。 |
| `--dir <path>` | project scope 根目录。不传时为 global scope。 |
| `--collection <collection>` | 按 collection 过滤资源。 |
| `--rules` | 包含 rules。交互式 text 与 dry-run 可默认包含全部能力;non-interactive 写入至少需要一个显式 capability flag。 |
| `--mcp` | 包含 MCP servers。 |
| `--skills` | 包含 skills。 |
| `--copy` | skills 优先 copy 而非 symlink。 |
| `--mcp-overwrite` | MCP server 组使用 overwrite,而非默认 merge。 |
| `--secret-mode <mode>` | `env`、`vault` 或 `keychain`。 |
| `--vault-passphrase-fd <number>` | 从编号不小于 3 的继承描述符读取 vault 口令;否则使用终端隐藏输入。 |
| `--replace-unowned <tokens>` | `plan.conflicts` 返回的逗号分隔精确 replacement tokens。 |
| `--override-drift <tokens>` | `plan.conflicts` 返回的逗号分隔精确 drift override tokens。 |
| `--snapshot-passphrase-fd <number>` | 从继承描述符读取 replacement snapshot 口令;否则使用终端隐藏输入。 |
| `--dry-run` | 只打印计划,不写入。 |
| `--json` | `--output json` 的兼容别名;command data 包含 Core plan/result、mutation identity 或 receipt、conflicts 与 acknowledgement tokens。 |

未确认的 ownership conflict 会阻止 apply 并以非零状态退出。先检查 JSON dry-run,再用相同选择
重试:把精确 token 放入 `--replace-unowned` 或 `--override-drift`,并提供
`--snapshot-passphrase-fd` 或终端隐藏输入提供 snapshot 口令。

顶层 `plan` 命令是 resource distribution 的可序列化 planning surface;JSON envelope
中的 `data.plan` 是 exact executable plan,`data.preview` 是便于阅读的 distribution
preview。`apply --dry-run` 仍是便捷 preview。`apply --plan` 同时接受这类 distribution
preview,返回 `{ plan: <distribution-preview>, entries: [], failures: [], mutation }`,其中
`mutation` 没有 result 或 receipt。实际执行 distribution apply 时顶层字段相同,receipt
位于 `mutation.result.receipt`。`apply --plan` 同时接受这类 distribution plan 与任意
agent/adapter/collection/config `--dry-run` 返回的 `operation: "settings"`
plan。Structured input 把同一个 plan 对象放入 `input.plan`;不要同时提交 agents、
capabilities、`dir`、acknowledgements 或 `dryRun`。

Distribution apply 与 settings `apply --plan` 响应包含 `mutation.planId`、
`planDigest`、`operation` 和 `baseRevision`。成功 receipt 包含 operation id、resulting
revision、outcome 和逐 action receipts;直接 control-plane mutation 则把 receipt 放在
顶层 `data.receipt`。
Public envelope 会把 Core conflicts 映射为稳定 CLI errors,例如 `LOCK_CONFLICT`、
`STALE_REVISION`、`TARGET_CONFLICT` 与 `RECOVERY_REQUIRED`;原始 Core code 保留在脱敏
error details 中。这些失败会以非零状态退出,且不执行未授权的 target write。

## `scan`

读取 agent 原生配置,规范化后导入库房。

```bash
node packages/cli/dist/bin.js scan --agent codex --dry-run
node packages/cli/dist/bin.js scan --agent codex --rules --into-collection default \
  --select '[{"kind":"rules","name":"team","source":"/absolute/path/AGENTS.md"}]'
```

选项:

| 选项 | 说明 |
| --- | --- |
| `-a, --agent <id>` | 必填。只能传一个 agent id。 |
| `--dir <path>` | project scope 根目录。不传时为 global scope。 |
| `--rules` | 只扫描 rules。 |
| `--mcp` | 只扫描 MCP servers。 |
| `--skills` | 只扫描 skills。 |
| `--into-collection <collection>` | 给导入资源打上该 collection。 |
| `--conflict <strategy>` | `keep-theirs`、`keep-mine` 或 `copy`。 |
| `--select <json>` | 完整 `{kind,name,source}` selector 的 JSON 数组;每个对象必须且只能包含这三个字段。 |
| `--secret-mode <mode>` | Mutating import 的密钥来源:`env`、`vault` 或 `keychain`。只读 dry-run 始终使用 `env`,会忽略该选择。 |
| `--vault-passphrase-fd <number>` | Vault-backed mutating import 从继承描述符读取 vault 口令。 |
| `--keychain-service <name>` | Keychain-backed mutating import 使用的 service;默认 `cellarer`。 |
| `--dry-run` | 只展示候选项,不写入。 |
| `--json` | `--output json` 的兼容别名。 |

`scan --dry-run` 是不能提交到 execution API 的纯只读 preview。它不会 provision、load
或 query mutation authority/secret credentials;即使请求 vault 或 keychain,也始终按
environment-reference mode 扫描。非 dry-run import 仍是 executable mutation,必须有
authority。Non-interactive 写入还要求一个显式 agent 与至少一个 capability flag;dry-run
必须指定 agent,但未传 capability flag 时可检查全部能力。

不支持 name-only mutation selection。先从 dry-run item 复制精确 `kind`、`name`、
`source` 到 `--select`,也可在 structured input 中提供同一数组。Store 内 collection
命令使用 `rules/team` 这类不可变 ID,而不是 scan tuple。

## `status`

检查已 apply 状态。传入 `--agent` 时,会分别验证 desired-versus-applied 与
applied-versus-disk,并包含 mutation recovery health。

```bash
node packages/cli/dist/bin.js status
node packages/cli/dist/bin.js --output json status --agent codex
```

选项:

| 选项 | 说明 |
| --- | --- |
| `-a, --agent <ids>` | 按逗号分隔的 agent id 过滤。 |
| `--dir <path>` | 按 project 根目录过滤。 |
| `--json` | `--output json` 的兼容别名。 |

`--output json status --agent <ids>` 返回 `verification.desiredVsApplied`、
`verification.appliedVsDisk`、`verification.recovery` 和 `verification.healthy`。
不传 `--agent` 时,命令只返回 ledger-versus-disk `items`,不表示完整 verification
health。

## `revert`

回滚台账条目。

```bash
node packages/cli/dist/bin.js --output json revert --agent codex --dry-run
node packages/cli/dist/bin.js revert --agent codex --acknowledge "$ACK_TOKEN" --snapshot-passphrase-fd 3 3< "$CELLARER_SNAPSHOT_PASSPHRASE_FILE"
```

务必先检查 dry-run plan。若 target 在 apply 后发生漂移,把它返回的精确 acknowledgement
token 放入 `ACK_TOKEN`。存在加密 before-state snapshot 的 target 还需要原始 snapshot
passphrase。

选项:

| 选项 | 说明 |
| --- | --- |
| `-a, --agent <ids>` | 按逗号分隔的 agent id 过滤。 |
| `--dir <path>` | 按 project 根目录过滤。 |
| `--all` | 不传其他选择器时,回滚全部必须显式使用。 |
| `--keep-backups` | 请求保留备份。当前不支持按路径自动删除,因此无论是否传入都会保留加密 snapshot。 |
| `--acknowledge <tokens>` | 逗号分隔的精确 drift tokens,由 dry-run plan 返回。 |
| `--snapshot-passphrase-fd <number>` | 从继承描述符读取 snapshot passphrase;需要 acknowledgement 且未传 FD 时使用终端隐藏输入。 |
| `--dry-run` | 预览回滚动作。 |
| `--json` | `--output json` 的兼容别名;command data 包含 Core revert plan/result 与 mutation identity 或 receipt。 |

Revert 与 apply 使用相同的 store lock、immutable plan 校验、journal、revision 和
operation receipt 边界。Dry-run 没有 mutation result;成功写入后会返回
`mutation.result.receipt`。

## `secret`

管理加密 vault。`ls` 永不打印真值。

```bash
# 人类:分别隐藏输入密钥真值和 vault 口令。
node packages/cli/dist/bin.js secret add OPENAI_API_KEY

# Agent:受保护密钥通道与独立的 vault 口令继承描述符。
node packages/cli/dist/bin.js secret add OPENAI_API_KEY --stdin --passphrase-fd 3 3< "$CELLARER_VAULT_PASSPHRASE_FILE" < "$CELLARER_SECRET_INPUT_FILE"
node packages/cli/dist/bin.js secret add OPENAI_API_KEY --fd 4 --passphrase-fd 3 3< "$CELLARER_VAULT_PASSPHRASE_FILE" 4< "$CELLARER_SECRET_INPUT_FILE"

node packages/cli/dist/bin.js secret ls
node packages/cli/dist/bin.js secret rm OPENAI_API_KEY
```

`secret add` 的位置参数只有名称。不使用 `--stdin` 或 `--fd` 时,命令要求交互式终端并在
关闭回显后读取真值。两个非交互通道互斥;`--fd` 要求编号不小于 3 的继承描述符。绝不能把
真值放进命令行。Vault 与 snapshot 口令同样只使用隐藏输入或显式的
`--*-passphrase-fd` 选项;生产命令不接受任何密钥或口令 option value。

使用 `--provider keychain` 可选择注入的系统 keychain;默认 provider 是 vault。`ls` 当前
只列 vault 名称,因此需要 vault passphrase。

## `authority rotate`

显式轮换当前 Store 在 OS keychain 中的 mutation authority:

```bash
node packages/cli/dist/bin.js authority rotate
```

只要 `operations/active.json` 存在,rotation 就会拒绝,包括 journal malformed 或无法自动
recovery 的情况。成功 rotation 会保留 authority id、递增 epoch、生成新的随机 256-bit
key,并通过回读 credential 完成校验。由旧 epoch seal 的 plans/journals 会立即失效,只能
manual handling。

Provisioning 与 rotation 共用 Store authority-coordination lock。Rotation 还会在检查
active journal 与替换 credential 时持有 mutation/recovery exclusion,因此 rotation 与
executable mutation/recovery 只能取得一个串行顺序。不要直接编辑保留 credential entries
来绕过该 lifecycle。

当 `CELLARER_MUTATION_AUTHORITY` 生效时,该命令会拒绝修改 runner environment。
Headless authority 应由 runner 在确认不存在 active journal 后,把受保护 secret 替换为更高
正整数 epoch 的新值。移动或 clone Store 会改变 normalized scope;应在新 root 运行 `init`
以 provision 独立本地 authority,不要复制 plans 或 journals。

## `ui`

启动本地 Web 控制台。

```bash
node packages/cli/dist/bin.js ui
node packages/cli/dist/bin.js --output json ui --port 0 \
  --token-fd 3 --lifetime-fd 4 3< /path/to/ui-token 4< /path/to/lifetime-pipe
```

选项:

| 选项 | 说明 |
| --- | --- |
| `--port <port>` | `0..65535` 范围内的端口,默认 `4317`;`0` 表示由 OS 分配 loopback 端口。 |
| `--token-fd <number>` | 选择 managed bearer mode,并从编号不小于 `3` 的继承 descriptor 读取 token。 |
| `--lifetime-fd <number>` | 该独立继承 ownership descriptor 到达 EOF 时关闭 sidecar。 |

Bearer token 真值不得出现在 argv 或 structured request JSON 中。只传 descriptor
编号,由 runner-owned 的受保护文件、pipe 或等价通道提供 bytes;示例文件应仅允许 owner
读取。不传 `--token-fd` 时,`ui` 选择内置 browser-session mode;不存在无认证 API fallback。

Machine mode 的 stdout 在 socket 绑定后只包含一条版本化 ready result。其中包含实际
base URL、PID、API version、contract ID、认证模式与 lifecycle protocol,不包含 token
或绝对 Store path。Descriptor EOF、programmatic close、SIGINT 与 SIGTERM 共用同一个
幂等、有界 shutdown 路径。

`ui` 会在启动 server 前 preload 可用 authority,并且只向 Web 注入用于 sealing、current-
epoch lease 与 protected journal tip 的窄 `MutationAuthority` capability。Web 不会得到
通用 `SecretStore`、raw key、credential-provider handle,也不会得到 authority
provisioning/rotation operation。该 capability 的 protected backend 只能检查自己的 epoch
与 replay tip;routes 不能执行任意 credential operation。Web scan/import composition 始终
使用 environment-reference mode,对 vault/keychain secret 的调用数为零。无 authority 时
scan planning 仍可用,executable import 与其他 mutation routes 会 fail closed。
