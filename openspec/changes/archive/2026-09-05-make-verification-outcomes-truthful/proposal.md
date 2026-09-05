## Why

用户不能从绿色健康状态判断请求是否真正被处理。未知 Agent、未支持能力和规划失败被跳过后，空集合可能被报告为收敛，需要先建立可信的成功定义。

## What Changes

- 建立按请求 Agent、scope、capability 归一的 typed coverage，保留 unsupported、disabled、blocked、failed 与合法空选择。
- 保留 desired/applied、applied/disk、recovery 三个轴，明确 healthy 仅指配置健康，并以 coverage 完整为前提。
- CLI、HTTP 与 Web 使用同一 Core 结果；运行时加载证据单列为 unknown，不以文件一致推断 Agent 已加载。
- **BREAKING**：此前被误判成功的验证结果改为非健康或输入错误，机器调用方不得再把它们当成功。

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `transactional-local-mutations`: 验证保留请求覆盖，区分合法无操作与失败跳过。

## Impact

增加验证 DTO 的 coverage 与显式配置结果，保留既有比较轴与 healthy 字段；通过当前版本化边界同步 schema、fixtures 和渲染。明确既有 CLI exit-class 对该结果的映射，不增设协议版本别名。

## Non-goals

不执行 Agent 或 MCP、不改变 apply 授权和事务协议、不修复适配路径、不设计持续同步。

## Execution Contract

- Risk: integration
- Depends on: none
- Allowed paths: `packages/core/src/engine/verification.ts`, `packages/core/src/engine/plan.ts`, `packages/core/src/engine/types.ts`, `packages/core/src/protocol/client-types.ts`, `packages/core/src/protocol/client.ts`, `packages/core/src/control-plane.ts`, `packages/core/src/dashboard.ts`, `packages/core/src/index.ts`, `packages/cli/src/commands/control-plane-read.ts`, `packages/cli/src/commands/status.ts`, `packages/cli/src/protocol/command-schema-fragments.ts`, `packages/cli/src/protocol/schemas.ts`, `packages/cli/src/commands/diagnostics-service-catalog.ts`, `packages/cli/tests/control-plane-read-commands.test.ts`, `packages/cli/tests/http-read-parity.test.ts`, `packages/cli/tests/fixtures/**`, `packages/web/src/api-contract.ts`, `packages/web/src/app.ts`, `packages/web/client/product-model.ts`, `packages/web/client/App.tsx`, `packages/web/tests/api-contract.test.ts`, `packages/web/tests/dashboard-model.test.ts`, `packages/core/tests/transaction-verification.test.ts`, `packages/core/tests/control-plane.test.ts`, `packages/core/tests/verification-coverage.test.ts`, `packages/core/tests/fixtures/package-exports-baseline.ts`, `README.md`, `README.zh-CN.md`, `docs/README.md`, `docs/README.zh-CN.md`, `openspec/changes/make-verification-outcomes-truthful/**`, `openspec/specs/transactional-local-mutations/spec.md`

## Program position

本轮第 1/8 个 change：让验证结果准确表达请求覆盖与配置状态。依赖既约束状态合同，也规定本轮串行实施顺序；不表示两个变更可以并行写入。本 change 是唯一的首个实施入口。后续提案：[preserve-web-sync-selection](../preserve-web-sync-selection/proposal.md)。

前置 change 归档后，以同步后的 main specs、当前路径与合同重新校准本提案、设计和任务，再运行 preflight；若发现新增能力或无法独立验收的任务组，应先调整 OpenSpec。后续细节不具有覆盖已归档合同的优先权。单个 change 完成验证、spec sync 与 archive 后才切换下一个。此提案不授权 commit、push、发布或真实 Agent/第三方代码执行。
