# 快速开始

[文档索引](../README.md) | [English](../en/getting-started.md)

cellarer 当前从源码运行。workspace 包仍是 `private: true`,版本仍是 `0.0.0`。

## 前置要求

- Node.js `>=20.19`
- pnpm `10.12.1`

## 构建 CLI

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.js --help
```

下面的示例都使用构建后的 CLI 路径。公开包发布后,同一套命令面预期会通过
`cellarer` bin 暴露。

## 初始化库房

```bash
node packages/cli/dist/bin.js init
```

默认创建或复用 `~/.cellarer`。测试隔离环境可以设置 `CELLARER_HOME`。

## 导入制品

```bash
node packages/cli/dist/bin.js add ./my-rules.md
node packages/cli/dist/bin.js add ./context7.json
node packages/cli/dist/bin.js add ./my-skill/
node packages/cli/dist/bin.js add vercel-labs/skills --list
node packages/cli/dist/bin.js add vercel-labs/skills --skill nextjs --collection public
```

当前源码版本支持:

- `.md` 文件导入为 rules。
- `.json` 文件导入为 MCP server。
- 本地 skill 目录和父目录导入为 skills。
- GitHub `owner/repo`、repository URL 和 `/tree/<ref>/<subpath>` URL 可导入
  skills。

远程 skill 导入会在 `store/metadata/skills/<name>.json` 写入 provenance。
GitLab 与 arbitrary git URLs 不属于本里程碑支持范围。

## 列出库房制品

```bash
node packages/cli/dist/bin.js ls
node packages/cli/dist/bin.js ls --collection default
```

## 检查 Agent

```bash
node packages/cli/dist/bin.js agents
node packages/cli/dist/bin.js doctor
```

用 `agents --dir <path>` 或 `doctor --dir <path>` 查看 project scope 目标。
两个命令都支持 `-a, --agent <ids>` 和 `--json`。

## 预览与下发

先预览:

```bash
node packages/cli/dist/bin.js apply --dry-run --agent claude-code,codex --rules --mcp --skills
```

确认计划后再执行:

```bash
node packages/cli/dist/bin.js apply --agent claude-code,codex --rules --mcp --skills
```

使用 `--dir <path>` 表示 project scope。不传 `--dir` 时写入各 agent 的 global
位置。

## 扫描已有 agent 配置

```bash
node packages/cli/dist/bin.js scan --agent codex --dry-run --json
node packages/cli/dist/bin.js scan --agent codex --into-collection default
```

`scan` 一次只接受一个 agent。计划输出不包含密钥真值,只返回密钥引用名。

## 检查与回滚

```bash
node packages/cli/dist/bin.js status
node packages/cli/dist/bin.js revert --agent claude-code,codex
```

`revert` 使用 `apply` 写入的台账。如果不传 agent 或目录选择器就要回滚全部,
必须显式传 `--all`。

## 启动 Web UI

```bash
node packages/cli/dist/bin.js ui
node packages/cli/dist/bin.js ui --port 4317 --token local-token
```

服务只监听 `127.0.0.1`。
