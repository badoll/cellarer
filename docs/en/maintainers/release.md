# Maintainer Release Checklist

[Documentation index](../../README.md) | [简体中文](../../zh-CN/maintainers/release.md)

The first prepared release candidate is `0.1.0-alpha.0`. Core, Web, and CLI are
packable public packages; the monorepo root remains private. No package has been
published by this preparation work.

## Supported Runtime Matrix

- Node.js `>=20.19`
- Ubuntu, macOS, and Windows

Release readiness requires the same installed-artifact gate on every supported
OS. CI runs Node 20.19 on `ubuntu-latest`, `macos-latest`, and
`windows-latest`, matching the documented minimum and OS set.

## Package Contents

- `@cellarer/core`: compiled runtime plus packaged `config.json`
- `@cellarer/web`: compiled server plus built `client/dist` dashboard assets
- `@cellarer/cli`: compiled `cellarer` executable with its Node shebang and mode

Each package also contains its manifest, README, and license. Source, tests,
caches, local state, and plaintext secret canaries are forbidden.

## Before Publishing

1. Choose the release version and prepare all public manifests consistently:

```bash
pnpm version:prepare -- 0.1.0-alpha.0
pnpm version:check -- 0.1.0-alpha.0
```

2. Confirm the root remains private and each public package has its required
   metadata and files.
3. Run the local pack inspection or the complete readiness gate:

```bash
pnpm artifact:pack
CI=true pnpm release:readiness
```

Both commands build, pack twice, inspect deterministic contents, and write
tarballs plus `readiness.json` under the ignored local directory
`artifacts/release-readiness/`. The readiness command additionally installs the
tarballs into an isolated temporary project and exercises version, protocol,
doctor/init, resource management, and vault fallback from the installed bin. It
also launches the installed sidecar from the clean project on port `0` in both
browser-session and managed-bearer modes, validates the one-record ready result
and OpenAPI contract, authenticates, serves bundled assets, closes the lifetime
descriptor, and requires a clean exit. It never uses the real cellarer home,
agent configuration, or credential store.

4. Confirm CI ran `pnpm release:readiness` successfully for every supported
   Node/OS matrix job.

These local commands cannot publish packages, create or push tags/releases,
change dist-tags, deploy, or modify any remote service. Publication remains a
separately authorized external procedure and is outside this checklist.

## Single-Executable Decision

The single-executable channel is currently **no-go**. This decision does not
affect npm readiness: the supported release contract remains the three packed
packages and the installed-artifact gate above.

A bounded prototype on macOS arm64 with Node.js 24.4.1 produced SEA preparation
blobs from both ESM and CommonJS entry files. The blobs embedded a Core-like JSON
config asset and a Web HTML asset; running the ESM prototype normally also
confirmed that an unavailable optional keyring can select a fallback. The
prototype recorded these constraints:

- Node generated the preparation blobs, but producing an executable still
  requires a separate injection step. The repository has no injector, and the
  evaluation deliberately added no dependency or downloaded toolchain.
- Blob creation accepting an ESM file is not evidence that the injected SEA can
  execute cellarer's installed ESM dependency graph. That graph, package
  resolution, dynamic loading, and the external native keyring binding still
  require a bundling/loading design and per-platform tests.
- The local Node executable was 89,043,808 bytes before adding application code,
  Web assets, config, or native variants. A SEA would therefore be materially
  larger than the npm package payload.
- A shippable binary requires separate macOS arm64/x64, Windows x64, and Linux
  x64 builds. Each must repeat startup, assets, fallback, and native-available
  checks; macOS and Windows additionally require platform signing, with macOS
  notarization handled by an authorized release environment.

Reconsider SEA only when a dependency-free or approved injection/bundling path
can run the complete ESM CLI and Web UI, optional-native behavior is defined per
target, target binaries have acceptable size and startup measurements, and the
release environment owns cross-platform build, signing, and notarization. Until
all of those criteria are met, SEA remains an optional future channel rather
than a release gate.

## After an Authorized Publication

- Verify the published package page.
- Verify the final install/run command.
- Update `README.md`, `README.zh-CN.md`, and CLI docs if the public command is
  different from the source-build examples.
- Create a release note that summarizes user-visible behavior, not internal
  implementation history.
