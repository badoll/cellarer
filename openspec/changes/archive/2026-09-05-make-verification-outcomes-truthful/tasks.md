实施前读取 proposal/design/specs；以当前 Git 和现行 specs 复核本 change。本文件复选框只记录实际实现及验证，文档生成不代表任务完成。新增测试文件在对应任务组创建后执行。路径花括号为同目录文件简写，必须以 proposal 的 Allowed paths 为边界；遇到不一致先更新提案。

## 1. Core 请求覆盖与验证判定

**Invariant:** 请求项不会因 skip 或空数组消失。

**Paths:** packages/core/src/engine/{plan,verification,types}.ts; packages/core/src/protocol/client-types.ts; packages/core/tests/verification-coverage.test.ts

**Verification:** `CI=true pnpm exec vitest run packages/core/tests/verification-coverage.test.ts packages/core/tests/transaction-verification.test.ts`

- [x] 1.1 建立未知 Agent、unsupported、disabled、空 Store、规划失败、正常目标与漂移的失败复现矩阵。
- [x] 1.2 为请求键产生 typed coverage，保留失败项；实现 healthy/no-op/incomplete 判定及未知 runtime evidence。
- [x] 1.3 验证合法 no-op 与输入错误的区别，证明该只读路径无需 authority/provider；覆盖 journal/锁缺失、存在与读取失败的保守恢复观察。

第 1 组证据：Core focused tests 17/17；Core typecheck 通过；owned Biome/diff 检查通过（引用 token 测试有 1 条 lint warning）。固定矩阵已覆盖，未调用 authority/provider；无遗留 finding。

## 2. CLI 与 HTTP 合同投影

**Invariant:** 同一 Core 结果在两个调用边界保持一致。

**Paths:** packages/core/src/{control-plane,index}.ts; packages/core/src/protocol/{client,client-types}.ts; packages/cli/src/commands/{control-plane-read,status}.ts; proposal 指定 CLI schema/fixtures; packages/web/src/{app,api-contract}.ts

**Verification:** `CI=true pnpm exec vitest run packages/cli/tests/control-plane-read-commands.test.ts packages/cli/tests/http-read-parity.test.ts packages/web/tests/api-contract.test.ts`

- [x] 2.1 在现有版本 envelope 中更新 DTO/schema/fixtures，定义 invalid-input、domain-error 与 no-op success 的 exit 映射。
- [x] 2.2 验证 CLI JSON/text 与 HTTP 对相同矩阵给出一致 coverage，不能仅靠 HTTP 200 宣称成功。

第 2 组证据：CLI/HTTP/API focused tests 54/54（含 7 场景 parity 和文本输出）；CLI/server/Core typecheck 与 diff 检查通过。

## 3. Web 健康显示

**Invariant:** 配置结果与原生加载证据分别呈现。

**Paths:** packages/web/client/App.tsx; packages/web/client/product-model.ts; packages/core/src/dashboard.ts; packages/web/tests/dashboard-model.test.ts；复用第 2 组的 client-types 与 CLI/HTTP schema 路径以投影 Dashboard 新字段。

**Verification:** `CI=true pnpm exec vitest run packages/web/tests/dashboard-model.test.ts packages/core/tests/control-plane.test.ts`

- [x] 3.1 消费新的 typed 配置结果并显示 unknown native evidence；不在 UI 重算健康。
- [x] 3.2 补充 incomplete/no-op 与旧正常健康样例，验证现有覆盖卡片不吞掉异常。

第 3 组证据：Web/Core/API focused tests 51/51，含真实临时 Store 的卡片渲染；Web/client typecheck 通过，现有 Dashboard 统计测试通过。

## 4. 文档、集中审查与关闭验证

**Invariant:** 对外说明与已验证实现一致，且提案内变更形成可归档的完整结果。

**Paths:** README.md、README.zh-CN.md、docs/README.md、docs/README.zh-CN.md、当前 change 的 artifacts，以及前述允许的实现和测试路径（含 `packages/core/tests/fixtures/package-exports-baseline.ts` 的声明/运行时导出和签名快照）。

**Verification:** `openspec validate make-verification-outcomes-truthful --strict --no-interactive`；`git diff --check`；本组列出的单次完整 gate。

- [x] 4.1 对齐中英文说明、兼容性影响和当前可用边界，命令示例对照实现；更新 delta 使其描述最终行为。
- [x] 4.2 对完整 owned diff 做一次集中审查并核验 design Acceptance Matrix，集中修复后只复查 findings 与受影响路径。
- [x] 4.3 执行一次 `CI=true pnpm build`、`CI=true pnpm test`、`CI=true pnpm lint`、`CI=true pnpm typecheck`；只有最终跨边界修复才重跑完整 gate。
- [x] 4.4 运行严格 OpenSpec 校验及 diff 检查，核对实际完成证据与未执行限制；实现完成后另行进行 spec sync 与 archive，不以本复选框代替归档。

spec sync、archive 和后续 change 的合同刷新为独立关闭动作；commit/push/发布不属于本任务表的自动授权。

关闭证据（2026-09-05）：
- 完整 owned diff 与 Acceptance Matrix 已集中审查；修复 disabled/unsupported 被坏资源覆盖的问题，并补齐共享 verify 的 diff 输入错误投影。
- 单次全量 gate：build 3/3、typecheck 5/5、lint exit 0（98 warnings / 5 infos）；test 共 2082，2079 通过，3 个预期公共导出/签名快照失配。
- Allowed paths 已校准到 Core 包快照；快照仅增加 1 个错误类、5 个 DTO 类型及可选 planning observation 参数。修复后 `CI=true pnpm exec vitest run packages/core/tests/package-exports.test.ts` 36/36；CLI 受影响两文件复验 36/36，CLI typecheck 通过。无跨模块修复，不重复全量 gate。
- `openspec validate --all --strict --no-interactive` 26/26；`git diff --check` 通过。现有其他 7 个提案保持未实施；未执行 commit/push、原生 Agent/MCP 或 provider 访问。
