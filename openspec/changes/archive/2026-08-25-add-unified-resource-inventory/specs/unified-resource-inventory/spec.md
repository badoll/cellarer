## ADDED Requirements

### Requirement: Inventory enumerates every bounded registered source
The system SHALL refresh Inventory from every registered built-in and custom adapter's declared user paths plus an explicitly selected current project, independently of adapter enabled or detection state. It MUST NOT recursively search undeclared home, project, dependency, cache, backup, or filesystem roots.

#### Scenario: Disabled adapter owns a shared Skill pool
- **WHEN** a registered disabled adapter declares a populated shared user Skill path
- **THEN** a default Inventory refresh includes those Skills and identifies the adapter as provenance

#### Scenario: Current project is omitted
- **WHEN** refresh receives no project root
- **THEN** it inspects declared user paths and does not search arbitrary projects under the home directory

#### Scenario: One adapter is targeted
- **WHEN** refresh receives one exact registered adapter ID
- **THEN** it inspects only that adapter's declared bounded sources and returns the normal Inventory shape

### Requirement: Inventory inspection is read-only and failure-isolated
Refresh MUST perform no Store, source, target, credential-provider, authority, or activity write and MUST preserve successful candidates when another adapter, capability, source, or candidate fails. The result SHALL declare completeness as `complete`, `partial`, or `failed` and include redacted typed findings for omitted or blocked evidence.

#### Scenario: One source is unreadable
- **WHEN** one declared path cannot be inspected while another contains valid candidates
- **THEN** refresh returns the valid candidates, marks completeness `partial`, and reports the unreadable source without content

#### Scenario: Declared path is absent
- **WHEN** an adapter-declared source path does not exist
- **THEN** refresh treats it as an empty observation rather than a scan failure

#### Scenario: Protected capabilities are unavailable
- **WHEN** refresh runs without mutation authority or secret-provider access
- **THEN** it still returns the read-only reference-only result and performs no protected interaction

### Requirement: Inventory deduplicates while preserving provenance and conflicts
The system SHALL collapse repeated observations of one canonical physical source and SHALL merge candidates only when kind, normalized logical name, and canonical content fingerprint match. A merged row MUST retain every redacted source and related adapter. Same-kind and same-name candidates with different fingerprints MUST form a visible conflict group.

#### Scenario: Adapters share one physical Skill directory
- **WHEN** multiple adapters resolve the same canonical Skill source
- **THEN** Inventory returns one candidate row with all related adapters

#### Scenario: Equivalent candidates have different paths
- **WHEN** multiple paths yield the same kind, normalized name, and canonical fingerprint
- **THEN** Inventory returns one candidate with every source provenance entry

#### Scenario: Same name has different content
- **WHEN** candidates share kind and normalized name but have different fingerprints
- **THEN** Inventory exposes a conflict group and infers no winner

### Requirement: Candidate identities are exact and refresh-stable
Each candidate MUST have a versioned exact ID derived from kind, normalized logical name, and canonical content fingerprint. Adding an equivalent source MUST NOT change the ID, while canonical content change MUST produce a different ID.

#### Scenario: Equivalent provenance appears later
- **WHEN** a later refresh discovers another source for unchanged canonical content
- **THEN** the candidate retains its ID and adds source evidence

#### Scenario: Source content changes
- **WHEN** canonical candidate content changes between refreshes
- **THEN** the new candidate has a different ID and the prior ID is not rebound

### Requirement: Inventory projects simple safe states
Every candidate SHALL have one main state: `ready`, `needs-attention`, or `in-store`. Only safe, valid, non-conflicting candidates not represented by the same managed revision SHALL be `ready` and default-selected. Technical reasons MUST use typed findings without exposing secret values.

#### Scenario: Safe new Skill is observed
- **WHEN** a valid Skill has no blocked finding and no equal managed revision
- **THEN** it is `ready` and default-selected

#### Scenario: Managed revision is rediscovered
- **WHEN** a candidate matches an existing managed resource revision
- **THEN** it is `in-store` and not selected

#### Scenario: Unsafe or secret-bearing candidate is observed
- **WHEN** a candidate has a conflict, parse failure, probable secret, unsafe link, or invalid structure
- **THEN** it remains visible as `needs-attention`, is unselected, and does not change unrelated ready candidates
