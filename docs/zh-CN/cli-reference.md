# CLI 参考

[文档索引](../README.md) | [English](../en/cli-reference.md)

源码构建后运行:

```bash
node packages/cli/dist/bin.js <command>
```

## `init`

通过已签名的 mutation journal 初始化库房。产品目录与 `config.json` 都会取得 action
receipt,`config.json` 使用原子发布;成功会推进 store revision,并输出 operation id 与
结果 revision。若已有并发 mutation 或 recovery claim,命令至多创建幂等的协议骨架,
不会创建产品目录或 config。

进入 Core 初始化前,`init` 会加载 Store 范围的 mutation authority。若 keychain 条目不
存在,`init` 会在操作系统 credential manager 中生成随机 256-bit key,并进行精确回读
校验。其他命令不会 provision 或隐式轮换缺失的 authority。Headless 系统必须由 runner
注入下述受保护环境通道。

```bash
node packages/cli/dist/bin.js init
```

选项:

| 选项 | 说明 |
| --- | --- |
| `--global` | 为清晰度保留;当前默认就是初始化全局库房。 |

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
node packages/cli/dist/bin.js add https://github.com/vercel-labs/skills/tree/main/skills/web-design-guidelines --json
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
| `--json` | 输出 JSON candidate list 或 import report。 |

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
node packages/cli/dist/bin.js agents -a codex,claude-code --dir /path/to/project --json
```

选项:

| 选项 | 说明 |
| --- | --- |
| `-a, --agent <ids>` | 只展示这些逗号分隔的 agent id。 |
| `--dir <path>` | project scope 根目录。不传时为 global scope。 |
| `--json` | 输出机器可读结果。 |

## `doctor`

检查库房初始化、`config.json`、store 目录、adapter 加载、agent 探测、目标路径写权限
与 mutation recovery evidence,且不会写入文件。

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

JSON 报告包含 `mutationRecovery`。`clean` 表示没有未完成 operation;
`incomplete` 与 `manual-recovery-required` 会包含 typed error 和 operation evidence。
`doctor` 只诊断,不修复 operation。不要手动删除旧 lock;请按[核心概念](concepts.md#并发与中断-operation-恢复)
中基于 evidence 的流程处理。

## `apply`

生成计划或写入资源到选中的 agent。

```bash
node packages/cli/dist/bin.js apply --dry-run --agent claude-code,codex
node packages/cli/dist/bin.js apply --agent claude-code,codex --collection default
node packages/cli/dist/bin.js apply --dry-run --agent claude-code --json
```

选项:

| 选项 | 说明 |
| --- | --- |
| `-a, --agent <ids>` | 必填。逗号分隔的 agent id。 |
| `--dir <path>` | project scope 根目录。不传时为 global scope。 |
| `--collection <collection>` | 按 collection 过滤资源。 |
| `--rules` | 包含 rules。不传任何能力 flag 时默认包含全部能力。 |
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
| `--json` | 输出 Core apply plan/result、mutation identity 或 receipt、conflicts 与 acknowledgement tokens。 |

未确认的 ownership conflict 会阻止 apply 并以非零状态退出。先检查 JSON dry-run,再用相同选择
重试:把精确 token 放入 `--replace-unowned` 或 `--override-drift`,并提供
`--snapshot-passphrase-fd` 或终端隐藏输入提供 snapshot 口令。

每份响应都包含 `mutation.planId`、`planDigest`、`operation` 和 `baseRevision`。
成功的非 dry-run 响应还会包含 `mutation.result.receipt`,其中有 operation id、
resulting revision、outcome 和每个 action 的 receipts。CLI 在同一次调用内 plan 并
apply;后续的非 dry-run 调用不会重新提交序列化的 dry-run plan。
`LOCK_CONFLICT`、`STALE_REVISION`、`TARGET_PRECONDITION_CONFLICT` 与
`INTERRUPTED_OPERATION` 等 typed protocol conflicts 会以非零状态退出,且不执行未授权的
target write。

## `scan`

读取 agent 原生配置,规范化后导入库房。

```bash
node packages/cli/dist/bin.js scan --agent codex --dry-run
node packages/cli/dist/bin.js scan --agent codex --into-collection default
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
| `--select <names>` | 逗号分隔的资源名白名单。 |
| `--secret-mode <mode>` | Mutating import 的密钥来源:`env`、`vault` 或 `keychain`。只读 dry-run 始终使用 `env`,会忽略该选择。 |
| `--vault-passphrase-fd <number>` | Vault-backed mutating import 从继承描述符读取 vault 口令。 |
| `--keychain-service <name>` | Keychain-backed mutating import 使用的 service;默认 `cellarer`。 |
| `--dry-run` | 只展示候选项,不写入。 |
| `--json` | 输出 JSON。 |

`scan --dry-run` 是不能提交到 execution API 的纯只读 preview。它不会 provision、load
或 query mutation authority/secret credentials;即使请求 vault 或 keychain,也始终按
environment-reference mode 扫描。非 dry-run import 仍是 executable mutation,必须有
authority。

## `status`

检查已 apply 状态。传入 `--agent` 时,会分别验证 desired-versus-applied 与
applied-versus-disk,并包含 mutation recovery health。

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

`status --agent <ids> --json` 返回 `verification.desiredVsApplied`、
`verification.appliedVsDisk`、`verification.recovery` 和 `verification.healthy`。
不传 `--agent` 时,命令只返回 ledger-versus-disk `items`,不表示完整 verification
health。

## `revert`

回滚台账条目。

```bash
node packages/cli/dist/bin.js revert --agent codex --dry-run --json
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
| `--json` | 输出 Core revert plan/result 与 mutation identity 或 receipt。 |

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
node packages/cli/dist/bin.js ui --port 4317 --token local-token
```

选项:

| 选项 | 说明 |
| --- | --- |
| `--port <port>` | 端口,默认 `4317`。 |
| `--token <token>` | API 请求需要 `Authorization: Bearer <token>`。 |

`ui` 会在启动 server 前 preload 可用 authority,并且只向 Web 注入用于 sealing、current-
epoch lease 与 protected journal tip 的窄 `MutationAuthority` capability。Web 不会得到
通用 `SecretStore`、raw key、credential-provider handle,也不会得到 authority
provisioning/rotation operation。该 capability 的 protected backend 只能检查自己的 epoch
与 replay tip;routes 不能执行任意 credential operation。Web scan/import composition 始终
使用 environment-reference mode,对 vault/keychain secret 的调用数为零。无 authority 时
scan planning 仍可用,executable import 与其他 mutation routes 会 fail closed。
