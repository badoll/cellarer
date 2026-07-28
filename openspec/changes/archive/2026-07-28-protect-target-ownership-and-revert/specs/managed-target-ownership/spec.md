## ADDED Requirements

### Requirement: Physical targets have one canonical owner
The system SHALL identify current ownership by agent, scope, capability, and normalized physical target, and SHALL store concrete contributing artifact identifiers separately from that ownership identity.

#### Scenario: MCP selection changes for an existing target
- **WHEN** a second apply changes the set of MCP artifacts rendered to the same agent configuration file
- **THEN** the system updates one current owner record for that physical target instead of appending another independently revertible target entry

#### Scenario: Duplicate ownership records are loaded
- **WHEN** state contains multiple current owner records for the same physical target identity
- **THEN** the system reports an invalid ownership conflict and refuses mutation of that target

### Requirement: Planning classifies existing target ownership
Before a target mutation, the system MUST classify the target as absent, owned-current, owned-drifted, unowned-existing, or invalid-owner and include that classification in the plan result.

#### Scenario: Same-named unmanaged Skill exists
- **WHEN** a Skill target directory exists and no matching current owner record proves cellarer ownership
- **THEN** the plan marks the target unowned-existing and blocks replacement by default

#### Scenario: Managed target still matches its receipt
- **WHEN** a matching owner record exists and the target content or directory fingerprint matches the applied receipt
- **THEN** the plan marks the target owned-current and may produce an idempotent update action

#### Scenario: Managed target changed after apply
- **WHEN** a matching owner record exists but the current target no longer matches its applied receipt
- **THEN** the plan marks the target owned-drifted and blocks destructive replacement by default

### Requirement: Explicit replacement preserves recoverable before-state
The system SHALL replace an unowned existing target only after the caller explicitly selects replacement and the system has created a restorable encrypted snapshot of the exact target, and MUST NOT persist plaintext snapshot payloads in the cellarer store.

#### Scenario: User approves replacement of an unmanaged Skill
- **WHEN** the user explicitly approves the planned replacement of an unowned Skill directory and snapshot creation succeeds
- **THEN** the system records the snapshot and may replace the directory

#### Scenario: Snapshot creation fails
- **WHEN** an approved replacement cannot create a complete restorable snapshot
- **THEN** the system leaves the existing target unchanged and returns a failed replacement result

#### Scenario: Existing target contains plaintext credentials
- **WHEN** snapshot scanning finds sensitive plaintext in the target and encrypted snapshot storage is available
- **THEN** the system persists only encrypted snapshot bytes and redacted metadata before replacement

#### Scenario: Snapshot encryption is unavailable
- **WHEN** the system cannot encrypt and durably record the complete before-state
- **THEN** replacement remains blocked and no plaintext snapshot is written

### Requirement: Revert is planned and drift-aware
The system SHALL produce a read-only revert plan before applying a revert and MUST refuse to delete or restore a drifted or invalid target without an exact destructive acknowledgement.

#### Scenario: Target was edited after apply
- **WHEN** revert planning detects that the current target differs from its applied receipt
- **THEN** the revert plan marks the target blocked and ordinary revert leaves the target and ownership record unchanged

#### Scenario: Caller explicitly acknowledges a drifted target
- **WHEN** the caller supplies the acknowledgement bound to the exact blocked target and receipt
- **THEN** the system may perform the planned destructive revert and reports that drift was overridden

#### Scenario: Multiple historical inputs refer to one target
- **WHEN** a revert selection contains multiple artifact references represented by one current physical target
- **THEN** the system mutates that target at most once

### Requirement: Revert restores owned before-state
The system SHALL restore the recorded before-state for a replaced target and SHALL remove a generated target only when current ownership and drift preconditions allow the operation.

#### Scenario: Revert an explicitly replaced directory
- **WHEN** an owned generated Skill target is intact and has a recorded directory snapshot
- **THEN** revert restores the complete snapshot and removes the current owner record only after restoration succeeds

#### Scenario: Revert a newly generated target
- **WHEN** an intact target was created by cellarer with no previous target
- **THEN** revert removes only that owned target and then removes its owner record

### Requirement: Legacy ownership state fails safely
The system MUST NOT silently interpret an ambiguous legacy ledger as current target ownership.

#### Scenario: Old ledger cannot prove unique ownership
- **WHEN** the system loads a pre-release ledger whose entries map ambiguously to one physical target
- **THEN** it reports a state migration or reset requirement and performs no target mutation
