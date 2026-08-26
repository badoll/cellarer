# installable-cli-distribution Specification

## Purpose

Define reproducible, locally verifiable package artifacts and clean-install runtime behavior for the Cellarer CLI without authorizing any remote publication action.

## Requirements

### Requirement: Public usage is expressed through the installed command
Public user documentation MUST present installation of the CLI package followed by `cellarer <command>` as the canonical workflow, and MUST keep source-tree execution in contributor-only guidance.

#### Scenario: User follows the first-run guide
- **WHEN** a user reads the public installation and first-run documentation
- **THEN** the documented workflow installs the CLI package and initializes the product with `cellarer init`

#### Scenario: Contributor runs from a source checkout
- **WHEN** a contributor reads development or release-maintainer guidance
- **THEN** repository build and source-entry commands remain available without being presented as the installed product interface

### Requirement: Release packages have coherent public metadata
Core, Web, and CLI stable release artifacts MUST use one prepared synchronized SemVer version without a prerelease component, MUST contain publishable dependency ranges instead of workspace protocols, and SHALL declare the supported Node runtime and required public metadata.

#### Scenario: Stable package tarballs are inspected
- **WHEN** stable release artifacts are packed
- **THEN** their manifests have one non-prerelease version, resolvable Core/Web dependency ranges, licenses, package documentation, and no private release blocker

#### Scenario: Root workspace is inspected
- **WHEN** package metadata is prepared
- **THEN** the monorepo root remains private and is not a publish candidate

### Requirement: Packed CLI is executable outside the repository
The CLI artifact MUST install a `cellarer` executable with a valid Node shebang and mode, MUST resolve by command name through the consumer's installed command path, and MUST run without repository cwd, pnpm workspace links, or TypeScript source.

#### Scenario: Tarballs are installed cleanly
- **WHEN** the packed release set is installed into a new temporary project and its installed command directory is on `PATH`
- **THEN** invoking `cellarer --version` by command name succeeds and reports the packed CLI version

#### Scenario: Workspace source is unavailable
- **WHEN** installed CLI tests run with only package artifacts on the module path
- **THEN** all runtime imports resolve from installed dependencies and no path points into the source workspace

### Requirement: Runtime assets are complete and location independent
Package artifacts MUST include Core runtime config/schema data, CLI output, Web server output and client assets, and SHALL resolve them relative to installed modules rather than the current directory.

#### Scenario: CLI starts from an unrelated directory
- **WHEN** the installed command runs from an empty working directory
- **THEN** capabilities/schema and Core adapter configuration load successfully

#### Scenario: Installed Web UI is started
- **WHEN** the installed `cellarer ui` starts with isolated state
- **THEN** the loopback dashboard and its static assets return successfully without source-tree files

### Requirement: Native keychain absence has a verified fallback
Installation and ordinary CLI startup MUST succeed when the native keychain binding is unavailable, and secret storage SHALL expose and use the encrypted-vault fallback without disclosing values.

#### Scenario: Platform has no compatible keychain binding
- **WHEN** the packed CLI is installed and keychain initialization reports unavailable
- **THEN** doctor reports the limitation and a secret-store smoke test can use the encrypted vault

#### Scenario: Supported native binding is available
- **WHEN** CI runs on a supported platform with the binding
- **THEN** a non-user, isolated keychain capability smoke test passes or reports a typed environment limitation

### Requirement: Release gate tests installed artifacts
The project MUST provide a deterministic local release gate that builds, packs, inspects, installs, and exercises only the stable release artifacts with isolated state, including resolution of the installed `cellarer` command by name and an isolated Rules/MCP/Skills resource journey from bounded Inventory discovery through Store import, multi-Agent distribution, convergence, verification, sidecar read parity, and revert.

#### Scenario: Clean artifact gate succeeds
- **WHEN** the stable release gate runs on a supported Node/OS job
- **THEN** command-path resolution, version, protocol discovery/schema, doctor/init dry-run, the isolated resource acceptance journey, and Web asset smoke checks pass from the installed bin

#### Scenario: Focused resource acceptance runs
- **WHEN** a maintainer invokes the dedicated local resource acceptance entrypoint
- **THEN** the gate packs and cleanly installs the synchronized package set once, invokes the installed command against repository fixtures, and returns the closed resource-journey report without publishing or using workspace runtime links

#### Scenario: Tarball contains a forbidden file or canary
- **WHEN** pack inspection finds source tests, caches, local state, development-only paths, or an unredacted secret canary
- **THEN** the gate fails before any publish step

#### Scenario: Package version is still prerelease
- **WHEN** the stable release gate inspects a package version with a prerelease component
- **THEN** the gate fails before any publish step

### Requirement: Supported runtime matrix is enforced
The project SHALL document and test its supported Node/OS matrix and MUST fail clearly on an unsupported Node version before state mutation.

#### Scenario: Supported matrix job runs
- **WHEN** artifact acceptance runs for a documented Node and OS combination
- **THEN** the same clean-install contract is verified on that job

#### Scenario: Node runtime is too old
- **WHEN** the executable starts on a Node version below the declared minimum
- **THEN** it emits a clear runtime requirement and performs no store mutation

### Requirement: Publication remains an explicit external action
Local release preparation and validation MUST NOT publish packages, create remote tags/releases, change dist-tags, or deploy services.

#### Scenario: Local release gate completes
- **WHEN** every artifact check passes
- **THEN** tarballs and a readiness report exist locally while all remote state remains unchanged
