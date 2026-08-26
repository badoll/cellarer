## Why

Cellarer already packs an executable CLI, but the product still presents an alpha version and repository-only `node packages/cli/dist/bin.js` commands as the supported user path. The first stable release should make the installed `cellarer` executable the canonical interface and prove that interface from release artifacts before any separately authorized registry publication.

## What Changes

- Promote the public Core, Web, and CLI packages from `0.1.0-alpha.0` to the synchronized stable version `0.1.0`.
- Make installation of a packed or published `@cellarer/cli` artifact followed by `cellarer init` the canonical user workflow.
- Replace source-tree CLI paths in public user documentation with the installed `cellarer` command while retaining a clearly separated contributor workflow.
- Strengthen the release gate so clean-install acceptance resolves `cellarer` through the installed command search path and rejects a prerelease version on the stable-release path.
- Keep the monorepo root private and keep npm publication, tags, releases, and deployment outside this local change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `installable-cli-distribution`: Require a stable synchronized package version, an installed `cellarer` command resolved through the consumer environment, and release-oriented installation and usage documentation.

## Impact

- Public package manifests under `packages/{core,web,cli}`, their internal dependency versions, the synchronized workspace lockfile importers, and the CLI command-surface release fixture.
- The local version-preparation and packed-artifact release gates under `scripts/`.
- English and Simplified Chinese root and detailed documentation plus the CLI package README.
- No command semantics, Store schema, Core mutation behavior, dependency set, or remote release state changes.

## Execution Contract

- Risk: integration
- Depends on: none
- Allowed paths: `openspec/changes/promote-stable-cli-release/**`, `openspec/specs/installable-cli-distribution/spec.md`, `package.json`, `pnpm-lock.yaml`, `packages/core/package.json`, `packages/web/package.json`, `packages/cli/package.json`, `packages/cli/README.md`, `packages/cli/tests/fixtures/command-surface-v1.json`, `scripts/prepare-version.mjs`, `scripts/artifact-release-gate.mjs`, `README.md`, `README.zh-CN.md`, `docs/README.md`, `docs/README.zh-CN.md`
