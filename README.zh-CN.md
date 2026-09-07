# cellarer

[English](README.md) | `简体中文`

> 用一个本地 Store 管理多个 AI agent 的 skills、MCP servers 与 rules。

cellarer 面向在同一台机器上使用多个 AI coding agent 的开发者。你不再需要分别维护
多份 rules、MCP 配置与 skills：将资源导入一次，预览将要发生的精确变更，再同步到
选中的 agent。统一 Inventory 提供已有 agent 配置的只读视图，再按精确候选导入 Store。

项目围绕三个原则设计：

- **本地优先：** Store 与生成配置保留在本机。
- **变更前预览：** 下发、导入、配置和回滚都遵循 plan/apply 边界并产生持久 receipt。
- **引用而非明文密钥：** 生成文件保留受支持的环境变量或 cellarer 引用，不物化密钥真值。

## 状态与运行要求

首个稳定公开 package set 已准备为 `0.1.0`。Release artifact 已通过干净安装 gate，
但尚未发布到 npm；registry publication 仍是独立的发布动作。

- Node.js `>=20.19`
- pnpm `10.12.1`
- Ubuntu、macOS 或 Windows

普通 Rule 与 MCP 文件支持上述三个平台；递归导入本地 Skill 目录目前要求 Darwin 或
Linux x64/arm64。

## 安装与运行

Registry release 完成后，全局安装 CLI package。Package 名带 scope，但安装后的
可执行文件就是可直接调用的 `cellarer`：

```bash
npm install --global @cellarer/cli
cellarer --help
```

Registry publication 前，release maintainer 可按[开发](#开发)中的步骤从本地 packed
artifact 验证同一命令。下面的用户流程统一使用安装后的产品入口。

## 第一次完整使用

创建或验证本地 Store。交互式文本模式会刷新实时 Inventory，只预选 Core 指定的 ready
候选，并在把这组精确候选导入 Library 前确认一次：

若 headless 机器没有 OS credential manager，请在 `init` 前配置受保护的
[mutation authority](docs/README.zh-CN.md#mutation-authority)。

```bash
cellarer init
```

拒绝确认会保留已完成的 Store 初始化且不导入任何资源。Inventory 为 partial 或 failed 时会
单独报告，并给出 `inventory refresh` 重试指引。Machine mode 返回闭合、脱敏的 Store 与
Inventory 阶段结果，不提示也不导入：

```bash
cellarer --output json init
cellarer --non-interactive init
```

Init 不再接受 `--agent`、`--no-agent` 或 structured `agents`。Agent target 只由后续独立
授权的下发命令选择。

只读刷新所有已注册的有界用户来源，或精确指定一个 adapter；添加 `--dir <project>`
可同时包含当前 project：

```bash
cellarer inventory refresh
cellarer inventory refresh --agent codex
```

Inventory 返回安全候选、provenance、findings、Store 匹配、计数与完整度，不会导入资源或
写入 agent target。

Custom Agent 定义通过 add 或 update 提交后，cellarer 会尝试一次 targeted Inventory
refresh。partial 或 failed 会单独报告，不会撤销已提交的 mutation。使用
`cellarer inventory refresh --agent <id>` 显式重试；client 不会自动重试或导入。

要将已审查的候选导入 Store，请使用精确 ID 生成 plan，再原样提交该命令返回的
`mutationPlan`。导入不会将资源下发到 agent target：

```bash
cellarer --output json inventory import plan \
  --candidate '<candidate-id>'
cellarer inventory import apply \
  --plan '<plan 返回的 mutationPlan JSON>'
```

对于只有一个 `secret-adoption-required` finding 的受阻 MCP candidate，可把 finding 中的
精确 selector 原样用于 reference-only adoption plan。支持 stdio 环境变量与 flag 参数，
以及 remote header 与唯一 URL query 参数。Rule/Skill candidate、custom MCP 结构、
malformed 或 ambiguous 字段，以及含多个候选密钥字段的 candidate 仍然受阻：

```bash
cellarer --output json inventory adopt plan \
  --candidate '<candidate-id>' \
  --selector '{"kind":"environment","server":"example","name":"API_TOKEN"}' \
  --provider vault
cellarer inventory adopt apply \
  --plan '<plan 返回的 mutationPlan JSON>' --confirm
```

Planning 只读且绝不访问 secret provider。Apply 要求 runtime composition 提供原子
create-if-absent provider capability；argv 与 machine input 都不接受密钥真值，也绝不覆盖
已有 entry。如果 provider 创建成功但 Store publication 失败，typed result 会保留精确的
人工 cleanup command，cellarer 不会静默删除 orphaned reference。

使用仓库自己的 README 作为真实 Rule 输入，并用隔离目录作为 project target：

```bash
mkdir .cellarer-demo
cellarer add ./README.md
```

先预览，再使用相同选择执行下发：

```bash
cellarer apply --dry-run --agent codex --rules \
  --dir "$PWD/.cellarer-demo"
cellarer apply --agent codex --rules \
  --dir "$PWD/.cellarer-demo"
```

检查结果或进行回滚：

```bash
cellarer status --agent codex --dir "$PWD/.cellarer-demo"
cellarer revert --dry-run --agent codex \
  --dir "$PWD/.cellarer-demo"
cellarer revert --agent codex \
  --dir "$PWD/.cellarer-demo"
rmdir .cellarer-demo
```

显式 `--dir` 让本演练只触达 demo project；省略它会选择 agent 的真实全局配置。

启动仅监听 loopback 的 Web 控制台：

```bash
cellarer ui
```

## 管理范围

| 领域 | 主要操作 |
| --- | --- |
| Library | 刷新 Inventory；导入、检查、更新、重命名、删除、导出与 bundle 导入资源。 |
| Agents | 探测 agent、配置 adapter，并检查受支持的目标。 |
| 下发 | 按 agent、scope、collection 或 profile 预览和同步 rules、MCP servers 与 skills。 |
| 安全 | 验证漂移、保护目标所有权、恢复中断 operation，并按 receipt 回滚。 |
| Clients | 使用人类 CLI、版本化 JSON/JSONL 协议或经过认证的本地 `/api/v1`。 |

使用 `cellarer <command> --help` 查看精确选项。自动化调用方可通过
`capabilities` 与 `schema` 发现稳定的命令和 Schema 合同。

内置兼容性证据与校准后的落点见[详细指南](docs/README.zh-CN.md#内置兼容性证据)。发现配置
不代表原生加载成功；已有受管旧落点需要显式审查后处理。

## 架构概览

cellarer 是 TypeScript monorepo。`@cellarer/core` 负责 Store、规划、mutation、安全和
adapter 逻辑；`@cellarer/cli` 与 `@cellarer/web` 是 Core 之上的薄接口。Core 通过注入的
`Env` 获取文件系统、环境、平台、时钟和凭据能力，使行为可测试，也避免表现层自行发明
mutation 规则。

核心概念、工作流、架构、安全、自动化、adapter 与发布流程见[详细文档](docs/README.zh-CN.md)。

## 开发

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
node packages/cli/dist/bin.js --help
```

## License

MIT，见 [LICENSE](LICENSE)。
