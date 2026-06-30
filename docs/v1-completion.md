# cellarer v1 完成情况

> 无人值守 goal 模式实施(M2→M5),承 [kickoff.md](kickoff.md) + 实施计划 §9。本文记录最终交付、未做项、待手动执行项。

## 完成的里程碑(M0–M5 全绿)

| 里程碑 | 内容 | commit |
| --- | --- | --- |
| M0 脚手架 | pnpm + turbo + tsc + vitest + biome 三包骨架 + CI 三平台 | `9faf35b` |
| M1 rules 下发闭环 | markers/fs/store/adapters/engine(plan/apply/revert/status)+ CLI | `c369e26` `67eec65` |
| M2 mcp + skills + 密钥分层 | mcp 编解码(JSON+TOML)/ skills 目录下发 / detector·resolver·vault(age)·keychain / 统一 secret-scan 护栏 | `1aee8f3` |
| M3 扫描回写 | scan(读→规范化→脱敏→diff→冲突→写库房)+ 写前明文护栏 + 非交互入口 | `0bf9d4f` |
| M4 Web UI | Hono RPC server(仅 127.0.0.1,密钥不回显)+ React/Vite SPA + `cellarer ui` | `80e6555` |
| M5 打磨扩展 | 7 内置适配器 + 字段方言 + 声明式示例库 / Windows 加固测试 / CI 漂移检查 / npx 打包(本地验证) | 本提交 |

**测试:208 个 vitest(core/cli/web 三项目),build/test/lint/typecheck 四关全绿。**
每个里程碑走 TDD → 四关 → /simplify → /code-review(recall,多 finder + verifier + sweep)→ 修 CONFIRMED → 文档 → 提交。

## 安全红线(已落实并测试)

- 库房与下发产物**零明文密钥**:占位符 `${ENV}` / `${CELLARER_SECRET:<name>}`;真值只进 age vault(armor 文本,atomicWrite)或 keychain(经 SecretStore 注入)。
- **下发统一 secret-scan 护栏**:意外明文(脏库房)无条件拦;故意解析真值仅 global(非版本库)放行,project(git 跟踪)拦;拦下清空 preview 防经 plan 外泄。
- **扫描入库脱敏 + 写前明文护栏**:env/headers/args/url 结构化脱敏;rules 自由文本 / custom server 残留明文 → 拒绝入库。
- 落盘 grep「无真值」断言测试覆盖 vault / 下发 / 扫描三处。
- Web 一律 `secretMode:"env"`,响应不含真值;`/api/secrets` 只列引用名;仅监听 127.0.0.1;可选 token。

## 架构不变量(全程守住)

core-first(cli/web 薄壳)/ 副作用经 Env 注入(core 不直接 import node:fs、不读 process/os)/ plan-apply 分离 /
新 agent 走 AgentSpec 声明式(引擎用 capability→planner + op→handler 分派表,无 `if(agent.id===…)`)/ 幂等可回滚(state.json 台账)/ 密钥零明文。

## 未做项(v1 明确不做 / 留 M6+)

- MCP 运行时代理/网关、云端托管、自建 registry、agent 生命周期管理(kickoff 非目标)。
- scan provenance 仅 marker/软链/同名;ledger+指纹双保险待补(M4 待办)。
- revert 对 mcp merge 走 `.bak` 整体还原(非精确 un-merge);apply 后用户手加的 server 会丢。
- skills 共享池(`~/.agents/skills`)的台账归属与 per-agent revert 协调。
- Web 前端改用 `InferResponseType` 端到端类型 / token 常量时间比较 / 未知 /api 返 JSON 404。
- redactFields 对低熵非厂商格式密钥的召回(检测固有限制)。
- 详见各 `docs/design/m*.md` 的「遗留」节与项目记忆 `cellarer-impl-plan`。

## 待手动执行(外发动作,无人值守不代办)

- **npm 发布**:三包当前 `private:true`;`npm pack --dry-run` 已验证 tarball 内容正确(CLI 带 dist+bin,web 带 client/dist)。发布步骤见 [release.md](release.md)。
- **git push**:本地已提交到 `main`,**未推远程**。

## 本机验证

完整 e2e 通过(临时库房 + CELLARER_HOME,未触碰真实 ~/.claude 等配置):
`init → ls → apply(rules/mcp/skills)→ 落盘零明文 → status ok → secret vault add/ls → revert → status 空`;
`cellarer ui` 起服务(127.0.0.1)、API + SPA 可达、token / project-scope 守卫 / malformed-JSON 均验证。
