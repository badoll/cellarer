# cellarer

> One central store for your AI agents' **skills / MCP / rules** — maintain once, distribute to any agent, scan back, with channel separation and secret safety.

`English` · [简体中文](#简体中文)

A local-first tool to centrally manage `skills`, MCP servers, and rules
(`AGENTS.md` / `CLAUDE.md`) across multiple AI coding agents (Claude Code,
Codex, Cursor, Gemini, opencode, windsurf, …). Bidirectional sync
(distribute + scan), channel-based separation (common / internal / custom),
layered secret handling (env ref → age vault → OS keychain), and a local web
console.

## Quick start

```bash
# initialize the global store at ~/.cellarer
npx cellarer init

# import artifacts from a local path into the store
npx cellarer add ./my-rules.md          # → store/rules
npx cellarer add ./context7.json        # → store/mcp
npx cellarer add ./my-skill/            # → store/skills

# preview then distribute rules + skills + mcp to agents
npx cellarer apply --dry-run -a claude-code,codex --rules --skills --mcp
npx cellarer apply -a claude-code,codex --rules --skills --mcp

# check drift, then roll back
npx cellarer status
npx cellarer revert -a claude-code,codex

# launch the local web console (127.0.0.1 only)
npx cellarer ui
```

## Commands

| Command | Purpose |
| --- | --- |
| `cellarer init` | Initialize the global store (`~/.cellarer`). |
| `cellarer add <source>` | Import artifacts into the store (local path; `owner/repo` / URL are stubbed). |
| `cellarer ls` | List store artifacts (rules / mcp / skills) and channel tags. |
| `cellarer apply` | Distribute artifacts to agents (`--dir`, `--rules`, `--mcp`, `--skills`, `--copy`, `--dry-run`). |
| `cellarer scan` | Scan an agent's config back into the store (import). |
| `cellarer status` | Drift detection (store ledger vs on-disk). |
| `cellarer revert` | Roll back a distribution using the ledger. |
| `cellarer secret` | Secret management (`add` / `ls` / `rm`). |
| `cellarer ui` | Launch the local web console (127.0.0.1 only). |

## Architecture

TypeScript monorepo: `@cellarer/core` (all business logic) + `@cellarer/cli` +
`@cellarer/web`. Design invariants: **core-first** (cli/web are thin shells);
**side effects via an injected `Env`** (core never imports `node:fs` directly);
**plan / apply separation**; **new agents via declarative adapters** (no engine
branching); **idempotent + revertible** via a `state.json` ledger; and a
**zero-plaintext-secrets** red line — the store and distributed output never
contain plaintext secrets (env `${VAR}` references, an age vault, or the OS
keychain hold real values).

Design and background: [docs/kickoff.md](docs/kickoff.md). Docs index:
[docs/README.md](docs/README.md).

## Development

```bash
pnpm build      # tsc -b across packages + Vite SPA
pnpm test       # vitest (core / cli / web)
pnpm lint       # Biome
pnpm typecheck  # tsc -b
```

CI runs the four gates on Ubuntu / macOS / Windows.

## License

MIT — see [LICENSE](LICENSE).

---

## 简体中文

> 面向「一台机器上多个 AI agent」的 **skills / MCP / rules 全局统一管理工具** —— 在中央「库房」维护一份真源,按需下发到任意 agent,并能反向扫描回收,内置通用/内网场景分治与密钥安全防护。

本地优先(local-first),跨多个 AI 编码 agent(Claude Code、Codex、Cursor、Gemini、opencode、windsurf……)统一管理 `skills`、MCP server、规则(`AGENTS.md` / `CLAUDE.md`)。双向同步(下发 + 扫描回写)、通道分治(common / internal / custom)、密钥分层(env 引用 → age vault → 系统 keychain)、本地 Web 控制台。

### 快速上手

```bash
# 初始化全局库房(~/.cellarer)
npx cellarer init

# 从本地路径导入制品到库房
npx cellarer add ./my-rules.md          # → store/rules
npx cellarer add ./context7.json        # → store/mcp
npx cellarer add ./my-skill/            # → store/skills

# 先预览再下发 rules + skills + mcp
npx cellarer apply --dry-run -a claude-code,codex --rules --skills --mcp
npx cellarer apply -a claude-code,codex --rules --skills --mcp

# 漂移检测,再回滚
npx cellarer status
npx cellarer revert -a claude-code,codex

# 启动本地 Web 控制台(仅 127.0.0.1)
npx cellarer ui
```

### 命令面

| 命令 | 说明 |
| --- | --- |
| `cellarer init` | 初始化全局库房(`~/.cellarer`)。 |
| `cellarer add <source>` | 导入制品到库房(本地路径;`owner/repo` / URL 暂为友好桩)。 |
| `cellarer ls` | 列出库房制品(rules / mcp / skills)及通道标签。 |
| `cellarer apply` | 下发制品到 agent(`--dir` / `--rules` / `--mcp` / `--skills` / `--copy` / `--dry-run`)。 |
| `cellarer scan` | 扫描 agent 配置回写库房(import)。 |
| `cellarer status` | 漂移检测(库房台账 vs 落地)。 |
| `cellarer revert` | 依据台账回滚下发。 |
| `cellarer secret` | 密钥管理(`add` / `ls` / `rm`)。 |
| `cellarer ui` | 启动本地 Web 控制台(仅 127.0.0.1)。 |

### 架构

TypeScript monorepo:`@cellarer/core`(全部业务逻辑)+ `@cellarer/cli` + `@cellarer/web`。架构不变量:**core-first**(cli/web 薄壳);**副作用经 `Env` 注入**(core 不直接 import `node:fs`);**plan / apply 分离**;**新增 agent 走声明式适配器**(引擎无分支);**幂等可回滚**(`state.json` 台账);**密钥零明文红线** —— 库房与下发产物绝不含明文密钥(用 env `${VAR}` 引用 / age vault / 系统 keychain 承载真值)。

设计与背景见 [docs/kickoff.md](docs/kickoff.md);文档索引见 [docs/README.md](docs/README.md)。

### 开发

```bash
pnpm build      # 各包 tsc -b + Vite SPA
pnpm test       # vitest(core / cli / web)
pnpm lint       # Biome
pnpm typecheck  # tsc -b
```

CI 在 Ubuntu / macOS / Windows 三平台执行四关。

### 许可

MIT —— 见 [LICENSE](LICENSE)。
