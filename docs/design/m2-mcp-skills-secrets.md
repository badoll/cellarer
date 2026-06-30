# M2 设计:mcp / skills 下发 + 密钥分层

> 承 [kickoff.md](../kickoff.md) §7–§10 与实施计划 §9 的 M2。本文记录 M2 落地的架构、关键决策与背离点。
> 安全红线见 [AGENTS.md](../../AGENTS.md) 不变量 6:库房与下发产物零明文密钥。

## 1. 范围

M2 在 M1(rules 下发闭环)之上加:

- **mcp 编解码下发**:库房 `store/mcp/<name>.json`(canonical)→ 各 agent 原生格式(JSON / Codex TOML),merge / overwrite。
- **skills 目录下发**:`store/skills/<name>/` → agent skills 目录,symlink / copy。
- **密钥分层**:detector / resolver / vault(age)/ keychain + 下发前 secret-scan 护栏。
- **channel 分治**:rules / mcp / skills 三类制品统一按 channel 过滤。

## 2. 引擎结构性重构(清 M1 评审待办)

M1 的 `if (cap === "rules" && op === "write")` 阶梯换成两张分派表(架构不变量 4 的引擎侧落地):

- **plan**:`PLANNERS: Record<Capability, CapabilityPlanner>`(`rules` / `mcp` / `skills`)。新增能力 = 加一张表项 + 一个 planner,不改控制流。
- **apply**:`OP_HANDLERS: Partial<Record<op, OpHandler>>`。`write`/`merge`/`overwrite` → `applyContentWrite`(内容写入);`symlink`/`copy` → `applyLink`(目录链接)。未登记的 op 抛错,强制新能力补齐落地逻辑。

**op 与 method 的关系**(M2 厘清):

- `op` 是落地动作种类,是 apply 分派与 revert 的真相。
- `method`(symlink|copy)是用户偏好。对 rules/mcp 是信息字段(永远渲染写入);对 **skills**,`op` 由 `method` 推导(`symlink`→`op=symlink`,`copy`→`op=copy`),因此 per-OS `[defaults.os.win32].method=copy` 对 skills 真正生效。
- 实际落地方式(Windows 可能回退 junction/copy)记台账 `AppliedMethod`,与计划 `method` 区分。

`RulesCodec.isGenerated` 删除:文件级 provenance 判定收敛在全局 `markers.isGenerated`(rules 全用 markdown 格式),backup 直接调它。

## 3. mcp 编解码(`src/mcp/`)

### canonical 中间表示(借 mcpm 字段方言矩阵,kickoff §7.4)

判别式联合 `McpServer`:

- `stdio`:`{command, args?, env?, extra?}`
- `remote`:`{url, headers?, extra?}`
- `custom`:`{config}`(原样兜底,未知/特殊条目不丢)

判别规则:有 `command` → stdio;有 `url` → remote;否则 custom。`extra` 保留 server 上规范字段之外的私有键(`disabled` / `timeout` / `cwd` / `type` 等),**避免 merge round-trip 丢失用户既有 server 的私有字段**(M2 评审 CONFIRMED 的数据丢失修复)。

### McpCodec(格式方言下沉到 adapter,不在引擎散写)

- `jsonMcpCodec`(claude / cursor / gemini):servers 段在顶层 serversKey 下。
- `tomlMcpCodec`(codex):`[mcp_servers.*]` 内嵌表。**smol-toml stringify 不保留注释**(见计划 §6),且首次写回会把标量键提到表前 —— 这是 codex `config.toml` 写回的已知取舍。
- serversKey 别名归一(`MCP_SERVER_KEYS = mcpServers / mcp_servers / servers / mcp / context_servers`):既有文件用别名时沿用原键写回,不产生重复键。
- merge(默认,incoming 覆盖同名 server,保留其余)/ overwrite(整组替换 servers 段,保留 servers 段之外的文档字段)。
- `applyMerge` 对既有文件解析失败(用户手改出语法错)抛**带路径的可操作错误**,而非裸 `SyntaxError` 崩整批下发。

### 合并策略优先级(kickoff §8.5)

CLI `--mcp-overwrite` > `[agents.<id>.mcp].merge_strategy` > adapter 默认(`merge`)。

## 4. 密钥分层(`src/secrets/`,安全红线)

四层防护(kickoff §10),库房**零明文**:

1. **占位符(库房层)**:`${CELLARER_SECRET:<name>}` 或 `${ENV_VAR}`。
2. **env 引用(下发默认)**:`${CELLARER_SECRET:NAME}` 渲染为 `${NAME}`,真值留环境,**零落盘**。env 模式对 env/args/headers/url 里的整值占位符都生效。
3. **age vault**(`age-encryption` typage,纯 JS 零 native):口令(scrypt)加密,armor 文本落盘,`atomicWrite` 写入(防半写损坏唯一密钥副本)。vault 在 plan() 顶层**单次解密**经 `vaultData` 透传,避免每字段/每 agent 重复 scrypt。
4. **系统 keychain**(`@napi-rs/keyring`):经 `SecretStore` 注入,**core 绝不直接 import**;CLI 侧 `createRequire` 懒加载,native 失败降级 vault(不崩 CLI)。

### detector(两段式,借 gitleaks,kickoff §7.6)

- 第一段(high,命中即拦):变量名正则(用完整 `authorization` 而非裸 `auth`,避免误伤 `AUTH_URL`/`AUTH_TYPE`)+ 具名前缀(`ghp_`/`AKIA`/`sk-ant-`/JWT/PEM 等)。
- 第二段(warning,兜底):高熵串。**high-entropy 只标 warning,不作硬拦理由**(否则 git SHA / 构建哈希会误报硬拦)。
- 白名单:`${...}` 占位符 / `changeme` / `<...>` / 纯布尔数字不告警。

### secret-scan 护栏(统一 plan() 后置,§10.3)

护栏在 plan() 末尾对**所有 action 的 `preview.after`** 扫描,覆盖全能力(rules / mcp / custom server)、全 scope:

- **意外明文**(脏库房:非占位符却命中高置信密钥规则,按字段名判定)→ **无条件拦,无逃生通道**。
- **文本扫描命中**(高置信厂商格式)→ 拦,除非逃生通道放行。
- **逃生通道(§10.2 必须明文的 agent)**:仅当动作标了 `allowResolvedPlaintext`(vault/keychain 故意解析的真值)**且** scope 为 `global`(`~/.claude` 等非版本库目录)时放行;`project`(git 跟踪)一律拦。
- 命中即转 `skip` 并**清空 `preview.after`**,防真值经返回的 `DistributePlan` 外泄(web/日志)。

vault/keychain 模式解析失败 → 降级为 `${NAME}` env 引用 + plan warning,**绝不写回 `${CELLARER_SECRET:..}` 内部字面量**(agent 不认会产生静默坏配置)。

## 5. 无人值守决策记录

- 库房 mcp 制品形态:`store/mcp/<name>.json` = 单 server 对象,server 名 = 制品名(对齐 kickoff §7.2 `[artifacts."mcp/company-gateway"]`)。
- skills 制品 = `store/skills/<name>/` 子目录;status 对目录/软链只校验存在 + 断链,不做目录内容 checksum。
- 默认能力(CLI 不带 `--rules/--mcp/--skills`)= 三类全发。
- secret 子命令 v1 只做 `add/ls/rm`(vault);`import/rotate` 与 keychain 写入路径留 M3。口令经 `--passphrase` / `CELLARER_VAULT_PASSPHRASE`,不做交互 TTY。

## 6. 遗留到 M3(评审记下,未在 M2 修)

- revert 对 mcp merge 是整文件删 + `.bak` 还原,会丢「apply 之后用户手加的 server」;精确 un-merge 需台账记所加 server 名。
- skills 共享池(`{dir}/.agents/skills` 被 codex/cursor/agents-md 共享)的台账归属与 per-agent revert 协调。
- status 不比对软链是否仍指向库房真源(被改指向别处仍报 ok)。
- custom-kind server 的 config 内 `${...}` 引用不解析(仅文本扫描兜底)。
- mcp 生成物 provenance(`markers.isGenerated` 只认 markdown header)。
