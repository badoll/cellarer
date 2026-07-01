# cellarer-v2 横评报告与优化 Backlog

> 对同一份需求([kickoff.md](kickoff.md))两份独立实现的横向评测,并据此为 **cellarer-v2** 沉淀可执行的优化清单。
> - **本仓库 = cellarer-v2(下称 B)**:7 commit,M0–M5,源码 ~5761 行 / 测试 ~2973 行,208 测试 / 21 文件,含 Vite React SPA,core 依赖 age-encryption + smol-toml + zod。
> - **对照实现 = cellarer(下称 A)**:14 commit,M0–M5+OSS 收尾,源码 ~3129 行 / 测试 ~1420 行,96 测试 / 24 文件,core 依赖 smol-toml + zod。
>
> 评审用多 agent workflow 完成:8 维度独立精读双仓打分取证 → 每维度关键论断回源码逐条对抗性核验(推翻若干夸大/虚构论断)→ 汇总。两仓 build + 全部测试均通过,下述差异是在「都能跑」前提下的工程质量对比。评审方法与可信度说明见 §6。
>
> **本文档面向 cellarer-v2 后续优化**:结论落在 §5 的 Backlog;§1–§4 是支撑该 Backlog 的证据。

## 1. 总览结论

**这是「合格的紧凑实现(A)」与「接近规范的完整实现(B)」之间的差别,而非「能用与不能用」。**

B(本仓库)系统性地把 kickoff §6.6(声明式适配器)/§8.5(下发优先级)/§10(密钥四层)/§11(跨平台)的规范落到实处,并交付了真实 React+Vite SPA 与结构化文档:capability/op 双分派表 + 纯函数注册表 + 内置/声明式共用 `specToAdapter` 让「新增 agent 零代码」真正做成;四层密钥防护齐全、下发前统一可中止的 secret-scan 护栏覆盖全能力全 scope;mcp 有 canonical IR + 字段方言 round-trip;工程化上有 pnpm catalog、`tsc -b` 增量、4 关 CI + drift-check、真实 SPA 随包发布。

代价是体量与抽象层更重(5761 vs 3129 行),`plan.ts` 单函数密度偏高,且 B 自身仍有**真实缺口**:`add` 命令连桩都没有(报 unknown command)、Web 前端下发被硬编码 global、`linkOrCopy` 的 win32 junction 分支缺回退、`assertPathInside` 定义了却未接入删除站点、`expand()` 缺路径越界防护。

A(对照实现)更精简易读、复杂度低,plan/apply 真正分离(收敛在 `distribute.ts` 单文件内)、台账幂等扎实,且在几个局部反而做得比 B 细(Web 安全加固、skill 内容级漂移检测、win32 junction 回退、disk-full 原子性测试、双语根 README)。但它在 kickoff 若干硬需求上停在半成品或桩:`ls`/`add` 是桩、声明式适配器只支持 rules、缺 keychain 层且 vault 用 AES 代 age、config schema 只解析两个字段导致 per-agent/per-OS 策略在 core 层根本不生效。

**一句话总评:B 在全部八个维度胜出,是更贴合 kickoff 规范、更适合作为 v1 基线的实现;A 的价值在于精简度与几处局部优势,应作为 B 的吸收项(见 §5.2),而非替代基线。**

## 2. 维度对比总表

| 维度 | cellarer (A) | cellarer-v2 (B) | 赢家 | 一句话点评 |
| --- | :---: | :---: | :---: | --- |
| 功能完成度 | 7.0 | 8.5 | **B** | A 有 `ls`/`add` 桩、声明式仅 rules;B 命令面更全、密钥四层、真 SPA |
| 架构与模块设计 | 7.0 | 9.0 | **B** | 双方都 core-first + plan/apply 分离;B 依赖倒置更纯、分派表 + 纯函数注册表 |
| 代码质量与可维护性 | 7.5 | 8.5 | **B** | 都 0-any;B 单一真源 + config 真正生效,A 更精简易读但 schema 过薄 |
| 测试完备度与可靠性 | 6.5 | 8.5 | **B** | B 显式测软链回退/错误码 rethrow/密钥矩阵;A 有独有的 disk-full 原子性注入 |
| 密钥安全实现 | 5.5 | 8.5 | **B** | A 文本 secret-scan 是死代码、env 层不翻译占位符;B 四层齐全 + 真 age |
| 可扩展性(适配器体系) | 4.5 | 9.0 | **B** | A 声明式仅 rules、两层合并;B 三层合并 + 全字段方言,唯 A 有越界防护 |
| 跨平台与文件系统健壮性 | 6.5 | 8.0 | **B** | B 有断链检测 + 护栏 + win32 实测;A 有 junction 回退与内容级漂移 |
| 性能与工程化/DX | 6.0 | 8.5 | **B** | B 有并发 + catalog + tsc -b + drift-check;A 全程串行,但有双语根 README |

**八维度均值:A ≈ 6.3,B ≈ 8.6。B 全胜。**

## 3. 逐维度详评

### 3.1 功能完成度(A 7.0 / B 8.5)

- **`ls` 命令**:A 是 notImplemented 桩(`cellarer/packages/cli/src/index.ts:64-69`);B 是完整实现,三类制品分组 + 通道过滤,复用 core 的 `inChannels`(`packages/cli/src/commands/ls.ts:13-54`)。
- **适配器广度**:A 仅 4 个内置;B 有 7 个,含 opencode/windsurf 字段方言(`packages/core/src/adapters/builtin.ts:7-152`)。
- **密钥分层**:A 约 3 层(占位符 + env 引用 + AES vault),缺 keychain 且 vault 用 Node AES-256-GCM 而非 kickoff §10 点名的 age;B 四层全齐。
- **scan 冲突策略**:B 有 kickoff §9.1 的三策略(keep-theirs/keep-mine/copy)+ `--select` + `--json`;A 的 scan 冲突仅 skip/overwrite。
- **B 的短板(真实)**:`add <source>` 完全未注册,`cellarer add` 报 unknown command(比 A 的桩更不友好,`packages/cli/src/program.ts:13-31`);`init` 只有 `--global` 无 `--project`;Web 前端下发/扫描硬编码 `scope:"global"`(`packages/web/client/App.tsx:169,280`),后端 `app.ts` 其实支持 project。
- **对称空洞(非任一方单边优势)**:secret 缺 `import`/`rotate`(A 只有 set/ls/rm,B 只有 add/ls/rm),`add <source>` 两仓皆缺。

### 3.2 架构与模块设计(A 7.0 / B 9.0)

双方都做对了 core-first 分层与真正的 plan/apply 分离(A 的分离确实存在,只是收敛在同一 `distribute.ts`:245/338/409)。B 系统性领先的点(均经逐行核验):

1. **依赖倒置更纯**:B 的 `env.ts`(零 node 导入)与 `real-env.ts`(全 core 唯一 import node:fs/os/process 的文件)彻底分离;A 是接口 + 实现同置。
2. **双分派表解耦控制流**:`PLANNERS`(按 capability,`plan.ts:62`)+ `OP_HANDLERS`(按 op,`apply.ts:29`),未登记 op 显式抛错(`apply.ts:73`)。
3. **纯函数注册表**:`loadRegistry` 每次返回全新 Registry(`adapters/registry.ts:46`);A 是模块级全局可变单例,且 `scan.ts` 直绑单例、`distribute.ts` 走注入,耦合口径不统一。
4. **内置/声明式同构**:B 内置(TS AgentSpec)与声明式(TOML→同形 AgentSpec)统一经 `specToAdapter` 编译(`spec.ts:69`);A 的声明式硬编码 `mcp:[]/skills:[]`。
5. **mcp canonical IR**:B 有判别式联合 stdio/remote/custom + extra round-trip(`mcp/model.ts`);A 是裸对象 spread merge。
6. **curated barrel**:B 全具名导出 + type/value 分离;A 全量 29 条 `export *`,公开面 = 全部内部实现。

**B 的短板**:体量更大、间接层更多;`plan.ts` 单文件 294 行承载通道过滤 + 去冲突 + secret-scan 护栏,阅读密度高;`PlanContext` 共享上下文较宽。

### 3.3 代码质量与可维护性(A 7.5 / B 8.5)

双方基线都高(全仓 0 处 `any`,中文注释解释「为什么」,都用 zod + Env/FsLike 抽象)。

- **config 真正生效(决定性差异)**:B 在 `plan.ts:85/138/234` 真正按 §8.5 优先级应用 `defaults.os[platform].method` / `agents[id].enabled` / `agents[id].mcp.merge_strategy`,schema 全程 `.strict()` + 覆盖全部 §7.2 字段;A 的 `ConfigSchema` 只解析 `defaults.channels` + `artifacts`,core **从不读取** `defaults.os`/`secret_mode`/`agents`,故 per-OS 兜底与 §8.5 优先级在 A 的 core 层根本不生效。
- B 的错误可操作:`probe.ts:1-11` 区分 ENOENT/ENOTDIR(视为缺失)与 EACCES/EIO(必须 rethrow);`ledger.ts:86`、`codec.ts:47` 抛错带「Fix or remove the file」。
- **A 的相对优势**:更精简、更易一眼读懂,可读性略占优。

### 3.4 测试完备度与可靠性(A 6.5 / B 8.5)

双方都用 Env/FsLike + 真实临时目录覆盖核心闭环。B 领先的关键 edge case:

- **软链失败回退**(§11 硬需求):B 注入 `platform:win32` + 让文件 symlink 抛 EPERM,断言回退 copy(`tests/linkOrCopy.test.ts:103-123`);A 虽实现该逻辑(`io.ts:89-104`),但测试从不注入 win32、仅 `skipIf(process.platform==='win32')` 跳过,回退分支 CI 上零覆盖。
- **错误码不吞并**:B `probe.test.ts:32-46` 验证 ENOENT 返回 null、EACCES/EIO rethrow;A 无此类断言。
- **密钥误报/漏报矩阵**:B 有 151 行系统化(AUTH_URL 不误报、git SHA 不判 high、Shannon 熵,`secrets-detector.test.ts`);A 仅 7 例,且实测 A 的 `SECRET_KEY_RE` 含裸 `auth` 会对 AUTH_URL 误报——正是 B 显式防护的场景。
- **CLI/Web 测试 + 共享 helper**:B 有 `program.test.ts` / `app.test.ts` / `helpers/env.ts`;A 的 CLI 311 行零测试。
- **A 的独有亮点(真实)**:`m2fixes.test.ts:45-63` 注入 writeFile 抛 disk-full,断言原文件完好且无 `.bak`——B 无此故障注入角度。

### 3.5 密钥安全实现(A 5.5 / B 8.5)

- **四层完整度**:B 四层全有真实现——env 模式真正把 `${CELLARER_SECRET:NAME}` 翻译成 `${ENV_VAR}` 下发(`engine/mcp-plan.ts:86-89`),vault 用真 age(密文断言 `BEGIN AGE ENCRYPTED FILE`),keychain 经 `createRequire` 懒加载 `@napi-rs/keyring` + 优雅降级 + 经 `Env.secretStore` 注入(`cli/src/keychain.ts:23-54`,守住 core 不 import native)。A 缺 keychain,且 **env 模式根本不翻译占位符**——`resolveSecretRefs` 仅在 vault 模式调用,库房占位符被原样吐给 agent。
- **下发前 secret-scan 护栏**:B 在 `plan.ts:176-195` 统一、可中止、覆盖 rules/mcp/skills 全能力全 scope,命中转 skip 并清空 `preview.after`;A 对应的 `findPlaintextSecrets` 是**死代码**(业务代码零调用点),rules 混入明文密钥下发时毫无拦截。
- **B 的短板**:keychain getPassword 抛错被吞成 null,锁定/瞬时故障与「无此条目」无法区分(`keychain.ts:29-31`,自注 M3 待办);keychain 层缺真实接线的集成测试(仅 fake SecretStore);skills 目录内容的写前明文护栏留到 M4(`engine/scan.ts:290`);vault 口令无交互式 TTY。

### 3.6 可扩展性:适配器体系(A 4.5 / B 9.0)

kickoff §6.6 四项硬要求,B 四项全达标且有专门测试(`tests/adapters.test.ts:171-266`)+ 示例文档:

1. **声明式定义完整 agent**:zod schema 覆盖 rules/mcp(format/servers_key/merge_strategy + command_style/env_key/url_key 方言)/skills/detect/capabilities(`declarative.ts:11-42`)。
2. **三层合并后覆前**:内置→全局→工程 `map.set` 覆盖(`registry.ts:54-61`)。
3. **mcp 跨格式 + servers_key 别名归一**:canonical IR round-trip + 写回沿用原键(`merge.ts:7-23`)。
4. **merge 策略三级优先级**:CLI > `[agents.<id>].mcp.merge_strategy` > adapter 默认(`plan.ts:233-245`),严格对齐 §8.5。

A 的结构性缺口:声明式只能定义 rules,mcp/skills 型新 agent 必须改代码;只做两层合并;merge 策略不能按 agent 配置。

- **A 唯一实打实的优势(是 B 的短板)**:声明式路径的 `isWithin` 越界防护(`loader.ts:37-39`),校验解析结果必须落在 home/工程目录内。这正是 **B 的 `expand()` 所缺**(`spec.ts:38-51` 只做展开 + absolutize,全仓无 isWithin)——§6.6 明确声明式适配器意在「团队/社区拷贝分享」,分享来的 TOML 可 `/etc/` 或 `../` 逃逸,是 B 应补的安全短板。

### 3.7 跨平台与文件系统健壮性(A 6.5 / B 8.0)

B 多命中且命中更实的项:

- **broken-link 健康检查**(§11.2):B 用 lstat + realpath 显式判断,`DriftStatus` 含 broken-link(`status.ts:29-49`);A 的 `DriftState` 仅 ok|drifted|missing,断链的 skill 软链会被误判。
- **真源保护护栏**:B 有 `assertNotSymbolicLink` 并接入内容写入路径(`apply.ts:103`),`relativeInside` 正确处理 `..` 与 Windows 跨盘(`safety.ts:11-47`)。
- **Windows 分支真实测试**:B 注入 `platform:win32` 实测 junction 与 no-Developer-Mode 回退。

**A 的真实相对优势(是 B 的短板)**:

- **junction 带回退**:A 的 win32 目录 junction 分支有 try/catch→copy(`io.ts:89-97`);**B 的 junction 分支恰无 try/catch 回退**(`linkOrCopy.ts:66-69`),违反 kickoff「任何软链失败都回退 copy」——B 相对 A 的真实退步。
- **skill 内容级漂移检测**:A 对 skill 目录用 `hashDir` 做内容指纹(`status.ts:39-40`),能检出 copy 落地后被手改;B 对目录只判存在/断链(`status.ts:44`)。

**共同短板**:两仓都**未实现 §11.1「主动探测 Developer Mode 并给出开启指引」**,均只做静默回退。另:B 的 `DriftStatus` 含 outdated 但从未被产出(死枚举)。

### 3.8 性能与工程化/DX(A 6.0 / B 8.5)

- **性能**:B 用并发 + agent 无关重活顶层只算一次(`plan.ts:73` Promise.all 并行读 config/registry/rules/mcp/skills,注释「N×M→M」,vault 单次解密),全仓 8 处 Promise.all + realpath 幂等短路(`linkOrCopy.ts:23`)+ 台账指纹跳拷(`apply.ts:139`);A **全仓 0 处 Promise.all**,`loadConfig` 每次 apply 重复读 toml 3 次,`hashDir` 在 agent 循环内 N_agent×N_skill 重复计算库房侧指纹。
- **工程化**:B 有 pnpm catalog 单点统一依赖、`composite:true` + 项目引用 + `tsc -b` 增量、更严 tsconfig、三平台 4 关 CI + 独立 `drift-check.yml`(cron 跑 `status --json`)、真实 Vite SPA 随包发布;A 的 `@types/node` 4 处硬编码、朴素 tsc、CI 无 typecheck/drift、web 是内联 HTML 字符串。
- **A 的真实优势**:双语根 README(含 npx 上手示例),三子包均带 description + license;**B 无根 README,core/web 缺 description**(release.md 自陈发布前补),子包无 license。

## 4. 关键差异深挖

1. **声明式适配器完备度 —— 「零代码新增 agent」的成败分野**:A 的声明式路径连 mcp/skills 字段都无法解析,只能定义 rules,任何 mcp/skills 型新 agent 都得改代码等发版,落空 §6.6 立意。B 用 `specToAdapter` 让内置与声明式共用同一构造路径、能力完全同构 + 附 example.toml。这是 4.5 vs 9.0 的结构性根因。
2. **依赖注入与控制流解耦 —— 分派表 vs 全局单例 + 分支**:A 的注册表是模块级可变单例 + `scan`/`distribute` 两种耦合口径;B 用 capability/op 双分派表 + 纯函数 Registry,「加表项不改引擎」落地,天然无测试污染。
3. **密钥四层落地程度 —— 护栏是否真生效**:A 的文本 secret-scan 是死代码、env 模式(默认层)不翻译占位符,导致最常用层近乎失效;B 四层齐全、护栏统一可中止覆盖全能力全 scope。注:A 的 AES vault 加密本身稳健,失分在覆盖面与护栏生效性。
4. **Web UI 形态 —— 但安全性反向**:B 交付真实 SPA(`client/App.tsx` 366 行,含 Secrets 页),形态忠实 §6.3;A 是内联 HTML 字符串(缺 Secrets 页)。**但 A 的 server 做了 DNS-rebinding Host 白名单、CSP、timing-safe token、页面级 token 门禁**(`server.ts:80-198`),而 B 前端还把下发硬编码 global。B 赢架构忠实度,A 赢安全加固与作用域灵活性。
5. **测试策略 —— 广度 vs 独有故障注入**:B 的 208 测试覆盖了 A 缺失的关键路径(win32 回退、错误码区分、密钥误报矩阵、merge round-trip);A 有一个 B 完全没有的角度——disk-full 故障注入验证原子写与备份顺序。

## 5. cellarer-v2 优化 Backlog

> 本节是本文档的落点,按优先级组织。所有条目带 file:line 证据,可直接派生任务。
>
> **执行状态(2026-07-01 更新)**:§5.1 / §5.2 全部条目 + §5.3 的 `add` 源导入已实现并合入(7 批提交,TDD → 四关 → 多 agent code-review)。测试从 208 增至 274。**未做(明确留后)**:§5.3 的 Developer Mode 主动探测(§11.1,共同短板,静默回退可用)、secret `import`/`rotate` 子命令、vault 口令交互式 TTY、`add` 的 git/URL 真实拉取(当前为友好桩)。落地细节见各批提交信息与 [v1-completion.md](v1-completion.md)。

### 5.1 B 自身必须先补的债(合并/迭代前置)

| 优先级 | 项 | 证据 | 影响 |
| :---: | --- | --- | --- |
| **高** | 声明式 `expand()` 缺路径越界防护 | `packages/core/src/adapters/spec.ts:38-51`(全仓无 isWithin) | 分享来的适配器 TOML 可 `/etc/` 或 `../` 逃逸写盘;§6.6 分享场景的安全底线。补 A 式 `isWithin` 校验(参 `cellarer/.../loader.ts:37-39`) |
| **高** | win32 junction 分支无回退 | `packages/core/src/fs/linkOrCopy.ts:66-69` | junction 失败(跨卷/权限)抛错而非按 §11 回退 copy——真实退步。补 try/catch→copy(参 A `io.ts:89-97`) |
| **高** | `assertPathInside` 定义未接入删除站点 | `packages/core/src/fs/safety.ts` +（src 无调用) | 越界删除防护「可用未用」;revert 删 target 前未校验 root 边界。接入 revert 删除路径 |
| 中 | `add <source>` 完全未注册 | `packages/cli/src/program.ts:13-31` | `cellarer add` 报 unknown command。先注册为友好桩,再实现 git/local 源导入 |
| 中 | Web 前端硬编码 global | `packages/web/client/App.tsx:169,280` | 无法从 UI 做 project 作用域下发(后端 `app.ts` 已支持)。前端暴露 scope 选择 |
| 中 | keychain 抛错吞成 null + 无集成测试 | `packages/cli/src/keychain.ts:29-31` | 锁定/瞬时故障与「无此条目」无法区分;真实接线仅 fake 覆盖。区分错误 + 补集成测试 |
| 中 | 无根 README + core/web 缺 description/license | 仓库根 / `packages/{core,web}/package.json` | npm registry 无展示、发布元数据不全。补双语 README + 元数据(参 A) |
| 低 | `DriftStatus.outdated` 死枚举 | `packages/core/src/engine/status.ts` | 定义了从不产出。要么接入内容级检测(见 5.2),要么删枚举 |
| 低 | `plan.ts` 单文件 294 行密度过高 | `packages/core/src/engine/plan.ts` | 通道过滤 + 去冲突 + secret-scan 护栏耦合在一函数。按职责拆分 |

### 5.2 从 cellarer(A)吸收的项

| 优先级 | 项 | A 的参考实现 | 收益 |
| :---: | --- | --- | --- |
| **高** | Web 安全加固 | `cellarer/packages/web/src/server.ts:80-198`(DNS-rebinding Host 白名单 / CSP / timing-safe token / 页面级 token 门禁) | B 明确的安全短板,A 已有成熟实现,移植进 B 的 Hono server |
| 中 | skill 内容级漂移检测 | `cellarer/packages/core/src/engine/status.ts:39-40`(`hashDir` 内容指纹) | 补 B「copy 落地后被手改无法检出」的缺口;可做成可选深度检查兼顾性能,顺带激活 5.1 的 outdated 枚举 |
| 中 | disk-full 类故障注入测试 | `cellarer/.../m2fixes.test.ts:45-63`(注入 writeFile 抛错断言原文件完好、无 `.bak`) | 补进 B 的 `atomicWrite.test.ts`,验证原子写与备份顺序 |
| 中 | 双语根 README + 子包元数据 | A 的根 README + 三子包 description/license | 直接采用形态,补齐 B 的 registry 展示(与 5.1 元数据项合并) |

### 5.3 两仓共同待办(B 需补齐)

- 实现 kickoff §11.1 的 **Developer Mode 主动探测与开启指引**(当前只静默回退,`linkOrCopy.ts:3` 仅注释提及)。
- 补齐 secret 的 `import` / `rotate` 子命令(当前仅 add/ls/rm)。
- 实现 `add <source>` 的 git/local 源导入(与 5.1 的注册项衔接)。
- vault 口令支持交互式 TTY 输入(当前仅 `--passphrase`/环境变量)。

## 6. 评审方法与可信度说明

- **编排**:8 维度评审 agent 各自独立精读双仓源码并产出结构化打分(score + 亮点 + 短板 + file:line 证据 + 赢家);随后每维度一个对抗性核验 agent 回到源码逐条复核 keyEvidence 与关键论断,默认怀疑、证据不符即标 false;最后一个综合 agent 汇总,凡被核验推翻的论断一律剔除。
- **规模**:17 agent(8 eval + 8 verify + 1 synthesize),约 2.0M tokens,696 次工具调用。
- **客观基线**:两仓均 `pnpm build` + `pnpm test` 通过(A 96 测试 / B 208 测试),分数是「都能跑」前提下的质量对比。
- **核验剔除的典型误判(未写入正文)**:①「A stat→null 会吞真实错误造成静默数据丢失」不成立(A 对 EACCES/EIO 均上抛);②「A 密钥只落地两层」经核验为低估,实为约 3 层;③工程化维度「catalog 统一 16 个依赖」实为 18 条、「各包全用 catalog:」略夸大(web 有一处 `@vitejs/plugin-react` 硬编码)、「6 处 Promise.all」实为 8 处(偏保守)——核心结论不变。
- **分数容差**:B 的可扩展性 9.0 因 `expand()` 缺越界防护严格讲可给 8.5,核验认定在合理容差内、不构成误判,故维持 9.0(该缺口已落 §5.1 高优先级)。
