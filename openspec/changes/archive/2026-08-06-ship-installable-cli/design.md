## Context

The repository is a private `0.0.0` pnpm workspace. `@cellarer/cli` declares `cellarer` at `dist/bin.js` and depends on private workspace Core/Web packages; Web also needs built client assets and Core ships packaged adapter config. The CLI lazily handles native keychain loading, which must remain compatible with platforms where the binding is absent. Repository execution does not prove any of these relations survive packing.

## Goals / Non-Goals

**Goals:**

- Produce versioned package tarballs that contain all required runtime files.
- Install and execute `cellarer` in a clean directory without workspace resolution.
- Keep Core/Web/CLI package versions and dependency ranges coherent.
- Validate CLI protocol, local Web UI, and secret-provider fallback from installed artifacts.
- Test the supported Node/OS matrix before release readiness is claimed.
- Reach an evidence-backed decision on a future single-executable channel.

**Non-Goals:**

- Publishing to npm, creating tags/releases, or deploying anything remotely.
- Rewriting the TypeScript/Node Core or CLI.
- Making a single executable, Homebrew formula, or installer mandatory for the first release.
- Bundling platform credentials or requiring native keychain availability.
- Building an auto-updater.

## Decisions

### Publish the existing package boundaries together

Core, Web, and CLI become packable packages with synchronized versions. Release order is Core, Web, then CLI, and packed dependency metadata must contain publishable semver rather than `workspace:*`. This preserves Core-first modularity and avoids a premature bundle that obscures licenses/assets.

The root remains private. Actual registry publication is a separately authorized release action.

### Make npm CLI installation the required channel

The release contract is `npm install --global @cellarer/cli` or equivalent package-manager/npx use on the supported Node version. The `cellarer` bin must retain its shebang and executable mode and must not depend on repository cwd, pnpm layout, or TypeScript source.

### Resolve runtime assets relative to installed modules

Packaged Core configuration and Web client assets are located through ESM module/package URLs, not `process.cwd()`. Pack manifests explicitly include dist output, schemas/config, Web client assets, license, and package README; an allowlist rejects source, tests, caches, local state, and secret fixtures.

### Treat native keychain as an optional enhancement

The keyring package is loaded lazily and failure produces a typed availability result. Packaging must allow installation without a compatible binding and must verify encrypted-vault fallback. Supported platforms with a compatible binding also receive a keychain smoke test that never uses real user secrets.

### Test the artifacts, not the workspace

A release verification script builds, packs, inspects tarball manifests, installs the packed packages into a temporary clean project, and invokes only the installed bin. It uses isolated home/store paths and verifies version, capabilities/schema, doctor/init dry-run, a minimal local management journey, and loopback Web dashboard assets.

CI repeats the artifact test on the documented Node/OS matrix. The gate fails on workspace path leakage, missing files, inconsistent versions, unredacted canaries, or undeclared runtime dependencies.

### Separate version preparation from publication

One checked script validates or applies a shared release version across public packages and injects the installed version into CLI output. Pack/check is local and deterministic. Registry publish, dist-tags, provenance attestation, and Git release remain explicit later steps.

### Time-box a single-executable feasibility spike

The spike measures ESM/module loading, Web static assets, schemas/config, native optional modules, artifact size, startup, signing implications, and cross-platform build complexity using the then-supported Node tooling. It ends in a committed decision record with go/no-go criteria; a no-go does not block npm readiness.

## Risks / Trade-offs

- [Three packages increase release ordering complexity] → Enforce synchronized versions, pack metadata checks, and dependency-order release instructions.
- [Native optional dependencies behave differently by OS/package manager] → Test install without binding plus supported-platform smoke paths and keep vault fallback first-class.
- [Workspace tests can accidentally mask missing runtime files] → Run acceptance only against extracted/installed tarballs in a clean temporary directory.
- [Web UI assets inflate CLI installation] → Keep them because `cellarer ui` is a documented CLI capability and audit size in the pack gate.
- [A single executable may require brittle bundling] → Treat it as a measured future channel, not a release blocker.

## Migration Plan

1. Define the first real pre-release version and supported Node/OS matrix.
2. Update package metadata, files, dependency ranges, version injection, and optional native handling.
3. Add pack inspection and clean-install E2E locally and in CI.
4. Update installation/release docs and complete the single-executable decision record.
5. Only after all gates pass, request separate authorization for any registry or GitHub release operation.

Rollback consists of reverting package/release metadata and discarding local tarballs. No remote state is changed by this change.

## Open Questions

None for npm readiness. The single-executable decision is intentionally an output of its bounded feasibility task.
