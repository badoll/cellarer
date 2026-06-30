# 发布(npx)—— 待手动执行

> v1 自动化止于「本地可运行 + `npm pack` dry-run 验证」。真正发布到 npm 由维护者手动执行,
> 此文档记录步骤。**无人值守流程不会替你 publish 或 push。**

## 现状(已就绪)

- `@cellarer/cli` 有 `bin.cellarer = ./dist/bin.js`、`files: ["dist"]`、`engines.node >=20.19`。
- `@cellarer/web` 的 `files` 含 `client/dist`(SPA 产物),`cellarer ui` 运行时按需挂载。
- `pnpm build` 经 turbo 产出 core/cli/web 的 `dist` 与 `client/dist`(SPA)。
- `npm pack --dry-run`(在各包目录)已验证 tarball 内容正确。
- 三包当前 `private: true`(防误发);CI 三平台四关全绿。

## 手动发布步骤

1. **去除 private + 定版**:把三包 `private: true` 移除,统一 `version`(如 `0.1.0`)。
   workspace 依赖(`workspace:*`)发布时 pnpm 会替换为实际版本号 —— 用 `pnpm publish -r` 处理。
2. **补元数据**:各包加 `repository` / `license` / `author`;`@cellarer/cli` 已有 `description`,
   core/web 暂无 `description`,发布前补上(改善 registry 列表展示)。
3. **构建**:`pnpm install --frozen-lockfile && pnpm build`(含 `vite build client`)。
4. **本地装包验证**:
   ```sh
   npm pack --workspaces            # 或在各包目录 npm pack
   npm i -g ./cellarer-cli-<ver>.tgz   # 本地全局装,试 cellarer --help / ui
   ```
5. **发布**:`pnpm publish -r --access public`(先 `--dry-run` 看清单)。
6. **验证 npx**:`npx @cellarer/cli@latest --help`。

## 注意

- `@napi-rs/keyring` 是 CLI 依赖,含平台原生二进制(各平台 optionalDependencies);
  发布前确认 npm 上对应平台包可用,headless 无 native 时 cellarer 已降级到 vault(不崩)。
- 发布与 `git push` 都是外发动作,需显式人工确认,不在无人值守范围内。
