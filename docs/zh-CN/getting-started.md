# 快速开始

[文档索引](../README.md) | [English](../en/getting-started.md)

cellarer 当前从源码运行。Package metadata 已准备为 `0.1.0-alpha.0`,但尚未发布。

## 前置要求

- Node.js `>=20.19`
- pnpm `10.12.1`
- Ubuntu、macOS 或 Windows

## npm 安装（发布后）

npm package 尚未发布。`@cellarer/cli` 发布后,支持的安装与单次运行命令为:

```bash
npm install --global @cellarer/cli
cellarer --help
npx @cellarer/cli --help
```

CLI 安装会带入同步版本的发布包组:`@cellarer/core` 包含运行时逻辑与随包 adapter
配置,`@cellarer/web` 包含 server 与已构建 client assets,`@cellarer/cli` 包含已编译
的可执行入口。正式发布前请使用下面的源码构建方式。

## 构建 CLI

```bash
pnpm install
pnpm build
node packages/cli/dist/bin.js --help
```

下面的示例都使用构建后的 CLI 路径。发布后,同一套命令面将通过 `cellarer` bin
暴露。

## 初始化库房

```bash
node packages/cli/dist/bin.js init --agent codex,claude-code
```

默认创建或复用 `~/.cellarer`。测试隔离环境可以设置 `CELLARER_HOME`。初始化会报告
detected/configured inventory,并且只启用 `--agent` 指定的精确 adapter ID。省略 target
返回 `INPUT_REQUIRED`;命令绝不会隐式选中所有 detected agents。

## 导入资源

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

## 列出库房资源

```bash
node packages/cli/dist/bin.js ls
node packages/cli/dist/bin.js ls --collection default
node packages/cli/dist/bin.js resource list --kind rules
node packages/cli/dist/bin.js resource show rules/my-rules
```

需要 stable ID、provenance、validation、collection membership、desired selection 与
applied usage 时使用 `resource list/show`。Mutation 命令使用 `rules/my-rules` 这样的
不可变 ID,而不是 resource name。

## 检查 Agent

```bash
node packages/cli/dist/bin.js agents
node packages/cli/dist/bin.js doctor
node packages/cli/dist/bin.js agent list --scope project --dir /path/to/project
node packages/cli/dist/bin.js agent show codex --scope global
```

用 `agents --dir <path>` 或 `doctor --dir <path>` 查看 project scope 目标。
两个命令都支持 `-a, --agent <ids>` 和 `--json`。

## 管理 Agent、Collection 与设置

```bash
node packages/cli/dist/bin.js agent configure codex \
  --adapter '{"displayName":"Codex Local"}' --dry-run
node packages/cli/dist/bin.js agent add my-agent \
  --adapter '{"displayName":"My Agent","rules":{"project":"{dir}/.my-agent/RULES.md"}}'
node packages/cli/dist/bin.js collection create work \
  --resource rules/my-rules --description "工作资源"
node packages/cli/dist/bin.js collection defaults set --collection default,work
node packages/cli/dist/bin.js config update --settings '{"method":"copy"}'
```

任何 control-plane mutation 都可先传 `--dry-run`,只取得带 revision 的 plan,不改变
Store 或 target。内置 patch 位于 `adapterOverrides`;声明式自定义 agent 位于
`customAdapters`。
应提交这个 exact plan,而不是重复 mutation inputs:

```bash
PLAN_JSON=$(node packages/cli/dist/bin.js --output json \
  config update --settings '{"method":"copy"}' --dry-run | \
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).data.plan)))')
node packages/cli/dist/bin.js --output jsonl apply --plan "$PLAN_JSON"
```

所有 agent/adapter、collection membership/default 与 typed config mutation 都支持
这个 round trip。Plan 只包含 reference-safe publication bytes。Planning 到 mutation
lock 之间只要 revision、config、ledger、artifact membership 或 target 发生变化,plan
就会被拒绝且不产生 receipt。

## 预览与下发

先生成 exact serializable distribution plan:

```bash
PLAN_JSON=$(node packages/cli/dist/bin.js --output json plan \
  --agent claude-code,codex --scope global --rules --mcp --skills | \
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).data.plan)))')
```

检查后应用同一个 authority-sealed plan:

```bash
node packages/cli/dist/bin.js --output jsonl apply --plan "$PLAN_JSON"
```

`--agent` 只在 planning 路径（`plan`、直接 `apply` 或 `apply --dry-run`）必填,
`apply --plan` 不需要。顶层 `plan` 返回 `{ plan: <sealed-plan>, preview }`;
distribution dry-run/apply 返回 `{ plan: <preview>, entries, failures, mutation }`,仅在
执行后于 `mutation.result.receipt` 出现 receipt。Settings dry-run 返回
`{ plan, changedFields }`;settings `apply --plan` 还会返回 `mutation`,成功时也返回
`receipt`。

使用 `--dir <path>` 表示 project scope。不传 `--dir` 时写入各 agent 的 global
位置。Structured input 需把未改动的 plan 对象放入 `apply` request 的 `input.plan`;
不要同时提交 agents、capabilities、`dir`、acknowledgements 或 `dryRun`。

## 扫描已有 agent 配置

```bash
node packages/cli/dist/bin.js scan --agent codex --dry-run --json
node packages/cli/dist/bin.js scan --agent codex --rules --into-collection default \
  --select '[{"kind":"rules","name":"team","source":"/absolute/path/AGENTS.md"}]'
```

`scan` 一次只接受一个 agent。计划输出不包含密钥真值,只返回密钥引用名。Mutating
`--select` 是从 preview 复制的完整 `kind`、`name`、`source` selector JSON 数组;
name-only 输入会被拒绝。

## 检查与回滚

```bash
node packages/cli/dist/bin.js status
node packages/cli/dist/bin.js verify --scope project --dir /path/to/project \
  --agent claude-code,codex --rules
node packages/cli/dist/bin.js operation list
node packages/cli/dist/bin.js --output json operation recover operation-<id> --dry-run
node packages/cli/dist/bin.js --output json operation recover operation-<id>
node packages/cli/dist/bin.js revert --agent claude-code,codex
```

`revert` 使用 `apply` 写入的台账。如果不传 agent 或目录选择器就要回滚全部,
必须显式传 `--all`。
Recovery 必须先用 `--dry-run` 诊断。如果结果为 `RECOVERY_REQUIRED`,请遵循 typed
evidence 并保留 lock/journal;不要手动删除。

## 启动 Web UI

```bash
node packages/cli/dist/bin.js ui
node packages/cli/dist/bin.js --output json ui --port 0 \
  --token-fd 3 --lifetime-fd 4 3< /path/to/ui-token 4< /path/to/lifetime-pipe
```

服务只监听 `127.0.0.1`。第一条命令使用随机的内置 browser session。第二条使用
managed bearer 认证,并在 lifetime descriptor 到达 EOF 时关闭；唯一 machine-output
record 会报告 OS 分配的端口,但不会暴露 token。
