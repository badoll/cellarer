## ADDED Requirements

### Requirement: Store layout has one canonical grammar
The system SHALL derive every product Store path from one canonical physical Store identity and a closed named layout grammar. Store business modules MUST NOT construct managed paths from ad hoc relative string joins.

#### Scenario: Store is addressed through an alias
- **WHEN** callers provide relative, symlink, or case aliases for the same physical Store
- **THEN** layout resolution yields one canonical identity and the same named managed paths

### Requirement: Store snapshots are revision-coherent
A Store observation snapshot MUST bind its config, registry, ledger, selected profiles, and selected operation evidence to one stable Store revision. It MUST retry a bounded concurrent drift or return a typed stale-snapshot result and MUST NOT combine components from different revisions.

#### Scenario: Store changes during observation
- **WHEN** a writer advances the Store revision between snapshot component reads
- **THEN** the reader discards the mixed observation and retries or returns `STALE_STORE_SNAPSHOT`

### Requirement: Store snapshots are safe and reference-only
Snapshot construction MUST use canonical contained no-follow observations, MUST reject Store aliases or symlink traversal into external paths, and MUST contain secret references and redacted evidence rather than resolved secret values.

#### Scenario: Managed metadata path becomes a symbolic link
- **WHEN** snapshot construction encounters a symlinked managed path
- **THEN** it returns a typed unsafe-Store observation without reading external content

### Requirement: Read-only snapshots require no mutation capability
A read-only caller MUST be able to obtain a Store snapshot without mutation authority, mutation locks, or secret-provider read/write access.

#### Scenario: Dashboard reads a headless Store
- **WHEN** mutation authority and secret providers are unavailable
- **THEN** the dashboard can still obtain a coherent reference-only snapshot and performs no protected-provider interaction
