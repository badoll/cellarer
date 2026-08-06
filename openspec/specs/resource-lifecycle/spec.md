# resource-lifecycle Specification

## Purpose
Define provenance-aware resource revision, update, rename, removal, export, import, and target-uninstall behavior while preserving dependency, ownership, secret, and recovery guarantees.

## Requirements

### Requirement: Resources retain immutable identity and revision evidence
The system SHALL keep a resource's immutable ID across accepted content updates and MUST record each current revision's content fingerprint, validation evidence, and source provenance.

#### Scenario: Git-backed Skill is updated
- **WHEN** a validated newer candidate is accepted for an existing Git-backed Skill
- **THEN** the resource ID remains stable while the current revision and pinned source evidence change

#### Scenario: Legacy resource lacks remote provenance
- **WHEN** a managed resource has only a local content snapshot
- **THEN** it remains usable but update checking reports that no verifiable remote source is configured

### Requirement: Update checking is read-only and updates are staged
The system SHALL check source evidence without mutating store or targets and MUST stage, validate, secret-scan, diff, and pin a candidate before producing an update plan.

#### Scenario: Upstream has a newer revision
- **WHEN** a read-only check finds source content different from the current pinned revision
- **THEN** it reports update availability and immutable source evidence without changing desired or applied state

#### Scenario: Candidate fails secret scanning
- **WHEN** a staged update contains a blocked credential finding
- **THEN** no update plan is eligible for apply and the current managed revision remains unchanged

#### Scenario: Source changes after planning
- **WHEN** the upstream ref moves after a candidate plan is created
- **THEN** apply uses only the pinned staged candidate or rejects failed integrity evidence rather than fetching different content

### Requirement: Store update does not silently distribute targets
Applying a resource update plan SHALL change the managed store revision and desired-state diff but MUST NOT overwrite agent targets until a separate distribution plan is applied.

#### Scenario: Updated resource is currently deployed
- **WHEN** its staged update is accepted into the store
- **THEN** verification reports desired-versus-applied divergence while the intact old target remains unchanged

### Requirement: Rename and removal preserve dependencies
The system MUST plan resource rename and removal by exact ID, SHALL report collection/profile/selection/target dependencies, and MUST NOT infer cascade from a name or ordinary remove request.

#### Scenario: Resource is referenced by a profile
- **WHEN** ordinary remove targets that resource
- **THEN** the plan is blocked and identifies the dependent profile and any owned targets

#### Scenario: Explicit cascade is requested
- **WHEN** a caller requests a cascade plan for an exact resource ID
- **THEN** the plan enumerates every dependent store edit and remains blocked until any owned targets are handled by a separate sync uninstall plan

#### Scenario: Source-defined name is changed
- **WHEN** rename would alter source-managed content identity
- **THEN** the system requires creation of an explicit local fork instead of falsifying the source provenance

### Requirement: Store removal, target uninstall, and revert are distinct
The system MUST expose resource removal, sync target uninstall, and historical revert as separate planned operations with no implicit cross-operation effects.

#### Scenario: Intact targets are uninstalled
- **WHEN** a sync uninstall plan for exact owned targets is applied
- **THEN** those targets and owner records are removed while the store resources and profile remain

#### Scenario: Uninstall finds drift
- **WHEN** a selected owned target differs from its receipt
- **THEN** ordinary uninstall leaves it unchanged and returns the plan-bound drift conflict

### Requirement: Export is portable and reference-only
The system SHALL export a verifiable bundle containing content, manifest, revision checksums, portable provenance, and secret reference tokens, and MUST exclude secret values and machine-local operational state.

#### Scenario: Resource with cellarer secret references is exported
- **WHEN** a caller exports the resource
- **THEN** the bundle contains reference names but no vault values, target ownership, snapshots, journals, or absolute local paths

#### Scenario: Bundle integrity is invalid on import
- **WHEN** an exported bundle's declared checksum does not match its content
- **THEN** import rejects it before creating or changing a managed resource
