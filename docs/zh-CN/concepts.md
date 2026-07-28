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
├── revision.json
├── operations/
│   ├── active.json
│   └── receipts/
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

- plan: 计算动作与预览,并将它们绑定到不可变的 mutation plan
- apply: 校验并执行这份精确的 mutation plan,然后发布台账

带版本的 mutation plan 包含 `planId`、operation、基础 store revision、
normalized inputs、有序 actions、target preconditions、过期策略和 canonical
digest。Apply 会在持有 store mutation lock 时校验 digest、revision、过期时间
与 target preconditions。无效或过期的 plan、过时 revision,或规划后发生变化的
target,都会在 target mutation 前被拒绝。

需要可复用授权的 Core 调用方可先调用 `planApplyMutation`,再把它返回的
精确 `mutationPlan` 交给 `applyMutationPlan`。便捷调用方（包括 CLI）会在同一个
receipt 边界内先 plan 再立即 apply。CLI `--dry-run` 会打印预览及其 mutation
identity;后续的非 dry-run CLI 调用会新建并执行一份 plan,因此仍要检查该次
调用的结果。

成功的 mutation 会返回 operation receipt,其中包含 operation 和 plan ids、plan
digest、基础与结果 revisions、outcome、时间戳,以及每个 action 的 before/after
receipt。已完成的 receipts 保留在 `operations/receipts/`。CLI 与 Web 响应只暴露
安全的 receipt 字段,不暴露 journal 的 recovery payloads。active journal 只保存
plan 与 state publication 的引用和 digest;原始 plan preview、渲染内容与 state
publication data 仅留在内存中,不会写入 journal。

Settings 与 adapter config、加密 vault 更新、add/scan collection 标签及项目
`.gitignore` 更新均属于已签名文件 actions。其 plan payload 会绑定精确 path、content
digest、mode 与观测到的 before-state;journal 只保留 durable action payload digest 和
receipts,原始 publication bytes 只留在内存中。Ledger `state.json` publication 保持
独立的 recovery 语义。项目 `.gitignore` action 必须在 ledger publication 与 revision
前取得 action receipt。

每个 action 都会在 executor 真正运行前再次比较已签名 target precondition。已签名文件
publication 还会在 action receipt 成功前校验实际文件 bytes 与必要 mode。任一边界发生
漂移都会留下 typed failed evidence,不会发布 committed receipt,也不会推进 revision。

非 publication 的 store actions 也会在 plan 中携带已签名 after-condition:成功记录
receipt 前,会从实际 target 读回并核验文件内容、目录或节点 fingerprint。协议 publication
（`state.json`、配置、vault、journal、revision 与 operation receipt）还会额外绑定并核验
POSIX mode。普通 managed file receipt 延续既有 content-fingerprint 模型,不会单独签名文件
顶层 POSIX mode;目录 fingerprint 则保持既有 node manifest 语义。

## 台账

`state.json` 记录已下发的 target、method、checksum、backup 和 secret refs。每个 project
owner 还会单独记录 canonical project root;它不改变物理 target identity,并让跨项目
revert 只重建各自真实的 `<project>/.gitignore`。`revision.json` 会随每次改变状态的
operation 单调递增。`status`、verification 与 `revert` 使用这些 evidence。

## 并发与中断 Operation 恢复

同一个 store 同时只允许一个改变状态的 operation 持有 mutation lock。竞争
operation 不会修改产品数据,并会返回带 owner evidence 的 `LOCK_CONFLICT`:operation id、
process id、hostname 和获取时间。绝不会仅因为 lock 较旧就删除它。

Operation（包括初始化）会在第一次产品写入前发布 write-ahead journal,然后持久化每个 action
outcome,最后原子发布下一份 state 和 revision。未完成的 journal 会以
`INTERRUPTED_OPERATION` 阻止后续 mutation。恢复步骤如下:

1. 停止该 store 的 apply 与 revert 调用。运行
   `node packages/cli/dist/bin.js doctor --json`,记录
   `mutationRecovery.operationId`、status 与 guidance。
2. 不要按存续时间删除 `mutation.lock`、`recovery.lock` 或
   `operations/active.json`,在评估 recovery evidence 期间也不要编辑受影响的 targets。
3. 当前 CLI 和 Web API 可诊断 recovery 状态,但没有暴露写侧 recovery 命令。
   可信的 `@cellarer/core` 调用方必须用诊断得到的精确 operation id 调用
   `recoverInterruptedOperation(env, storeRoot, { operationId,
   snapshotPassphrase })`。
4. Core 仅在所有规划的 after-states 都被证明,且每个必需的 state publication 已存在
   并匹配 durable digest 时完成 finalize。若 digest-only publication 缺失或不匹配,
   Core 不会猜测重建原始 state,而会返回 `MANUAL_RECOVERY_REQUIRED`。Core 只在 target
   存在已证明且可恢复的 before-state 时 compensate;否则返回带精确 targets 和 guidance 的
   `MANUAL_RECOVERY_REQUIRED`。手动恢复情况下,不可验证的 targets 保持不变。
5. 再次运行 `doctor --json`,然后对每个受影响的 agent 运行
   `status --agent <id> --json`。只有 recovery 为 `clean` 且两个 verification axes
   都收敛后才能恢复 mutations。

Recovery-artifact retention 会持有同一把 store mutation lock,并在 mutation 或 recovery
期间拒绝运行。当前不支持自动删除 receipts 与 snapshots:现有 Node/`Env` 文件系统接口
无法把 directory identity 与 no-follow delete 绑定为可信原子操作,因此 retention 会返回
`unsupported` 并保留所有 receipts 与 snapshots,而不会依赖 check-then-remove。Commit 后工作
仅限不会抛错的 best-effort activity notification。Apply 与 revert 都不会按已存路径删除
加密 snapshot;即使 `keepBackups: false`,也会保守保留并给出 warning,直到具备绑定 directory
identity 的 no-follow delete 原语。

## Verification Axes

Verification 分别报告三类独立信号:

- `desiredVsApplied`:当前资源选择、生成内容与 method,对比最后一次 apply 的
  ledger state。
- `appliedVsDisk`:最后一次 apply 的 receipts,对比当前 targets。
- `recovery`:任何未完成或需要人工恢复的 mutation。

因此,修改 collection 可能只使 `desiredVsApplied` 发生分歧,而 disk 仍完好;编辑
已 apply 的文件可能只使 `appliedVsDisk` 发生分歧,而 selection 仍匹配。只有
两个 axes 都是 `converged` 且 recovery 为 `clean` 时,`healthy` 才是 true。CLI
`status --agent <id> --json` 包含完整的 `verification` 报告;不传 `--agent`
时,`status` 只报告 ledger-versus-disk items。本地 Web API 通过 `POST /api/verify`
暴露同一份完整报告。

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

Ledger version 1,以及缺少 canonical `projectRoot` 的 pre-release project owner,都不会被
静默解释为当前所有权。`doctor` 会报告 ownership-state error,并要求执行 pre-release
reset。按以下流程恢复:

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
