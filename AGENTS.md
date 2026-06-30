# AGENTS.md — cellarer 工程约定

本文件是给所有 AI coding agent 的项目级指令(同源镜像见 `.cursor/rules/`)。设计与背景详见 [docs/kickoff.md](docs/kickoff.md)。

## 项目是什么

cellarer:多 AI agent 的 skills / mcp / rules **全局统一管理工具**(纯配置管理 + 下发 + 扫描回写 + 可视化)。TypeScript monorepo:`@cellarer/core`(全部能力)+ `@cellarer/cli` + `@cellarer/web`。

## 架构不变量(改动必须遵守)

1. **core-first**:全部业务逻辑在 `@cellarer/core`;`cli` 与 `web` 只做参数解析与展示,不写业务逻辑。
2. **副作用经 `Env` 注入**:文件系统、home、cwd、platform、时间都从 `Env`(见 `packages/core/src/env.ts`)取,**不要**在 core 里直接 `import "node:fs"` 或读 `process`/`os`。这是可测性与跨平台的支点。
3. **plan / apply 分离**:下发先产出 `DistributePlan`(纯函数),`apply = plan + 执行`,`dryRun = 只 plan`。
4. **新增 agent 走适配器**:实现 `AgentAdapter` 接口或提供声明式配置(见 kickoff 6.6),不要在引擎里散写 agent 分支。
5. **幂等 + 可回滚**:`apply` 重复执行结果一致;一切落地写入台账(`state.json`),保证 `revert` 可还原。
6. **密钥零明文(安全红线)**:库房与下发产物中**绝不**出现明文密钥;用 `${ENV_VAR}` 引用或 vault 注入。涉及 mcp/secret 的改动必须配套"落盘无明文"测试。

## 开发工作流

- **TDD**:先写测试(Vitest)再写实现;文件系统逻辑用临时目录 + 注入 `Env`。
- 运行:`pnpm build` / `pnpm test` / `pnpm lint`(Biome)/ `pnpm typecheck`。
- 提交前确保上述全绿;CI 在 ubuntu/macos/windows 三平台执行。

## 代码风格

- ESM + NodeNext:相对导入带 `.js` 后缀;类型导入用 `import type`。
- 注释用中文解释"为什么";命名(函数/类型/变量)用英文。
- 不写叙述式废注释。
