# 维护者发布 Checklist

[文档索引](../../README.md) | [English](../../en/maintainers/release.md)

当前仓库处于发布前状态。workspace 包仍是 `private: true`,版本仍是 `0.0.0`。

## 发布前

1. 确认公开 npm 包名和最终用户命令。
2. 从需要发布的包中移除 `private: true`。
3. 给 workspace 包设置一致的真实 semver 版本。
4. 确认各包有 `description`、`license` 和 repository 元数据。
5. 在 clean checkout 中构建和测试:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

6. 检查打包内容:

```bash
npm pack --workspaces --dry-run
```

7. 本地安装生成的 CLI tarball 并验证:

```bash
cellarer --help
cellarer init
cellarer ui
```

8. 运行 `pnpm publish -r --dry-run`,检查包名、文件清单和依赖版本。

## 发布

发布和推 tag 都是外部动作。维护者应在审查 dry-run 输出后有意执行。

```bash
pnpm publish -r --access public
```

## 发布后

- 验证已发布的包页面。
- 验证最终安装/运行命令。
- 如果公开命令与源码构建示例不同,同步更新 `README.md`、`README.zh-CN.md` 和 CLI 文档。
- 发布说明应总结用户可见行为,不要写内部实施历史。
