# 维护者发布 Checklist

[文档索引](../../README.md) | [English](../../en/maintainers/release.md)

首个已准备的候选版本为 `0.1.0-alpha.0`。Core、Web、CLI 已成为可打包的公开包,
monorepo 根仍保持 private。本次准备工作没有发布任何 package。

## 支持的运行矩阵

- Node.js `>=20.19`
- Ubuntu、macOS、Windows

发布就绪要求在每个支持的 OS 上执行同一套 installed-artifact gate。Node 20.19 是
CI runtime;CI 在 `ubuntu-latest`、`macos-latest`、`windows-latest` 上运行它,与文档
中的最低版本和 OS 集合一致。

## 包内容

- `@cellarer/core`:编译后的 runtime 与随包 `config.json`
- `@cellarer/web`:编译后的 server 与已构建 `client/dist` dashboard assets
- `@cellarer/cli`:保留 Node shebang 和 mode 的已编译 `cellarer` 可执行入口

每个包也包含 manifest、README 和 license。禁止包含 source、tests、cache、本地状态
与明文 secret canary。

## 发布前

1. 选择 release version,并一致地准备所有公开 manifest:

```bash
pnpm version:prepare -- 0.1.0-alpha.0
pnpm version:check -- 0.1.0-alpha.0
```

2. 确认 root 保持 private,并且每个公开 package 都有必要的 metadata 和文件。
3. 运行本地 pack inspection 或完整 readiness gate:

```bash
pnpm artifact:pack
CI=true pnpm release:readiness
```

两个命令都会 build、pack 两次、检查确定性内容,并把 tarball 与 `readiness.json` 写入
已忽略的本地目录 `artifacts/release-readiness/`。Readiness 命令还会把 tarball 安装
到隔离临时 project,仅从 installed bin 验证 version、protocol、doctor/init、resource
management、vault fallback 与 loopback Web assets。它不会使用真实 cellarer home、
agent 配置或 credential store。

4. 确认每个支持的 Node/OS matrix job 都成功运行了 `pnpm release:readiness`。

这些本地命令不能发布 package、创建或推送 tag/release、修改 dist-tag、部署或更改
任何远程服务。发布仍是需要单独授权的外部流程,不属于本 checklist。

## 单可执行文件决策

单可执行文件渠道当前结论为 **no-go**。该结论不影响 npm 就绪性：受支持的发布契约
仍是三个打包 package 与上文的 installed-artifact gate。

在 macOS arm64、Node.js 24.4.1 上进行的限时 prototype 分别从 ESM 和 CommonJS
入口生成了 SEA preparation blob。Blob 嵌入了类似 Core config 的 JSON asset 和 Web
HTML asset；正常运行 ESM prototype 还确认了 optional keyring 不可用时可以选择
fallback。Prototype 记录了以下约束：

- Node 能生成 preparation blob，但产出 executable 仍需单独的注入步骤。仓库没有
  injector；本次评估按约束没有新增依赖或下载 toolchain。
- Blob 生成接受 ESM 文件，不等于注入后的 SEA 能执行 cellarer 已安装的完整 ESM
  依赖图。该依赖图、package resolution、dynamic loading 与外部 native keyring
  binding 仍需要 bundling/loading 设计和逐平台测试。
- 本机 Node executable 在加入应用代码、Web assets、config 或 native variant 之前
  已有 89,043,808 bytes。因此 SEA 会显著大于 npm package payload。
- 可发布 binary 至少需要分别构建 macOS arm64/x64、Windows x64 与 Linux x64 目标。
  每个目标都必须重复 startup、assets、fallback 和 native-available 检查；macOS 与
  Windows 还需要平台签名，macOS notarization 必须由获授权的发布环境完成。

只有在无需依赖或获批准的 injection/bundling 路径能运行完整 ESM CLI 和 Web UI、
逐目标定义 optional-native 行为、目标 binary 的体积和启动测量可接受，并且发布环境
具备跨平台 build、签名与 notarization 能力时，才重新评估 SEA。在满足全部条件前，
SEA 仍是可选的未来渠道，而不是 release gate。

## 经授权发布后

- 验证已发布的包页面。
- 验证最终安装/运行命令。
- 如果公开命令与源码构建示例不同,同步更新 `README.md`、`README.zh-CN.md` 和 CLI 文档。
- 发布说明应总结用户可见行为,不要写内部实施历史。
