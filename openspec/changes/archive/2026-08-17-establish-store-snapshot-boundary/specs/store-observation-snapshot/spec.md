## ADDED Requirements

### Requirement: Configuration observation uses one canonical layout
The system SHALL derive the configuration and revision paths used by configuration snapshots from one canonical physical Store identity. Consumers migrated to this snapshot MUST use those named paths rather than reconstructing them.

#### Scenario: Store is addressed through an alias
- **WHEN** callers provide relative, symlink, or case aliases for the same physical Store
- **THEN** layout resolution yields one canonical identity and the same named configuration and revision paths

### Requirement: Configuration snapshots are revision-coherent
A configuration snapshot MUST bind its parsed configuration to one stable Store revision. It MUST discard an observation affected by concurrent revision drift, retry at most once, and otherwise return a typed stale-snapshot result.

#### Scenario: Store changes during observation
- **WHEN** a writer advances the Store revision between snapshot component reads
- **THEN** the reader discards that observation and retries once or returns `STALE_STORE_SNAPSHOT`

### Requirement: Configuration snapshots are safe and reference-only
Configuration snapshot construction MUST use a canonical contained no-follow observation, MUST reject managed-file symlink traversal into external paths, and MUST contain secret references rather than resolved secret values.

#### Scenario: Managed metadata path becomes a symbolic link
- **WHEN** snapshot construction encounters a symlinked managed path
- **THEN** it returns a typed unsafe-Store observation without reading external content

### Requirement: Configuration snapshots require no mutation capability
A read-only caller MUST be able to obtain a configuration snapshot without mutation authority, mutation locks, or secret-provider read/write access.

#### Scenario: Control plane reads a headless Store
- **WHEN** mutation authority and secret providers are unavailable
- **THEN** `showControlPlaneConfig` still returns its coherent reference-only result and performs no protected-provider interaction
