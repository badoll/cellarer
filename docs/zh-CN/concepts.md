# 核心概念

[文档索引](../README.md) | [English](../en/concepts.md)

## 库房

库房是本机唯一真源。默认位于 `~/.cellarer`;也可以用 `CELLARER_HOME`
指向另一个库房。

典型结构:

```text
~/.cellarer/
├── store/
│   ├── rules/
│   ├── mcp/
│   └── skills/
├── config.json
├── state.json
└── secrets/
```

## 资源

资源是 cellarer 库房里的一个可复用单元:

- rule 文件或 rule 片段
- 一个 canonical MCP server 定义
- 一个 skill 目录

## Collection

Collection 是库房里的资源集合。默认 collection 是 `default`。用户可以创建
`work`、`personal` 或 `internal` 等集合,并把某个 collection 同步到选中的
target agents。

## Agent Adapter

适配器知道某个 agent 的 rules、MCP servers、skills 存放位置。基础适配器随包发布;
`config.json` 保存内置适配器的 key-based override,以及新增 agent 的自定义适配器。

## Scope

Scope 决定资源落点:

- `global`: agent 的家目录配置
- `project`: 通过 `--dir` 指定的项目目录

## Plan 与 Apply

下发被拆成两个阶段:

- plan: 计算动作与预览
- apply: 执行计划并写入台账

`--dry-run` 只返回 plan。

## 台账

`state.json` 记录已下发的 target、method、checksum、backup 和 secret refs。
`status` 与 `revert` 使用这份台账工作。

## Target 所有权与显式替换

cellarer 为每个规范化后的物理 target 只记录一个当前 owner。Owner identity 由
agent、scope、capability 和 target path 组成;参与生成该 target 的 artifact ids
只是来源信息,不是互相独立的 owners。例如,同一个 agent 配置文件的 MCP 选择发生
变化时,cellarer 会更新这个 target 的 owner,不会新增可分别回滚的 MCP 条目。

写入前,plan 会把 target 分类为 `absent`、`owned-current`、`owned-drifted`、
`unowned-existing` 或 `invalid-owner`。后三类默认阻止写入,从而避免静默替换同名的
非托管 Skill,或覆盖 apply 之后被用户编辑过的文件。

Core 与本地 Web API 调用方可以分两步显式替换被阻止的 target:

1. 先生成 plan,从 conflict 的 `acknowledgement` 读取精确 token。
2. 用相同选择再次 apply:非托管 target 把 token 放入 `replaceUnowned`,已漂移 owner
   把 token 放入 `overrideDrift`,并同时提供 `snapshotPassphrase`。

Token 与 target 及检查时的 receipt 绑定,两种 token 不能混用。替换前,cellarer 必须
先在 `snapshots/` 下持久化权限受限的加密快照。Passphrase、target 明文内容与明文凭据
都不会写入 store 或 ledger。只要快照捕获、加密或存储失败,apply 就会保持 target 与
所有权状态不变。

Revert 同样要求先生成 plan。漂移 target 会保持 blocked,直到调用方提交该 revert plan
返回的精确 acknowledgement。存在 before-state snapshot 的 target 会从快照恢复;
由 cellarer 新建的 target 也只会在当前 receipt 仍有效时删除。

## Pre-release 所有权状态重置

Ledger version 1 不会被静默解释为当前所有权。`doctor` 会报告 ownership-state error,
并要求执行 pre-release reset。按以下流程恢复:

1. 停止 apply 与 revert。备份 `state.json` 及其中描述的每个 target。条件允许时,
   先用兼容旧台账的 cellarer build 回滚这些 targets。
2. 移走旧台账而非直接删除:

   ```bash
   STORE_ROOT="${CELLARER_HOME:-$HOME/.cellarer}"
   BACKUP_PATH="$STORE_ROOT/state.pre-v2.$(date +%Y%m%d%H%M%S).json"
   mv "$STORE_ROOT/state.json" "$BACKUP_PATH"
   node packages/cli/dist/bin.js doctor --json
   ```

3. 对准备下发的 agents 与 capabilities 运行 `apply --dry-run`。仍存在的物理 target
   此时属于 unowned 并会被阻止;不要直接删除。只删除已经核实且完成备份的 target,
   或使用上面的精确替换流程,让 cellarer 记录加密 before-state。
4. 只有在预览中没有非预期 ownership conflicts 后才再次 apply。

在所有 targets 都完成核实或恢复前保留旧台账备份。不要让当前 build 使用 ledger
version 1,也不要让旧 build 使用 ledger version 2。

## 密钥

库房资源与生成文件不应包含明文密钥。资源应使用环境变量引用,例如
`${OPENAI_API_KEY}`,或 cellarer 密钥引用,例如
`${CELLARER_SECRET:OPENAI_API_KEY}`。

## 非目标

cellarer 不运行 MCP proxy,不提供云端 registry,不管理 agent 安装,也不提供多人服务端。
