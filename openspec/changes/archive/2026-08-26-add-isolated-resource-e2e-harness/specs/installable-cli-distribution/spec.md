## MODIFIED Requirements

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
