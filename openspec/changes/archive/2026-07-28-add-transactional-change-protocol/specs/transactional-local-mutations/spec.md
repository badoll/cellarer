## ADDED Requirements

### Requirement: Mutations are exclusive per store
The system MUST allow at most one active state-changing operation for a cellarer store and SHALL return owner evidence when another operation holds the mutation lock.

#### Scenario: Two processes apply concurrently
- **WHEN** one process holds the store mutation lock and another process requests apply
- **THEN** the second process performs no mutation and receives a typed lock conflict identifying the active operation

#### Scenario: An old lock remains after interruption
- **WHEN** a lock exists without a currently confirmed owner
- **THEN** the system requires journal inspection and recovery instead of deleting the lock solely because it is old

### Requirement: Apply consumes an immutable plan
Every mutating apply MUST consume a versioned plan containing an identity, base store revision, normalized actions, target preconditions, expiry policy, and canonical digest.

#### Scenario: Plan remains current
- **WHEN** the plan digest is valid, the store revision matches, and all target preconditions still hold
- **THEN** apply executes the exact ordered actions described by the plan

#### Scenario: Store changed after planning
- **WHEN** the current store revision differs from the plan base revision
- **THEN** apply rejects the plan as stale and performs no target mutation

#### Scenario: Target changed without a revision change
- **WHEN** a target precondition no longer matches the state observed during planning
- **THEN** apply rejects the plan with a target conflict and performs no mutation

#### Scenario: Plan content is altered
- **WHEN** the canonical digest does not match the supplied plan content
- **THEN** apply rejects the plan as invalid

### Requirement: Operations have a durable write-ahead journal
The system SHALL persist operation intent before the first target mutation, SHALL record each action outcome, and MUST atomically publish the next store state only after the resulting target evidence is known.

#### Scenario: Process stops after one of several actions
- **WHEN** execution ends after an action receipt is persisted but before operation completion
- **THEN** the next mutation is blocked and diagnosis reports the incomplete operation and known action outcomes

#### Scenario: All actions and state commit succeed
- **WHEN** every planned action is verified and the next state revision is atomically published
- **THEN** the journal is finalized as a completed operation receipt and the lock can be released

### Requirement: Interrupted operations recover from observed evidence
Recovery MUST compare journal receipts with current targets and SHALL finalize, compensate, or stop for manual recovery without blindly replaying actions.

#### Scenario: All planned after-states are present
- **WHEN** recovery proves every target matches its planned after-receipt but state publication was interrupted
- **THEN** recovery may publish the corresponding state revision and finalize the operation

#### Scenario: A partial action has a verified before-state
- **WHEN** recovery finds a partially completed operation and can prove a restorable before-state for each affected target
- **THEN** it may compensate those actions and records the recovery outcome

#### Scenario: Current state matches neither receipt
- **WHEN** an affected target matches neither its before-receipt nor after-receipt
- **THEN** recovery leaves it unchanged and returns exact manual-recovery evidence

### Requirement: Verification separates desired state and disk drift
The system SHALL report desired-versus-applied differences separately from applied-versus-disk receipt drift and MUST include incomplete operations in verification health.

#### Scenario: Selection changed but targets are intact
- **WHEN** desired resource selection differs from the last applied state and all applied targets match their receipts
- **THEN** verification reports desired-state divergence without reporting target drift

#### Scenario: Applied file was edited
- **WHEN** desired state still matches the last apply but an applied target differs from its receipt
- **THEN** verification reports target drift without reporting desired-state divergence

### Requirement: Mutation failures are typed and non-ambiguous
The system MUST distinguish lock conflict, stale revision, expired plan, invalid digest, target precondition conflict, interrupted operation, partial failure, and manual recovery required.

#### Scenario: Caller receives a stale-plan result
- **WHEN** apply rejects a plan because its base revision changed
- **THEN** the result uses the stale-revision error type and states that replanning is required
