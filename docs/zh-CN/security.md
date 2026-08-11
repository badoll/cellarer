# 安全

[文档索引](../README.md) | [English](../en/security.md)

cellarer 是本地配置工具,但密钥处理仍是硬边界。

## 明文密钥边界

库房资源和生成文件不得包含明文密钥。应使用引用:

```json
{
  "command": "example-server",
  "env": {
    "OPENAI_API_KEY": "${OPENAI_API_KEY}"
  }
}
```

或:

```json
{
  "command": "example-server",
  "env": {
    "OPENAI_API_KEY": "${CELLARER_SECRET:OPENAI_API_KEY}"
  }
}
```

## 仅引用渲染

分发会保留受支持的环境变量引用和 cellarer 引用 token。无论 `secretMode` 为何,
渲染目标配置时都不会读取 vault、keychain 或环境变量中的真值。

MCP adapter 通过 `supportedSecretReferences` 声明目标原生支持的引用种类。选中内容使用
目标不支持的引用时,planning 会跳过该 adapter;cellarer 不会回退为写入已解析真值。

兼容性是显式契约:

| 引用 | 兼容目标 |
| --- | --- |
| `${ENV_VAR}` | Adapter 声明支持 `environment`,且 agent 进程通过 cellarer 生成文件之外的渠道取得该环境变量。 |
| `${CELLARER_SECRET:name}` | Adapter 声明支持 `cellarer`,且目标能够原生解析该 token。 |

当前只有 Claude Code 与 Gemini CLI 内置 adapter 为通用 renderer 的精确 `${ENV_VAR}` 输出
声明 `environment` 支持。Codex 需要结构化 `env_vars` facility,OpenCode 使用
`{env:NAME}`,Windsurf 使用 `${env:NAME}`,而 Cursor 在这里没有已核验的精确 `${VAR}`
contract。这四个 adapter 都声明不支持 reference,直到实现 adapter-specific translation 前
planning 都会 fail closed。当前没有内置 adapter 声明 `cellarer` 支持。兼容矩阵见
[自定义适配器](adapters.md)。`secretMode` 只选择用于存在性验证和已知值扫描的 provider,
不会授权明文渲染。

## 导入与扫描护栏

- `add` 会拒绝包含高置信明文密钥的导入来源。
- `scan` 在写库房前会脱敏结构化 MCP 密钥字段。
- 写库房前还有最终明文护栏。
- `.json`、`.jsonc`、`.yaml`、`.yml`、`.toml` Skill 文件还会逐文件执行结构化敏感
  字段严格检测,且 import 与最终 staging 使用同一个 detector。共享 classifier 会先把
  lower、snake_case、kebab-case、dotted、camelCase 与 PascalCase 名称切成 identifier
  tokens,再匹配显式敏感字段词汇。例如 `access_token`、`access-token`、`access.token`、
  `accessToken`、`AccessToken`、`refreshToken` 与 `clientSecret` 都是等价敏感形态,而
  `passwords`、`passphrases`、`accessKeys`、`privatekeys`、`clientsecrets` 与 `apiKeys`
  等 plural/fused 形态也是显式词汇成员;`monkey`、`tokenizer`、`secretariat` 之类无关
  substring 不会误判。敏感 context 会由 parent 继承到每个 array item
  与 object descendant;该 context 下的 string、number、boolean 与 null 都是 finding。
  只有精确的 `${ENV_VAR}`、`${CELLARER_SECRET:name}` string 和既有 empty-string 表示安全;
  `${MISSING:-hunter2}` 之类 shell default 仍是明文 finding。JSON 与 JSONC duplicate key
  会直接基于捕获的 source bytes 拒绝,不会让 last-wins parsing 丢弃 earlier value。
  malformed 或不受支持的歧义结构化内容会 fail closed,不会退化为词法扫描。
- `reference`、`references`、`secretRefs` 是敏感字段名,不是 metadata bypass。其明文
  scalar 或 container descendant 都会被阻断或脱敏;只有精确支持的 typed-reference string
  可以通过。内部 ownership ledger 仅能通过专用 exact-key protocol serializer 保留已校验
  的 reference-name metadata,绝不存在全局 observable 例外。`secretMode` 仍是窄范围的
  非密钥 enum。
- YAML 的敏感 context 同时覆盖 indented sequence 与合法 indentless sequence。
  `password:` 等 key 下的每个 item 及其嵌套 array/object 都会继承该 context。
- 捕获的 MCP source 会在 import 发布 durable plan 或 active journal 前执行同一严格
  structured inspection。可预测的 validation rejection 不会留下 active recovery state;
  final serialized-byte guard 仍作为 defense in depth 保留。
- `--password` 等 raw 敏感 command flag 会在 command normalization 前,把完整后继 value
  置于敏感 context。非 reference string、number、boolean、null、array 与 object 都会让
  add/scan 在 provider access、durable-plan creation 或 journal publication 前阻断。
- `add` 会拒绝包含 symlink 的 skill 目录,因为 symlink 目标不能作为库房内容被安全扫描。
- 普通单个 Rule/MCP 文件使用可移植的 lstat/open/fstat 读取前后 identity handshake,
  Windows 也走该路径。递归 Skill capture 是独立的无额外依赖边界,当前支持 Darwin/Linux
  x64/arm64;它在隔离 Node 进程中锚定 traversal,对直接子项使用 no-follow open,并在接受
  snapshot 前复核稳定 identity。不支持的 recursive 平台会在读取或复制目录内容前 fail
  closed,但不会禁用安全的单文件路径。

MCP compatibility 检查会递归发现规范字段、stdio/remote extension data、array 与 custom
server config 中的 typed references。只要 adapter 不支持其中一种 kind,就会在 target
rendering 前拒绝。

## Web UI 安全

Web server:

- 只监听 `127.0.0.1`,并且启动时必须显式选择且只能选择一种认证模式
- Managed bearer 只从受保护的继承 descriptor 读取,绝不来自 argv、environment
  fallback、URL、ready record 或 HTTP response
- 内置 browser 每次启动都会得到新的随机 session;只有精确 Host、Origin 与 Fetch
  Metadata 检查通过后才设置 `HttpOnly`、`SameSite=Strict`、scope 为 `/api/v1` 的 cookie
- 静态资源、bootstrap、discovery、read 与 mutation 都校验精确 loopback Host;每个
  browser mutation 还必须提供精确 Origin
- 只有 `/api/v1/health` 无需认证;authenticated readiness 只返回 typed Store、
  authority、lock 与 recovery blockers,不暴露 provider 或 path 细节
- 返回 reference-only plan,并对每个 `/api/v1` JSON response 应用最终 serialization guard

未版本化 `/api/*` route 与 query-token behavior 均不存在。Managed ownership 使用独立的
继承 lifetime descriptor;EOF、programmatic close、SIGINT 与 SIGTERM 都进入同一个有界
shutdown 路径。强制关闭 connection 不会删除 Core journal 或猜测 recovery state。

CLI composition root 会在启动 Web 前 preload Store 范围的 mutation authority。Web
只得到用于 sealing、current-epoch lease 与 protected journal tip 的窄
`MutationAuthority` capability;不会得到通用 `SecretStore`、raw key、credential-provider
handle 或 authority lifecycle operation。Web scan/import composition 始终强制
environment-reference mode,不会调用 vault/keychain secret。缺少可用 authority 时,只读
scan planning 仍可使用,executable import 与其他 mutation routes 会 fail closed。

Core error serialization、CLI JSON output 与 Web JSON response 会使用和 structured guard
相同的敏感字段 classifier 及 container context 继承语义。所有非 reference descendant
scalar 都替换为 `[REDACTED]`,不会返回原值或可逆 derivative;精确支持的 reference string
和 empty-string 表示保持不变。

## Mutation authority

每个 executable plan、durable plan 与 journal publication 除了无 key 的 integrity digest,
还必须由 domain-separated HMAC authority 认证。Seal 会绑定 normalized Store root、
operation、base revision、精确 canonical payload、authority id 与 epoch。Digest 不等于
authority。

Composition 会先通过注入的 `realpath` effect 把 `CELLARER_HOME` 收敛为绝对物理路径,再派生
credential account、headless kernel owner、Core/Web mutation scope、seal、journal 与 lock
路径。因此 relative、symlink 与文件系统 case alias 共用一个 identity。只有 `init` 可以在
canonicalization 前创建缺失的 Store root;其他 authority 路径不会把创建目录作为副作用。

本地常规使用时,`cellarer init` 会从 OS credential manager 加载随机 256-bit master key;
若不存在则按 normalized Store root 派生的 account 创建,且只有精确回读校验后才算
provision 成功。Core 只看到不可序列化的 seal/verify capability;raw key 不会进入 Store
或任何 observable output。

Credential service `dev.cellarer.mutation-authority.v1`,以及所有以
`__cellarer_internal__:mutation-authority:v1:` 开头的 accounts,都保留给 authority
material 与 protected journal tips。普通密钥的创建、读取、更新与删除路径会在 provider
access 前拒绝任一 namespace;该内部 account grammar 也不能由
`${CELLARER_SECRET:name}` 寻址。绝不要通过 `cellarer secret` 或通用 credential 管理脚本
检查、编辑或删除这些 entries。

Headless/CI 只能使用 `CELLARER_MUTATION_AUTHORITY`,格式为
`v1:<正整数-epoch>:<43-字符-无填充-base64url-key>`,解码后必须恰好为 32 bytes。应通过
runner 受保护的 secret-to-environment facility 提供。绝不能通过 argv、JSON、配置、
Store 文件、日志、stdout 或 stderr 传递。显式但 malformed 的值会 fail closed,不会
回退 keychain。

Headless composition 会在 executable planning 前为每个 Store 建立一个不可重放的 kernel
process-lifetime owner。注入的 `Env` capability 只在 `127.0.0.1` 上独占监听由 Store scope
确定性得到的本地 port,不连接现有占用者,并对 listener 执行 unref。kernel lease 存活时,
其他进程不能让相同或不同 epoch 成为 current;进程退出时 kernel 自动释放 lease。Store
bytes 从不构成 authority evidence,因此删除、替换或重放旧 owner-shaped 文件不能恢复 stale
capability。无关本地 listener 或 port collision 会 fail closed,不会被探测或信任。

首次 provisioning 与 rotation 共用 Store 范围的 authority coordination boundary。
Rotation 还会排除 mutation/recovery,任意 active journal 存在时都会拒绝。Execution 会在
canonical replanning 前、持有 authority lease 时以及 Store mutation lock 内再次检查
currentness。这让 rotation、mutation 与 recovery 只有一个串行顺序,并阻止 stale 长期
进程在新 epoch 先取得顺序后观察产品状态或执行外部 effect。

每个 mutating Core entry point,包括 apply、add、scan-apply,以及每个 recovery diagnosis,
都会在读取 config、journal、protected tip、lock、receipt、registry、ledger 或 target 前
检查 currentness 并取得同一个 operation lease。Currentness 会在 lease acquisition 前后
各检查一次;Store mutation lock 内既有的 recheck 仍作为独立最终门保留。

`cellarer authority rotate` 只轮换 OS-keychain authority。任意 active journal 存在时都会
拒绝。成功后会递增 epoch,使所有旧 plans/journals 失效。Headless 场景只能在证明不存在
active journal 后,由 runner 把受保护值替换为更高 epoch。移动或 clone 的 Store scope
不同,必须使用独立 authority。

provider 锁定或不可用时,应恢复已有 credential 或受保护环境值。不要删除 active journal、
静默创建 ephemeral key,也不要在 recovery 期间 rotation。Unsigned、cross-Store、unknown-
epoch 与 prior-epoch records 不经 legacy compatibility 直接拒绝,只能 manual recovery。
只读 CLI operation 仍可使用,但不会声称这些 records 安全。

Credential-manager composition 会在 Store 之外,用受保护的
`{ operationId, sequence, seal }` tip 锚定每次最新 journal publication。自动 recovery
要求精确匹配。tip 缺失、不可读、过期或不匹配时,包括 replay 较旧但本身有效的 journal,
都会在 claim、provider、产品状态观察或 compensation 之前转为 manual-only。

显式 headless channel 没有受保护的持久 monotonic storage,因此 tip 只存在于观察到每次
publication 的 authority 实例内。进程退出或重启后,即使恢复完全相同的 headless
environment value,active journal 仍是 manual-only。不要通过删除 journal、provision
替代 authority 或 rotation epoch 绕过此限制。

`scan --dry-run` 是 authority-optional 的只读 operation:它强制使用 environment-
reference mode,既不 provision 也不 query authority、vault 或 keychain credentials。该
例外不适用于 executable import,也不适用于会生成 executable mutation plan、因此仍要求
authority 的 `apply --dry-run`。

## 安全输入密钥

不要把新密钥真值放进位置参数或选项。人类用户应在终端运行 `secret add <name>`;
cellarer 会关闭回显并要求确认,随后通过另一个隐藏提示读取 vault 口令。生产命令不接受
密钥真值或口令作为 option value。

自动化只能选择一个受保护输入通道:

```bash
# Runner 负责保护该文件为仅当前用户可读,并在命令后删除。
node packages/cli/dist/bin.js secret add OPENAI_API_KEY --stdin --passphrase-fd 3 3< "$CELLARER_VAULT_PASSPHRASE_FILE" < "$CELLARER_SECRET_INPUT_FILE"

# stdin 已被结构化输入占用时,使用独立的继承描述符。
node packages/cli/dist/bin.js secret add OPENAI_API_KEY --fd 4 --passphrase-fd 3 3< "$CELLARER_VAULT_PASSPHRASE_FILE" 4< "$CELLARER_SECRET_INPUT_FILE"
```

描述符编号必须不小于 3。`--stdin` 与 `--fd` 互斥,passphrase 使用独立描述符。stdout 和
stderr 都不会返回真值。

## 轮换曾经暴露的密钥

如果一个真值曾被写入库房制品、生成目标、命令参数、日志或响应,应将其视为已泄露:

1. 重新使用该集成前,先在上游 provider 撤销或轮换密钥。
2. 从源制品、生成目标、shell history、日志及保留备份中移除旧明文。不要把已暴露值导入
   vault 作为迁移捷径。
3. 通过 hidden input、`--stdin` 或 `--fd` 存入替换值,或在 cellarer 生成配置之外安排
   环境变量。
4. 将配置字段替换为目标兼容的引用 token。
5. 检查 `apply --dry-run` 结果,应用干净 plan,并运行仓库或 provider 的密钥扫描器。
   随后可用 `status --json` 确认受管目标漂移,但它不能替代撤销或扫描。

## 已知边界

密钥检测是防御性能力,但不可能完美。低熵密码、自定义 token 格式或少见字段中的凭证仍需要人工审查。
涉及敏感配置时,请把 `--dry-run`、代码审查和仓库扫描纳入流程。

需要 cellarer 明文化的 adapter 会被有意判为不兼容。应改用原生支持引用的目标,而不是削弱
仅引用边界。
