# Cellarer 详细指南

[English](README.md) | `简体中文` | [项目 README](../README.zh-CN.md)

这是 cellarer 唯一的详细说明文档，集中介绍产品模型、常见工作流、架构、安全边界、
自动化接口、扩展模型与维护流程。精确的 CLI 与 HTTP Schema 由运行中的软件提供，
本文档因此可以专注解释各部分如何协作。

## 如何阅读本文档

第一次使用时，先阅读根目录的 [README](../README.zh-CN.md) 并完成其中的首次流程。
需要理解某项决策或执行低频操作时，再回到本文档的对应章节。

为方便阅读，本文示例使用未来安装后的 `cellarer` 命令。在 package 发布前，请替换为：

```bash
node packages/cli/dist/bin.js
```

需要精确参数或机器合同时，以运行时发现结果为准：

```bash
cellarer --help
cellarer <command> --help
cellarer --output json capabilities
cellarer --output json schema
```

主要章节：

- [原则和边界](#原则和边界)
- [心智模型](#心智模型)
- [常见工作流](#常见工作流)
- [架构](#架构)
- [安全与恢复](#安全与恢复)
- [自动化接口](#自动化接口)
- [自定义 Adapter](#自定义-adapter)
- [开发与发布](#开发与发布)

## 原则和边界

cellarer 管理 AI coding agent 的可复用本地配置。Store 是三类资源的来源：

- rules，例如 `AGENTS.md`、`CLAUDE.md`；
- 从各 agent 原生 JSON 或 TOML 结构规范化得到的 MCP server 定义；
- 包含 `SKILL.md` 与辅助文件的 skill 目录。

产品遵守以下硬边界：

1. **本地优先。** 当前产品没有账号、云端 Registry、遥测管道或多用户服务。
2. **Core first。** 业务规则属于 `@cellarer/core`；CLI 与 Web 只解析请求并展示 Core 结果。
3. **先 Plan，后 Apply。** 写入绑定明确输入、Store revision、目标前置条件和不可变计划；
   dry-run 不写入。
4. **由 Adapter 承载 agent 差异。** 新路径和格式进入 adapter 配置或共享 codec，不在
   engine 中散落 agent-id 分支。
5. **写入有所有权且可回滚。** 已下发目标拥有 receipt 与唯一规范 owner。漂移和未管理
   内容默认阻止破坏性替换，除非调用方确认精确检查过的状态。
6. **密钥保持为引用。** Store 资源、计划、生成目标、日志、CLI 输出和 Web 响应不得包含
   明文密钥真值。

cellarer 不安装 agent、不运行 MCP proxy、不执行 skill，也不替代通用密钥管理器；它管理
这些系统周围的配置与证据。

## 心智模型

### Store

Store 是本地事实来源，默认位于 `~/.cellarer`。设置 `CELLARER_HOME` 可以使用另一个
Store，例如隔离的测试环境。

Store 的持久状态包括 Library 内容、用户配置、已下发目标台账、单调 revision、已完成
operation receipt 与恢复证据。凭据真值和明文目标 snapshot 不属于 Store。

### Resource

Resource 是一条可复用 rule、一个 MCP server 定义或一个 skill。受管资源拥有
`rules/team-rules`、`skills/review` 这样的不可变 ID。名称和描述元数据可以变化，但
mutation 使用不可变 ID，使依赖检查保持无歧义。

`resource list` 和 `resource show` 将受管 Library 数据与 agent 中发现的内容组合展示。
Lifecycle 命令可以检查更新、暂存固定 revision、重命名、删除、导出或导入仅含引用的
bundle。更新 Store 不会静默下发到 agent。

Inventory 是导入前的实时只读视图。`inventory refresh` 检查每个已注册 adapter 声明的
有界用户来源，不受 enabled 或 detected 状态过滤；`--dir` 添加一个明确的当前 project，
`--agent <id>` 则把同一 DTO 精确收窄到一个已注册 adapter。它合并等价候选，保留脱敏的
provenance 与 typed findings，标记 Store 匹配，并声明 complete、partial 或 failed 完整度。
刷新不会导入、写入 target，也不会访问 mutation authority 或 secret provider。

### Collection

Collection 按资源 ID 组织选择。初始化时创建 `default`；也可以建立 `work`、`personal`、
`review` 等使用场景。Collection 成员关系是精确引用，不复制资源。

### Agent Adapter

Adapter 描述如何探测一个 agent，以及它在 global/project scope 下存储 rules、MCP 配置
和 skills 的位置。它还声明 capability、codec、路径模板与精确支持的密钥引用类型。

随包 agent 通过按 key 的 `adapterOverrides` 调整；新的声明式 agent 位于
`customAdapters`。探测到 agent 不等于自动把它作为 mutation 目标。Enabled state 是与
初始化分离配置的高级下发偏好，绝不用于过滤 Inventory；后续每次 target mutation 仍须
单独明确 agent 与 capability。

### Scope 与落地方式

Global scope 写入 agent 的用户配置；project scope 写入通过 `--dir` 或
`--workspace-root` 明确提供的工程根目录。工程操作不会静默使用进程 cwd。

Rules 与 MCP 数据渲染为原生文件；skills 可以使用 symlink 或 copy。Scope、method、
merge policy、resources、agents 与 capabilities 都属于计划内容。

### Plan、Apply 与 Receipt

Planning 计算 action，但不执行。可执行计划绑定 operation、基础 Store revision、规范化
输入、有序 action、目标前置条件、过期策略和授权 seal。Apply 消费这些精确语义；
不会把 digest 当作权限，也不会静默重建发生变化的计划。

人类便利命令可以 dry-run 后重复相同选择。受管客户端可以保留完整可序列化计划，并通过
CLI 或本地 API 提交。Store revision、目标状态、所有权、authority 或计划内容发生变化
时，操作返回 typed conflict，不产生未授权写入。

```bash
cellarer --output json apply --plan '<exact-plan-json>'
```

使用 structured CLI input 时，`input.plan` 携带同一份完整计划；不要只提交 digest，也不要
根据部分字段重建计划。

成功 mutation 返回包含 revision 和逐 action 证据的 operation receipt。Ledger 记录当前
已下发目标状态；receipt 记录 operation 结果。Ledger 不是 activity event log。

### 所有权、验证与恢复

每个规范化物理目标只有一个当前 owner，由 agent、scope、capability 与路径标识。
Mutation 前，cellarer 将目标分类为 absent、owned-current、owned-drifted、
unowned-existing 或 invalid-owner。

验证分别报告三类信号：

- 当前期望资源与最后一次 applied state；
- 最后一次 applied receipt 与当前磁盘；
- 未完成或需要人工处理的 mutation 状态。

相关轴全部收敛才是 healthy。中断 operation 保留 journal 并阻止后续写入，直到基于证据
完成恢复，或返回精确的人工处理要求。

## 常见工作流

### 初始化与检查

交互式文本初始化会创建或验证 Store，刷新完整的有界 Inventory，展示完整度与候选状态，
并在导入 Core 默认选中的精确 ready candidate ID 前确认一次。拒绝确认会保留已完成的
Store 初始化且不导入资源。Refresh 为 partial 或 failed 时会单独保留候选与 findings，
在显式重试成功前不提供导入确认：

```bash
# 交互式 Inventory 审查与一次精确 Store-import 确认
cellarer init

# 无提示的 machine initialization；两者都返回 Inventory 且不导入
cellarer --output json init
cellarer --non-interactive init

# 精确重试，并在审查后显式导入
cellarer inventory refresh
cellarer --output json inventory import plan --candidate '<candidate-id>'
cellarer inventory import apply --plan '<plan 返回的 mutationPlan JSON>'

# Agent 检查与初始化、导入保持分离
cellarer agents
cellarer doctor
```

JSON、JSONL、structured input、非 TTY 输入及 `--non-interactive` 返回闭合、脱敏的
Store/Inventory 结果，并执行零 prompt、零 import、零 agent-target operation。Init 不再
接受 `--agent`、`--no-agent` 或 structured `agents` 字段。重复执行 `init` 会刷新当前来源，
只提供当前 Core defaults；Store 中相同 revision 不会再被选中。已确认 plan 过期时不会静默
重试：应重新 refresh、review 并创建新的精确 plan。资源导入与后续 Sync 授权保持分离。

`doctor` 是只读命令，检查 Store 布局、配置、adapter 加载、agent 探测、目标写权限、
authority、锁与恢复证据。它诊断中断 operation，但不会自行删除或修复证据。

### 导入与检查资源

```bash
cellarer add ./my-rules.md
cellarer add ./context7.json
cellarer add ./my-skill/
cellarer add vercel-labs/skills --list
cellarer add vercel-labs/skills --skill nextjs --collection public

cellarer ls --collection default
cellarer inventory refresh
cellarer inventory refresh --agent codex --dir "$PWD"
cellarer --output json inventory import plan \
  --candidate '<candidate-id>' --agent codex --dir "$PWD"
cellarer inventory import apply --plan '<plan 返回的 mutationPlan JSON>'
cellarer resource list --kind skills
cellarer resource show skills/nextjs
```

本地 `.md` 文件作为 rules，`.json` 文件作为 MCP resources，符合要求的目录作为 skills。
远程 skill 支持 GitHub owner/repository 来源与 repository tree URL，并保留 provenance。

`inventory import plan` 至少需要一个精确 candidate ID；它不会推断选择，也不会在
non-interactive mode 下提示。结果把当前 source evidence 与 Store revision 绑定进
authority-sealed、可跨进程使用的 `mutationPlan`。`inventory import apply` 只接收该 plan，
重新验证绑定，并发布一个 Store revision。两个命令都不会写入 agent target。规划时可用
`--into-collection <id>`，在同一个 Store operation 中把全部导入资源加入一个现有
collection。

只在需要时使用 resource lifecycle：

```bash
cellarer resource dependencies rules/team-rules
cellarer resource check rules/team-rules
cellarer resource update rules/team-rules --dry-run
cellarer resource rename rules/team-rules team-rules-v2 --dry-run
cellarer resource remove rules/team-rules --dry-run
```

只有 check 与 update lifecycle 会访问上游来源。Update 在 Store mutation 前先暂存并固定
revision；之后是否下发是另一个独立 operation。

### 管理 Agent、Collection 与设置

```bash
cellarer agent list --scope global
cellarer agent show codex --scope global
cellarer agent configure codex \
  --adapter '{"displayName":"Codex Local"}' --dry-run

cellarer collection create work \
  --description "Work resources" --resource rules/team-rules
cellarer collection defaults set --collection default,work

cellarer config show
cellarer config update --settings '{"method":"copy"}' --dry-run
```

所有 control-plane mutation 都支持 dry-run。内置 adapter 配置、自定义 adapter、
collection membership 与 typed settings 都是带 revision 的 Store mutation；手动编辑
`config.json` 不是常规接口。

### 预览与下发

人类交互先预览，再重复相同的明确选择：

```bash
cellarer apply --dry-run --agent codex,claude-code \
  --collection default --rules --mcp --skills
cellarer apply --agent codex,claude-code \
  --collection default --rules --mcp --skills
```

Project scope 使用 `--dir /absolute/project`。非交互写入必须明确 agents 与 capabilities。
现有未管理或漂移目标保持阻断；应从机器输出读取精确 acknowledgement token，而不是猜测
或使用全局 force flag。

### 可复用 Profile

Profile 记录精确的可复用 desired state：agents、resource/collection IDs、capabilities、
scope、method 和 merge policy。它不保存绝对 workspace path、密钥真值或永久破坏性确认。

```bash
cellarer profile create project-team --desired \
  '{"agentIds":["codex"],"scope":"project","resourceIds":["rules/team-rules"],"collectionIds":[],"capabilities":["rules"],"method":"copy","mergePolicy":"merge"}'
cellarer --output json sync plan project-team --workspace-root /workspace/app
cellarer sync verify project-team --workspace-root /workspace/app
cellarer sync uninstall project-team --workspace-root /workspace/app --dry-run
```

Project profile 每次调用都需要当前绝对 workspace root。Apply 与 uninstall 仍遵守相同的
所有权、事务、引用和恢复规则。

### 扫描已有 Agent 配置

从只读预览开始：

```bash
cellarer --output json scan --agent codex --dry-run
```

执行导入时，从预览复制完整 `kind`、`name` 和 `source` selector，并明确选择 capability：

```bash
cellarer scan --agent codex --rules --into-collection default \
  --select '[{"kind":"rules","name":"team","source":"/absolute/path/AGENTS.md"}]'
```

Dry-run 使用 environment-reference mode，不 provision 或查询 mutation authority、vault、
keychain 凭据。可执行导入是普通 mutation；apply 时重新检查已捕获来源 fingerprint，不会
重新扫描或改变选择。

### 验证、恢复与回滚

```bash
cellarer --output json status --agent codex
cellarer --output json verify --agent codex --rules
cellarer operation list
cellarer --output json operation recover operation-<id> --dry-run
cellarer --output json revert --agent codex --dry-run
```

不带 agent 的 `status` 报告 ledger-versus-disk items；带 agent 时可以包含完整的 desired、
disk 和 recovery 验证模型。

中断 operation 必须先运行 `operation recover <id> --dry-run` 诊断，只在结果允许时执行
恢复。绝不能因为 `mutation.lock`、`recovery.lock` 或 `operations/active.json` 看起来很旧
就删除它。Manual-recovery 结果会故意保持无法证明的目标和证据不变。

Revert 同样 plan-first 且感知 drift。只有所有权与 receipt 仍能证明安全时，才删除由
cellarer 创建的目标；被替换的目标从加密 before-state snapshot 恢复。操作可能需要精确
drift acknowledgement 与原始 snapshot passphrase。

### 密钥引用

资源中使用引用：

```json
{
  "command": "example-server",
  "env": {
    "OPENAI_API_KEY": "${OPENAI_API_KEY}"
  }
}
```

或者仅对原生支持它的目标使用：

```text
${CELLARER_SECRET:OPENAI_API_KEY}
```

通过隐藏输入增加 vault value：

```bash
cellarer secret add OPENAI_API_KEY
cellarer secret ls
```

自动化必须使用 `--stdin` 或继承的 `--fd` 传入 value，并用另一个受保护 descriptor 传入
vault passphrase。密钥真值和 passphrase 不作为 option value，也不会由 `ls` 输出。

### Web UI 与本地 API

```bash
cellarer ui
```

Server 只绑定 `127.0.0.1`。Browser mode 创建新的随机 `HttpOnly`、`SameSite=Strict`
session，并要求精确 loopback Host 与 Origin。Managed client 通过不同的继承 descriptor
接收 bearer 与 lifetime material：

```bash
cellarer --output json ui --port 0 \
  --token-fd 3 --lifetime-fd 4 3< /path/to/token 4< /path/to/lifetime-pipe
```

Managed stdout 在 socket、认证、assets、contract 与 Core composition 准备完成后只输出
一条 ready result。Lifetime EOF 与进程 signal 进入同一个有界 shutdown 路径并保留 Core
journal。

## 架构

### Package 与 Effects

| Package | 职责 |
| --- | --- |
| `@cellarer/core` | Store、adapters、resource lifecycle、planning、mutation、verification、recovery、revert 与引用安全。 |
| `@cellarer/cli` | 人类与机器命令解析和展示。 |
| `@cellarer/web` | Loopback Hono API 与随包 React 控制台。 |

Core 业务逻辑通过 `Env` 获取文件系统、home、cwd、platform、environment、clock、
secret-provider 与进程 lifetime effects，不直接读取 `process`、`os` 或 `node:fs`。测试
因此可以使用临时 Store 与 fake/injected effects。

### 下发与扫描流程

```text
Store resources
  -> 明确的 agents、scope、collection/profile 与 capabilities
  -> adapters 与 config
  -> 渲染与 secret guards
  -> immutable plan
  -> 所有权与目标前置条件
  -> journaled actions
  -> receipts、ledger 与 revision
```

```text
Agent 原生文件
  -> adapter paths 与 codecs
  -> 安全捕获 snapshot
  -> 规范化的 reference-only resources
  -> 明确选择与 conflicts
  -> immutable import plan
  -> Store mutation 与 receipt
```

### 版本化 Client 与 Sidecar

所有受支持的本地 client operation 都位于 `/api/v1`。一个 route registry 统一拥有 method、
path、认证、封闭 request/response schemas、operation ID 与 HTTP mapping。Hono routes 与
OpenAPI 3.1 contract 都由同一 registry 驱动；CLI 与 HTTP 共享 transport-neutral Core DTO
与 error code。

Sidecar 不增加进程内 mutation queue。多个 CLI 或 sidecar process 通过 Store revision、
mutation authority、跨进程 lock、journal、ownership 与 recovery 收敛。Liveness 只证明
transport；authenticated readiness 报告 Store、authority、lock 与 recovery blockers。

## 安全与恢复

### Reference-only 输出

只有目标 adapter 声明其精确原生输出支持某种 reference kind 时，渲染才保留该引用。
`secretMode` 选择用于存在性检查和已知值扫描的 provider，从不授权明文渲染。

导入内容、staged trees、生成 bytes、plans、journals、receipts、errors、CLI 输出与 Web
响应都会经过 structured/observable guards。已知值、credential pattern、敏感字段、格式
不明确的结构化输入、不安全 symlink 与重复 key 在对应边界 fail closed。

### 所有权与替换

未管理或漂移目标默认不能被覆盖。明确替换需要绑定到检查状态的精确 acknowledgement，
以及完整加密 before-state snapshot。捕获、加密或存储失败时，原目标与所有权保持不变。

不要删除或编辑 Store 证据来绕过 conflict。普通 stale revision 应重新 plan；ownership 或
recovery conflict 应遵循 typed guidance。

### Mutation Authority

除 integrity digest 外，可执行 plan 和持久 journal publication 还由 Store-scoped mutation
authority seal。正常本地初始化使用 OS credential manager。Headless 环境只能通过受保护的
runner secret facility 提供 `CELLARER_MUTATION_AUTHORITY`：
`v1:<positive-epoch>:<43-character-unpadded-base64url-key>`。应在 credential/secret
manager 内生成 32 个随机 byte，以无 padding 的 base64url 编码并组合该值；不要打印，也
不要放入 shell history、argv、JSON 或 Store 文件。

Authority rotation 是显式操作，存在 active journal 时会被拒绝。旧 Store 或跨 Store 的
plan 不通过 compatibility fallback 接受。只读操作在可能时保持可用，但不会声称 unsigned
state 可以安全 mutation。

### 已知限制

- Secret detection 是防御措施，不是任意内容安全的证明；敏感 dry-run 仍需人工检查和
  repository/provider scanner。
- Generic renderer 不在 agent dialect 之间翻译 reference token；不支持的 adapter fail closed。
- 递归本地 Skill capture 当前要求 Darwin 或 Linux x64/arm64 上可用的 anchored no-follow
  traversal。不支持的平台会在读取或复制目录前失败；Windows 仍支持安全的普通 Rule/MCP 文件。
- 在无法把目录 identity 绑定到 no-follow delete 的环境中，自动删除 receipt 或加密 snapshot
  目前不受支持，证据会保守保留。
- Ledger version 1 与含糊的 pre-release ownership record 需要明确 reset 或人工处理，不会
  被静默解释为当前所有权。

如果密钥真值曾出现在生成文件、argv、日志、响应或 backup 中，应视为已泄露：先在 provider
轮换，再移除保留的明文，替换为受支持引用，然后 preview、apply 并运行独立 secret scan。

## 自动化接口

### CLI 协议

每个已注册命令使用 CLI protocol `1.0`，并在命令前接受全局 transport options：

```text
--output text|json|jsonl
--non-interactive
--input <path|->
```

JSON 输出一条 terminal envelope。JSONL streaming 命令可以先输出有序 event，最后必须恰好
输出一条 terminal result；缺少 terminal record 的 stream 属于中断，不能视为成功。机器
stdout 只含 protocol records，脱敏 diagnostics 使用 stderr。

Structured request 在 argv 中保留 command，并把 domain input 放入版本化 request：

```json
{
  "protocolVersion": "1.0",
  "command": "status",
  "requestId": "ci:status:42",
  "input": {
    "agents": ["codex"]
  }
}
```

```bash
cellarer --output json --input request.json status
```

不要在 argv 与 `input` 中重复 domain field。自动化应根据稳定的 `error.code` 分支，不依赖
本地化 message。通过发现接口读取受支持命令、streaming 行为与 input/output schema ID：

```bash
cellarer --output json capabilities
cellarer --output json schema
cellarer --output json schema urn:cellarer:cli:protocol:1.0:command:status:output
```

### 本地 HTTP API

经过认证的 client 可以发现 version、capabilities、readiness 和已实现 OpenAPI contract：

```text
GET /api/v1/health
GET /api/v1/version
GET /api/v1/capabilities
GET /api/v1/readiness
GET /api/v1/openapi.json
GET /api/v1/inventory?dir=/absolute/project
GET /api/v1/inventory/{agentId}?dir=/absolute/project
POST /api/v1/inventory/import/plan
POST /api/v1/inventory/import/apply
```

所有 JSON operation 返回包含 request ID、status、warnings，以及 data 或 typed error 的
版本化 envelope。Mutation route 分离 plan/apply，并提交未修改的 authority-sealed plan。
未版本化 `/api/*` surface 不存在。

只有 health 是未认证 liveness。Browser 与 managed authentication 是显式启动 mode；没有
query token 或 unauthenticated fallback。随包 React client 使用同一个 typed `/api/v1`
边界，不重建 Core 决策。

两个 Inventory route 都返回 browser-safe Core Inventory DTO。完整 route 刷新所有已注册的
有界来源，targeted route 接收一个精确的已注册 adapter ID。来源失败会作为成功 transport
envelope 内的 typed partial 或 failed 结果保留，而不会转换为原始 exception。

Inventory import plan route 接收 `candidateIds`，以及可选的 `agentId`、`dir` 和
`intoCollection`。Apply route 只接收规划返回且未经修改的 `mutationPlan`。随包 client 在
两个 route 之间传递该精确 plan，不会重新 refresh、重新选择或重建 action。随包 UI 从
Inventory-first onboarding 开始，支持按 kind、source、adapter 与 state 过滤合并后的
provenance，并只采用 Core defaults。Inventory 不完整时禁用导入；导入需要一次精确确认；
plan 过期时只展示 refresh/replan 指引，不会静默重试。导入成功后，Library 与 Sync 作为
独立 next action 展示；Inventory 审查和导入都不会写入 agent target。

## 自定义 Adapter

用户配置位于 `~/.cellarer/config.json`；自定义 Store 使用
`$CELLARER_HOME/config.json`。优先使用 typed CLI operation：

```bash
cellarer agent configure codex --adapter '{"displayName":"Codex Local"}'
cellarer agent reset codex
cellarer agent add my-agent \
  --adapter '{"displayName":"My Agent","rules":{"project":"{dir}/AGENTS.md","format":"markdown"}}'
cellarer agent update my-agent \
  --adapter '{"displayName":"My Agent","rules":{"project":"{dir}/AGENTS.md","format":"markdown"}}'
cellarer agent remove my-agent
```

内置 patch 位于 `adapterOverrides`，新 agent 位于 `customAdapters`。Custom adapter 至少
声明 rules、MCP、skills 中一项，也可以显式声明 detect path。省略时，project scope 直接
使用 project root；global scope 使用第一个已声明 rules、MCP 或 skills path 的父目录。
MCP 还必须声明目标原生消费的精确
`supportedSecretReferences`；空列表会阻断所有含密钥引用的 MCP value，不会物化明文。

路径模板保持精简：

| Template | 含义 |
| --- | --- |
| `~` 或 `~/...` | 相对 home 的 global path。 |
| `{dir}` | 明确提供的 project root。 |
| 相对路径 | 在当前 managed root 下解析。 |

展开后的路径必须位于所选 managed root 内。MCP dialect option 可以描述 command array、
`environment`、`serverUrl` 等字段结构，但不翻译 secret-reference token。

当前 generic renderer 兼容性：

| 内置 Adapter | Reference 支持 |
| --- | --- |
| Claude Code | 精确 `${ENV_VAR}` environment reference。 |
| Gemini CLI | 精确 `${ENV_VAR}` environment reference。 |
| Codex、Cursor、OpenCode、Windsurf | 在实现并验证 target-specific translation 前不支持。 |
| 全部内置 Adapter | 不支持 `${CELLARER_SECRET:name}`。 |

从受维护的示例开始：

- [基础目录布局](../examples/adapters/acme-agent.example.json)
- [MCP 字段 dialect](../examples/adapters/quirky-agent.example.json)

当路径加标准 JSON/TOML codec 不足时，应扩展共享 schema 或 codec 边界，而不是把特殊行为
放进 CLI 或 Web。

## 开发与发布

Monorepo 使用 pnpm 与 Node.js `>=20.19`：

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

行为变更需要同步 Core、CLI、Web、测试、公开文档与相关 OpenSpec capability requirement。
公开文档变更同时更新 English 与简体中文。

已准备的公开 package set 为 `0.1.0-alpha.0`：

- `@cellarer/core`：运行时逻辑与随包 adapter 配置；
- `@cellarer/web`：server 输出与构建后的 dashboard assets；
- `@cellarer/cli`：`cellarer` 可执行文件。

Workspace root 保持 private，目前没有 package 被发布。Release readiness 使用隔离的
Store/home path，在 Ubuntu、macOS、Windows 的 Node 20.19 上验证干净 packed artifact：

```bash
pnpm version:check -- 0.1.0-alpha.0
pnpm artifact:pack
CI=true pnpm release:readiness
```

这些命令构建、检查、安装并运行本地 tarball，不会发布 package、创建 tag/release、修改
dist-tag、deploy 或改变任何远程服务。Publication 始终是另行授权的动作。
