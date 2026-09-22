# Cellarer 详细指南

[English](README.md) | `简体中文` | [项目 README](../README.zh-CN.md)

这是 cellarer 唯一的详细说明文档，集中介绍产品模型、常见工作流、架构、安全边界、
自动化接口、扩展模型与维护流程。精确的 CLI 与 HTTP Schema 由运行中的软件提供，
本文档因此可以专注解释各部分如何协作。

## 如何阅读本文档

第一次使用时，先阅读根目录的 [README](../README.zh-CN.md) 并完成其中的首次流程。
需要理解某项决策或执行低频操作时，再回到本文档的对应章节。

本文示例统一使用安装后的 `cellarer` 命令。从源码 checkout 工作的 contributor 与
release maintainer 可使用[开发与发布](#开发与发布)中记录的源码入口。

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

每个规范物理目标在 v3 ledger 中只有一个 Deployment，记录一份物化 receipt 和明确的
Agent/Profile 消费者。Agent 与 Profile 视图都是该状态的查询投影。只有最终内容、落地方式
与 capability 一致时，消费者才共享一次物理操作；期望不一致会阻断整批应用。Skill 软链以
目标目录项作为身份，解绑不会删除 Store 源目录。

Mutation 前，cellarer 将目标分类为 absent、owned-current、owned-drifted、
unowned-existing 或 invalid-owner。解绑一个消费者时，只要还有其他消费者，目标就会保留。
最后消费者退出仍需通过所有权和漂移检查；有 before-state 时通过已审查的 revert 恢复。
Profile uninstall 不会直接删除带 snapshot 的目标。

验证分别报告三类信号：

- 当前期望资源与最后一次 applied state；
- 最后一次 applied receipt 与当前磁盘；
- 未完成或需要人工处理的 mutation 状态。

只有每个请求的 Agent/scope/capability 均得到覆盖、至少验证一个目标且三个轴全部收敛时，
配置才是 `healthy`。`coverage` 保留逐项 typed outcome 及 expected/observed/failed 计数。
合法空选择为 `no-op` 且 `healthy: false`；unsupported、disabled、blocked 或 failed 请求
为 `incomplete`；完整观察中存在状态差异则为 `unhealthy`。未知 Agent 属于输入错误。
`runtime.observation` 保持 `unknown`：文件一致不能证明原生 Agent 已加载或 MCP 已连通。

验证不需要 mutation authority 或 secret provider。Recovery 轴只观察 journal 和锁是否
存在：均不存在时为 clean；存在遗留状态或无法读取时，保守要求执行有授权的恢复诊断。
中断 operation 保留 journal 并阻止后续写入，直到基于证据完成恢复，或返回精确的人工处理要求。

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
cellarer --output json inventory adopt plan \
  --candidate '<candidate-id>' \
  --selector '{"kind":"header","server":"example","name":"Authorization"}' \
  --provider keychain
cellarer inventory adopt apply --plan '<plan 返回的 mutationPlan JSON>' --confirm
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

Inventory 只为恰好有一个无歧义受支持明文字段的 MCP candidate 提供 reference-only secret
adoption。支持的 selector 包括 stdio 环境变量、stdio flag assignment 或 value、remote
header，以及唯一的 remote URL query 参数。Rules、skills、custom MCP payload、malformed
selector、重复 URL 参数，以及含多个可 adopt 字段的 candidate 仍然受阻。Selector 只是
metadata；argv、structured input、HTTP、日志与 browser state 都不接受密钥真值。

`inventory adopt plan` 只读、provider 调用为零，并把精确 candidate、source evidence、Store
revision、selector、provider、absent-entry precondition 与只含引用的 Store actions 绑定进
sealed plan。`inventory adopt apply` 要求 `--confirm`，在 provider interaction 前重新验证全部
绑定，而且只允许一次原子 create-if-absent 尝试。Runtime composition 必须提供兼容的窄
provider capability；provider unavailable 或 entry 已存在时返回 typed rejection，不会回退到
read、list、overwrite 或 delete。如果 provider entry 已创建而 Store publication 失败，结果
与 recovery diagnosis 会保留精确 provider/reference 以及人工
`cellarer secret rm ... --provider ...` cleanup command。cellarer 绝不静默删除该 orphan，
也不会改写 source 或任何 agent target。

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
所有权、事务、引用和恢复规则。多个 Profile 或 Agent 可以消费相同的 Deployment；
uninstall 解绑选定 Profile 的消费者，并保留其他消费者仍需使用的目标。

### 协调已部署的 Profile

`profile update` 只修改 Store 中的期望 revision，现有目标与已应用 revision 保持不变；
在审查并应用新计划之前，`sync verify` 会报告 desired/applied divergence，表示待同步。
只要 Deployment consumer 仍引用 Profile，删除就保持阻断。每次调用仅作用于当前 scope
和显式指定的 workspace root。

`sync plan` 现在生成 `sync-reconcile` operation。审查
`data.mutationPlan.normalizedInputs.reconciliation` 中的 keep/add/update/remove/detach、
当前选择、保留的受管贡献、未受管条目及阻断原因，再使用相同 workspace root 和
`sync apply <profile> --plan '<exact-plan-json>'` 原样提交 `data.mutationPlan`。
旧的 additive Profile 计划需重新生成。普通 `apply` 继续采用 additive 语义，保留的 MCP
条目不会丢失受管归属。协调只移除有明确证据的受管条目，保留用户原生字段；会破坏其他
consumer 期望的修改将被阻断。Store 资源更新不会自动下发。MCP uninstall 仅清理有归属
的条目；有 snapshot 的目标仍需审查后的 revert，未知归属或 drift 会阻断删除。

旧 MCP Deployment 缺少子项归属时，先检查其精确 ID 和原生条目，再单独审查仅修改 Store
的本地 baseline：

```bash
cellarer --output json sync baseline --deployment-id '<deployment-id>' --selectors a,b --dry-run
cellarer --output json sync baseline --deployment-id '<deployment-id>' --selectors a,b --plan '<exact-data.plan-json>'
```

Baseline 仅确认显式审查的当前 selector 和 fingerprint，不伪造历史资源来源，也不改目标。
条目缺失或字节变化会使计划失效。HTTP 提供对应的
`POST /api/v1/deployments/baseline/plan` 与 `/apply`。
协调的目标效果与 Deployment 发布属于同一个 journal。中断可能留下部分效果；当前
apply 系列的 durable journal 不保留可自动回放的执行授权，因此恢复会保留 manual recovery
证据，不会自动重放、finalize 或 compensate。

### 升级所有权状态

新 Store 写入 v3 Deployment 状态。读取现有 v2 ledger 不会自动升级；目标 mutation 前
需要先显式升级。配置 mutation authority 后，预览这项仅修改 Store 的升级，审查
`data.plan`，再原样提交完整计划：

```bash
cellarer --output json sync upgrade-state --dry-run
cellarer --output json sync upgrade-state --plan '<exact-data.plan-json>'
```

升级绑定旧状态字节、Store revision 和观察到的目标 fingerprint。它保留 receipt 与 snapshot
引用，不修改目标；缺失的子项归属仍标记为 `unknown`。重复物理 owner、不支持的格式或待恢复
状态都会阻断升级。旧 binary 会拒绝 v3 状态，不会自动降级；计划人工回退时应保留升级前状态
及加密恢复证据。

### 迁移已有 Agent 配置

旧的 `scan` 与 `discovery summary` 命令已移除，也没有兼容 alias。先刷新 Inventory，
从已注册的有界来源获取当前 candidate ID：

```bash
cellarer --output json inventory refresh --agent codex
```

使用已审查的精确 candidate ID 生成 import plan，再原样应用规划返回且经 authority seal 的
`mutationPlan`：

```bash
cellarer --output json inventory import plan \
  --candidate '<candidate-id>' --into-collection default
cellarer inventory import apply --plan '<plan 返回的 mutationPlan JSON>'
```

Inventory refresh 只读。Import 只写 Store，并重新检查已捕获的来源证据，不会重新选择
candidate。下发仍是独立 operation：需要把 Store 资源写入 agent target 时，使用
`apply --dry-run` 与 `apply`，或可复用 Sync profile。

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

`verify` 对 `healthy` 或合法 `no-op` 返回退出码 0，输入错误返回 2，`incomplete` 或
`unhealthy` 返回 3（`DOMAIN_VALIDATION_FAILED`）；错误 envelope 的 `data` 仍保留报告。
这修正了此前空结果或跳过请求可能被当作成功的行为。CLI 与 HTTP envelope 保持现有协议
版本，报告新增必需字段 `configuration`、`coverage` 和 `runtime`。HTTP 200 仅表示查询
完成，判断结果须读取 `data.configuration`。Web 覆盖卡片展示同一 Core 结果，并单列
原生运行时证据。

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

Library 的 Collection 筛选会传入 **Sync to Agents**。无筛选时，同步使用 Store
默认集合，并非全部集合。仅同步匹配的 Store 资源；discovered 资源需要先导入。
修改选择或关闭弹窗会作废预览。Apply 原样提交已审查的计划；计划过期被拒绝后，
需要重新预览，不会自动重试。

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

### 下发与 Inventory 导入流程

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
已注册的有界 agent 来源
  -> 安全的只读 Inventory refresh
  -> 脱敏 provenance、findings 与 candidate ID
  -> 精确的已审查 candidate 选择
  -> immutable authority-sealed import plan
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
- 合法 v2 ownership state 支持上述显式升级；ledger version 1 与含糊的 pre-release
  ownership record 需要人工处理，不会被静默解释为当前所有权。

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
POST /api/v1/inventory/adoption/plan
POST /api/v1/inventory/adoption/apply
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

两个 adoption route 只接受 selector/provider metadata 或精确且未修改的 `mutationPlan`；
未知的 plaintext-shaped 或 provider-operation 字段会在窄 Core service 被调用前拒绝。即使
apply provider capability 暂不可用，planning 仍可用且不会调用 provider。Apply 返回 typed
adoption status；Store publication 失败时包含稳定的 orphan cleanup evidence。随包 UI 只渲染
selector 与派生 reference name，允许选择受支持 provider、审查 plan，并要求独立的精确确认；
client code 中没有 secret-value input 或 general provider handle。

旧的 `GET /api/v1/discovery`、`POST /api/v1/scan/plan`、
`POST /api/v1/scan/apply`、`POST /api/v1/import/plan` 与
`POST /api/v1/import/apply` route 已移除并返回 not found。Client 必须使用上述 Inventory
route；server 不会翻译旧 request 或捕获的 scan plan。

### 内置兼容性证据

Agents 页面与 Agent 读取 API 区分 documented 落点、unsupported 能力、unknown 证据及
user-defined 覆盖。发现配置目录不代表原生加载成功。随包的 `compatibility/matrix.json`
按日期版本记录 42 个能力/scope 格、官方来源与加载前提；随包证据中没有 native-verified 格。
通用 AGENTS.md adapter 依赖实际消费者实现相应约定。

当前校准后的默认值包括：

| Agent | 落点或限制 |
| --- | --- |
| Claude Code | 用户 MCP：`~/.claude.json`；保留无关设置。 |
| Gemini CLI | 项目 Rules：`GEMINI.md`；Skills：`~/.gemini/skills` 与 `.gemini/skills`。 |
| Cursor | 用户 Skills：`~/.cursor/skills`；项目 MDC Rules 带 `alwaysApply: true`。全局 User Rules 需在 Cursor 设置中配置，不支持作为文件目标。 |
| Codex | 用户 Skills：`~/.agents/skills`。 |
| Windsurf Cascade | 项目 Skills：`.windsurf/skills`；不支持项目 MCP 文件落点。 |

这些合同以默认配置根目录及文档中的信任/启用设置为前提。MDC 包装仅接受纯文本规则；
需要条件触发的 frontmatter 会被标为 unsupported。覆盖配置会撤销相关能力的内置证据，
并标记为 user-defined。

若旧受管目标使用其他落点，规划返回 `relocation-required`。先审查该目标的显式
uninstall/revert，再为新落点独立生成计划。不会自动迁移或复制目标。原生文件含明文
密钥且无法通过现有 reference-only 防护时会被阻断。

维护者可在 checkout 构建后运行被动检查：

```bash
node test/e2e/native-agent-compatibility.mjs --fixture-only
```

可选的 `--native --agent codex --capability mcp --scope global --binary /absolute/path/to/codex --version <exact-version>`
模式要求 Linux 与 `/usr/bin/bwrap`。它隔离 HOME、项目、Store、凭据与网络，检查精确版本
二进制能否识别 fixture 配置；不启动 MCP server，也不验证连通性。其他执行方案/平台或
缺少前提时返回 unavailable（退出码 3）。Linux 执行路径尚未针对真实二进制验证；随包
证据不包含原生验证结果。Fixture 内容不会被执行。

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

Custom Agent add 或 update（包括随包 UI 的 upsert）一旦提交，即使随后唯一一次 targeted
Inventory refresh 为 partial 或 failed，Store mutation 仍然成功。CLI、本地 API 与 Agents
UI 会把 refresh 作为独立结果展示，不会 rollback、自动 retry 或 import。修复所报告的
source 问题后，显式重试：

```bash
cellarer inventory refresh --agent <id>
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
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
node packages/cli/dist/bin.js --help
```

行为变更需要同步 Core、CLI、Web、测试、公开文档与相关 OpenSpec capability requirement。
公开文档变更同时更新 English 与简体中文。

首个稳定公开 package set 为 `0.1.0`：

- `@cellarer/core`：运行时逻辑与随包 adapter 配置；
- `@cellarer/web`：server 输出与构建后的 dashboard assets；
- `@cellarer/cli`：`cellarer` 可执行文件。

Workspace root 保持 private，本仓库尚未执行 registry publication。另行授权并发布后，
可安装 CLI package 并直接调用它的可执行文件：

```bash
npm install --global @cellarer/cli
cellarer --version
cellarer init
```

Release readiness 使用隔离的 Store/home path 与 command-path resolution，在 Ubuntu、
macOS、Windows 的 Node 20.19 上验证干净 packed artifact：

```bash
pnpm version:check -- 0.1.0
pnpm artifact:pack
CI=true pnpm release:readiness
```

这些命令构建、检查、安装并运行本地 tarball，不会发布 package、创建 tag/release、修改
dist-tag、deploy 或改变任何远程服务。Publication 始终是另行授权的动作。
