# cellarer

[English](README.md) | `简体中文`

> 面向多 AI coding agent 的本地 skills / MCP / rules 统一管理工具。一处维护,
> 按需下发到多个 agent,也可以扫描已有配置回写库房,并避免生成文件落入明文密钥。

cellarer 适合同时使用多个 AI coding agent 的本机开发环境。它统一管理三类资源:

- rules,例如 `AGENTS.md`、`CLAUDE.md` 或 agent 专属规则文件
- MCP server 定义,并按各 agent 原生 JSON / TOML 格式写回
- skills 目录

当前仓库仍处于发布前状态。workspace 包仍是 `private: true`,版本仍是 `0.0.0`,
因此在 npm 发布 checklist 完成前,请从源码构建后运行。

## 快速开始

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.js --help
```

初始化本机 cellarer 库房:

```bash
node packages/cli/dist/bin.js init
```

导入本地资源:

```bash
node packages/cli/dist/bin.js add ./my-rules.md
node packages/cli/dist/bin.js add ./context7.json
node packages/cli/dist/bin.js add ./my-skill/
```

预览、下发、检查与回滚:

```bash
node packages/cli/dist/bin.js agents
node packages/cli/dist/bin.js doctor
node packages/cli/dist/bin.js apply --dry-run --agent claude-code,codex --rules --mcp --skills
node packages/cli/dist/bin.js apply --agent claude-code,codex --rules --mcp --skills
node packages/cli/dist/bin.js status
node packages/cli/dist/bin.js revert --agent claude-code,codex
```

启动本地 Web 控制台:

```bash
node packages/cli/dist/bin.js ui
```

## 命令

| 命令 | 用途 |
| --- | --- |
| `init` | 初始化 `~/.cellarer` 或 `CELLARER_HOME` 指向的库房。 |
| `add <source>` | 将本地 rules/MCP 文件或本地/GitHub skill 来源导入库房。 |
| `ls` | 列出库房中的 rules、MCP、skills 与 collection 标签。 |
| `agents` | 展示已注册 agent adapter、探测结果、能力与目标路径。 |
| `doctor` | 检查库房初始化、adapter 加载、agent 探测和目标路径写权限。 |
| `apply` | 生成计划并同步资源到选中的 agent。写入前建议先用 `--dry-run`。 |
| `scan` | 读取 agent 原生配置,规范化后导入库房。 |
| `status` | 检查台账中的漂移、缺失目标和断链。 |
| `revert` | 根据台账回滚已下发内容。 |
| `secret` | 通过引用名管理加密 vault 中的密钥。 |
| `ui` | 在 `127.0.0.1` 启动本地 Web 控制台。 |

完整说明见 [CLI 参考](docs/zh-CN/cli-reference.md)。

## 架构

cellarer 是 TypeScript monorepo:

- `@cellarer/core` 承载全部业务逻辑。
- `@cellarer/cli` 只解析命令行参数并调用 core。
- `@cellarer/web` 通过本地 Hono API 与 React UI 暴露 core 能力。

core 通过注入的 `Env` 获取文件系统、home、cwd、platform 和时间。下发被拆成
plan 与 apply 两个阶段,每次落地都会写入台账,因此 status 与 revert 可以稳定工作。

更多内容见 [架构](docs/zh-CN/architecture.md) 与 [安全](docs/zh-CN/security.md)。

## 文档

- [文档索引](docs/README.md)
- [快速开始](docs/zh-CN/getting-started.md)
- [核心概念](docs/zh-CN/concepts.md)
- [自定义适配器](docs/zh-CN/adapters.md)
- [Web UI](docs/zh-CN/web-ui.md)
- [发布 checklist](docs/zh-CN/maintainers/release.md)

## 开发

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

CI 预期在 Ubuntu、macOS、Windows 三个平台运行这些检查。

## 许可

MIT,见 [LICENSE](LICENSE)。
