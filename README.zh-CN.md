# cellarer

[English](README.md) | `简体中文`

> 用一个本地 Store 管理多个 AI agent 的 skills、MCP servers 与 rules。

cellarer 面向在同一台机器上使用多个 AI coding agent 的开发者。你不再需要分别维护
多份 rules、MCP 配置与 skills：将资源导入一次，预览将要发生的精确变更，再同步到
选中的 agent。cellarer 也可以扫描已有的 agent 配置并导回 Store。

项目围绕三个原则设计：

- **本地优先：** Store 与生成配置保留在本机。
- **变更前预览：** 下发、导入、配置和回滚都遵循 plan/apply 边界并产生持久 receipt。
- **引用而非明文密钥：** 生成文件保留受支持的环境变量或 cellarer 引用，不物化密钥真值。

## 状态与运行要求

cellarer 仍处于发布前阶段。公开 package 已准备为 `0.1.0-alpha.0`，但尚未发布，
因此目前受支持的使用方式是从本仓库构建并运行 CLI。

- Node.js `>=20.19`
- pnpm `10.12.1`
- Ubuntu、macOS 或 Windows

普通 Rule 与 MCP 文件支持上述三个平台；递归导入本地 Skill 目录目前要求 Darwin 或
Linux x64/arm64。

## 构建与运行

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.js --help
```

package 发布后，同一命令面将通过 `cellarer` 可执行文件提供。在此之前，下面的示例
使用源码构建产物路径。

## 第一次完整使用

创建或验证本地 Store。交互式文本模式会刷新实时 Inventory，只预选 Core 指定的 ready
候选，并在把这组精确候选导入 Library 前确认一次：

若 headless 机器没有 OS credential manager，请在 `init` 前配置受保护的
[mutation authority](docs/README.zh-CN.md#mutation-authority)。

```bash
node packages/cli/dist/bin.js init
```

拒绝确认会保留已完成的 Store 初始化且不导入任何资源。Inventory 为 partial 或 failed 时会
单独报告，并给出 `inventory refresh` 重试指引。Machine mode 返回闭合、脱敏的 Store 与
Inventory 阶段结果，不提示也不导入：

```bash
node packages/cli/dist/bin.js --output json init
node packages/cli/dist/bin.js --non-interactive init
```

Init 不再接受 `--agent`、`--no-agent` 或 structured `agents`。Agent target 只由后续独立
授权的下发命令选择。

只读刷新所有已注册的有界用户来源，或精确指定一个 adapter；添加 `--dir <project>`
可同时包含当前 project：

```bash
node packages/cli/dist/bin.js inventory refresh
node packages/cli/dist/bin.js inventory refresh --agent codex
```

Inventory 返回安全候选、provenance、findings、Store 匹配、计数与完整度，不会导入资源或
写入 agent target。

要将已审查的候选导入 Store，请使用精确 ID 生成 plan，再原样提交该命令返回的
`mutationPlan`。导入不会将资源下发到 agent target：

```bash
node packages/cli/dist/bin.js --output json inventory import plan \
  --candidate '<candidate-id>'
node packages/cli/dist/bin.js inventory import apply \
  --plan '<plan 返回的 mutationPlan JSON>'
```

使用仓库自己的 README 作为真实 Rule 输入，并用隔离目录作为 project target：

```bash
mkdir .cellarer-demo
node packages/cli/dist/bin.js add ./README.md
```

先预览，再使用相同选择执行下发：

```bash
node packages/cli/dist/bin.js apply --dry-run --agent codex --rules \
  --dir "$PWD/.cellarer-demo"
node packages/cli/dist/bin.js apply --agent codex --rules \
  --dir "$PWD/.cellarer-demo"
```

检查结果或进行回滚：

```bash
node packages/cli/dist/bin.js status --agent codex --dir "$PWD/.cellarer-demo"
node packages/cli/dist/bin.js revert --dry-run --agent codex \
  --dir "$PWD/.cellarer-demo"
node packages/cli/dist/bin.js revert --agent codex \
  --dir "$PWD/.cellarer-demo"
rmdir .cellarer-demo
```

显式 `--dir` 让本演练只触达 demo project；省略它会选择 agent 的真实全局配置。

启动仅监听 loopback 的 Web 控制台：

```bash
node packages/cli/dist/bin.js ui
```

## 管理范围

| 领域 | 主要操作 |
| --- | --- |
| Library | 刷新 Inventory；导入、检查、更新、重命名、删除、导出与 bundle 导入资源。 |
| Agents | 探测 agent、配置 adapter，并检查受支持的目标。 |
| 下发 | 按 agent、scope、collection 或 profile 预览和同步 rules、MCP servers 与 skills。 |
| 安全 | 验证漂移、保护目标所有权、恢复中断 operation，并按 receipt 回滚。 |
| Clients | 使用人类 CLI、版本化 JSON/JSONL 协议或经过认证的本地 `/api/v1`。 |

使用 `node packages/cli/dist/bin.js <command> --help` 查看精确选项。自动化调用方可通过
`capabilities` 与 `schema` 发现稳定的命令和 Schema 合同。

## 架构概览

cellarer 是 TypeScript monorepo。`@cellarer/core` 负责 Store、规划、mutation、安全和
adapter 逻辑；`@cellarer/cli` 与 `@cellarer/web` 是 Core 之上的薄接口。Core 通过注入的
`Env` 获取文件系统、环境、平台、时钟和凭据能力，使行为可测试，也避免表现层自行发明
mutation 规则。

核心概念、工作流、架构、安全、自动化、adapter 与发布流程见[详细文档](docs/README.zh-CN.md)。

## 开发

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

## License

MIT，见 [LICENSE](LICENSE)。
