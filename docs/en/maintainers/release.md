# Maintainer Release Checklist

[Documentation index](../../README.md) | [简体中文](../../zh-CN/maintainers/release.md)

This repository is pre-release. The workspace packages are still `private: true`
with version `0.0.0`.

## Before Publishing

1. Decide the public npm package names and the final user command.
2. Remove `private: true` from packages that should be published.
3. Set a real semver version consistently across workspace packages.
4. Confirm each package has `description`, `license`, and repository metadata.
5. Build and test from a clean checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

6. Inspect packed contents:

```bash
npm pack --workspaces --dry-run
```

7. Locally install the generated CLI tarball and verify:

```bash
cellarer --help
cellarer init
cellarer ui
```

8. Run `pnpm publish -r --dry-run` and inspect package names, files, and
   dependency versions.

## Publish

Publishing and pushing tags are external actions. A maintainer should perform
them deliberately after reviewing the dry-run output.

```bash
pnpm publish -r --access public
```

## After Publishing

- Verify the published package page.
- Verify the final install/run command.
- Update `README.md`, `README.zh-CN.md`, and CLI docs if the public command is
  different from the source-build examples.
- Create a release note that summarizes user-visible behavior, not internal
  implementation history.
