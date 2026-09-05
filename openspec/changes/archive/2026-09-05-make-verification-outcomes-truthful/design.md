## Context

当前验证基于计划 action、ledger、磁盘与恢复状态。plan 会将未知 Agent 或失败能力跳过，verify 过滤这些 action 后可能对空数组作全称判断。Core 的事实需要在 CLI/API/Web 中保持一致。

## Goals / Non-Goals

**Goals:** 让请求覆盖不丢失，提供一致的 configuration health；为后续兼容性与部署模型提供稳定结果轴。

**Non-Goals:** 不执行 Agent 或 MCP、不改变 apply 授权和事务协议、不修复适配路径、不设计持续同步。

## Decisions

### 1. Coverage 是请求的投影

在规划边界保留 request key = Agent + scope + capability 和 typed outcome，不从 warning 字符串解析原因。未知 Agent 为输入错误；已知但 unsupported/disabled 或失败时返回明确 coverage。重复输入规范化去重，不通过减少 expected 项制造 complete。

### 2. 配置健康与原生加载证据分离

输出 configuration 状态 healthy/unhealthy/no-op/incomplete；沿用 healthy 布尔，仅完整覆盖且存在已验证目标并满足三个原有轴时为 true。合法空选择输出 no-op 且 healthy=false；未请求/未执行原生探针时 runtime observation=unknown。后续探针可填独立字段，不能改变文件健康含义。

验证的 recovery 轴仅观察 journal 与 mutation/recovery 锁，不调用获取 authority lease 的恢复诊断。三者均不存在才报告 clean；存在遗留状态或读取失败时保守报告 manual-recovery-required，并保留可读的 operation/plan 标识。它不认证 journal、不推断可自动恢复或 completed-pending-cleanup，也不改变实际 recover 的授权和执行合同。规划按请求键隔离失败，使用固定 typed code，不回传解析异常中的原始资源内容。

### 3. 跨端结果是同一合同

Core 增加字段后同步 CLI schema、HTTP metadata 与 browser-safe DTO；保留版本化 envelope。新增公开 DTO/错误类型和可选 typed planning observation 参数时，同步 Core packed export/signature baseline；快照仅记录本 change 明确引入的差异。未知 Agent 使用已有 invalid-input exit class，incomplete/unhealthy 使用已有 domain-error class，合法 no-op 使用 success class；人类渲染不可单凭 HTTP 200 或空 items 写验证通过。

### 4. 边界而非重写计划引擎

只补充 typed planning coverage 和验证判定，不重建 mutation 或解析自由文本 reason。对既有健康案例保持三个比较轴含义。

## Risks / Trade-offs

[新增必需 DTO 字段影响闭合 schema] → 一组 Core/CLI/HTTP fixtures 同步验证。[健康布尔变严格影响脚本] → 双语说明与明确 no-op outcome。[扫描失败被吞掉] → 输入矩阵同时断言 expected/observed/failed 数目。

## Migration Plan

无持久状态迁移。更新 schema 及调用方后发布同一 package set；保留已有字段，文档注明布尔纠正。发现需要删除或重命名 wire 字段时先更新本 change 的兼容性设计，不隐式引入第二套版本。

## Acceptance Matrix

以下矩阵在开始实现前固定；实现中新发现跨边界问题必须先更新设计，不能用临时豁免降低验收标准。

| 输入或状态 | 必须证明的结果 |
| --- | --- |
| 未知 Agent | invalid-input；不生成健康报告；零 mutation/provider 调用 |
| unsupported / disabled | 明确未覆盖请求；configuration=incomplete；healthy=false |
| 合法空 Store / 空选中集合 | configuration=no-op；不能表述为原生加载通过 |
| 规划失败或部分能力失败 | 失败原因有 typed code；其他结果保留；整体不能健康 |
| 选中目标一致且恢复 clean | configuration=healthy；runtime=unknown 仍被单列 |
| 目标漂移 / pending recovery | 原有比较轴保持区分；healthy=false |

## Open Questions

本提案没有需要现在阻塞整理的产品选择。原生版本、依赖归档后的字段与新测试路径属于实施前的证据校准；不得将待核验信息写为通过。若新增生产依赖、原生工具执行、破坏性迁移或领域范围变化成为必要条件，应先完成可审查方案并处理对应授权边界。

## Execution and verification boundary

按 proposal 的依赖串行实施；每次只推进一个有界任务组，由同一 writer 完成首轮修复。做一次集成审查；高风险 change 对上述矩阵做一次对抗审查。修复后只复查 findings 与受影响路径；同类重要问题复现时先修改 OpenSpec，避免无限审查。全量 gate 仅列在 tasks 的 closure；spec sync、archive 与 Git 操作分别处理，不把提案完整视为实现完成。

## Program architecture and navigation

本轮价值标准为：用户能明确表达需要的能力，理解实际生效范围，并持续安全地增加、减少和切换配置。技术验收不以命令数量、测试数量或写盘成功替代用户结果。

共同模型：Resource 保留不可变身份和来源 revision；Profile 表达期望；Deployment 记录已物化内容、receipt 和消费者；Adapter 分别发现来源、解释生效规则和编译目标；现有事务内核执行原样授权计划。CLI/Web 是薄输入与展示边界。

| 顺序 | Change | 独立结果 |
| --- | --- | --- |
| 1 | [make-verification-outcomes-truthful](../make-verification-outcomes-truthful/proposal.md) | 让验证结果准确表达请求覆盖与配置状态 |
| 2 | [preserve-web-sync-selection](../preserve-web-sync-selection/proposal.md) | 保证 Web 筛选与同步选择一致 |
| 3 | [calibrate-builtin-agent-compatibility](../calibrate-builtin-agent-compatibility/proposal.md) | 校准内置 Agent 路径与兼容性声明 |
| 4 | [model-shared-target-deployments](../model-shared-target-deployments/proposal.md) | 分离物理目标所有权与 Agent 消费关系 |
| 5 | [reconcile-sync-profile-deployments](../reconcile-sync-profile-deployments/proposal.md) | 让 Profile 通过受管增量持续收敛 |
| 6 | [separate-inventory-discovery-from-placement](../separate-inventory-discovery-from-placement/proposal.md) | 独立声明来源与生效优先级 |
| 7 | [preserve-resource-semantics-across-adapters](../preserve-resource-semantics-across-adapters/proposal.md) | 让资源转换保留可表达的语义 |
| 8 | [complete-human-resource-management-workflows](../complete-human-resource-management-workflows/proposal.md) | 闭合面向人的资源管理工作流 |

此导航只表达设计边界和依赖，不记录第二份完成进度。唯一任务状态是各 change 的 tasks；本导航用于当前活动提案审阅；归档后以 change ID、现行 specs 与 `openspec list` 定位后续工作，不为维护导航修改历史归档。未来跨机器 lockfile、云服务、Marketplace、自动分发和任意 Agent 编排均不属于本轮。
