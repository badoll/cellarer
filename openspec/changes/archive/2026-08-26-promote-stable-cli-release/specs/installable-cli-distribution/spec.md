## ADDED Requirements

### Requirement: Public usage is expressed through the installed command
Public user documentation MUST present installation of the CLI package followed by `cellarer <command>` as the canonical workflow, and MUST keep source-tree execution in contributor-only guidance.

#### Scenario: User follows the first-run guide
- **WHEN** a user reads the public installation and first-run documentation
- **THEN** the documented workflow installs the CLI package and initializes the product with `cellarer init`

#### Scenario: Contributor runs from a source checkout
- **WHEN** a contributor reads development or release-maintainer guidance
- **THEN** repository build and source-entry commands remain available without being presented as the installed product interface

## MODIFIED Requirements

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

### Requirement: Release gate tests installed artifacts
The project MUST provide a deterministic local release gate that builds, packs, inspects, installs, and exercises only the stable release artifacts with isolated state, including resolution of the installed `cellarer` command by name.

#### Scenario: Clean artifact gate succeeds
- **WHEN** the stable release gate runs on a supported Node/OS job
- **THEN** command-path resolution, version, protocol discovery/schema, doctor/init dry-run, a minimal resource management journey, and Web asset smoke checks pass from the installed bin

#### Scenario: Tarball contains a forbidden file or canary
- **WHEN** pack inspection finds source tests, caches, local state, development-only paths, or an unredacted secret canary
- **THEN** the gate fails before any publish step

#### Scenario: Package version is still prerelease
- **WHEN** the stable release gate inspects a package version with a prerelease component
- **THEN** the gate fails before any publish step
