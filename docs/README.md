# cellarer 文档

cellarer:多 AI agent 的 skills / mcp / rules **全局统一管理工具**(纯配置管理 + 下发 + 扫描回写 + 可视化)。
TypeScript monorepo:`@cellarer/core`(全部能力)+ `@cellarer/cli` + `@cellarer/web`。

## 索引

- [kickoff.md](kickoff.md) — 立项设计与背景(目标 / 架构 / 数据模型 / 下发 / 扫描 / 密钥 / 里程碑)。
- [v1-completion.md](v1-completion.md) — v1 完成情况(里程碑 / 安全红线 / 未做项 / 待手动执行)。
- [cross-eval-vs-cellarer.md](cross-eval-vs-cellarer.md) — 与另一份独立实现(cellarer)的横评报告 + **后续优化 Backlog**(§5 为落点)。
- 设计文档(按里程碑):
  - [design/m2-mcp-skills-secrets.md](design/m2-mcp-skills-secrets.md) — mcp/skills 下发 + 密钥分层。
  - [design/m3-scan-import.md](design/m3-scan-import.md) — 扫描回写(scan / import)。
  - [design/m4-web-ui.md](design/m4-web-ui.md) — Web UI(Hono RPC + React SPA)。
  - [release.md](release.md) — npx 发布步骤(待手动执行)。
- 适配器:
  - [adapters/README.md](adapters/README.md) — 声明式自定义适配器编写指南 + 示例。

> M1(rules 下发闭环)的设计并入 kickoff §6–§8;实现细节见各模块源码注释。

## 命令面(`cellarer <cmd>`)

| 命令 | 说明 |
| --- | --- |
| `init` | 初始化库房(`~/.cellarer`,或 `CELLARER_HOME`) |
| `ls` | 列出库房 rules/mcp/skills 制品及通道标签 |
| `apply` | 下发到 agent(`--agent/--dir/--channel/--rules/--mcp/--skills/--copy/--mcp-overwrite/--secret-mode/--dry-run`) |
| `scan` | 扫描 agent 现有配置回写库房(密钥自动脱敏;`--conflict/--select/--into-channel/--dry-run/--json`) |
| `revert` | 依据台账回滚(`--agent/--dir/--all/--keep-backups`) |
| `status` | 漂移检测(`--json` 供 CI) |
| `secret` | age vault 密钥管理(`add/ls/rm`;ls 只列名) |
| `ui` | 本地 Web UI(仅 127.0.0.1;`--port/--token`) |

## 架构不变量

见 [AGENTS.md](../AGENTS.md):core-first / 副作用经 Env 注入 / plan-apply 分离 / 新 agent 走适配器 /
幂等可回滚 / **密钥零明文**(库房与下发产物绝不出现明文,用 `${ENV}` 或 `${CELLARER_SECRET:..}` + age vault / keychain)。

## 开发

`pnpm build` / `pnpm test` / `pnpm lint` / `pnpm typecheck`(CI 三平台 ubuntu/macos/windows)。
TDD:Vitest + mkdtemp 临时目录 + 注入 fake Env。
