# transactional-local-mutations Specification

## Purpose
Define exclusive, versioned, journaled, recoverable local mutations and their verification and failure semantics.

## Requirements

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
The system SHALL report desired-versus-applied differences separately from applied-versus-disk receipt drift and MUST include incomplete operations and requested-target coverage in configuration health. Configuration health MUST NOT imply native Agent loading or MCP connectivity.

#### Scenario: Selection changed but targets are intact
- **WHEN** desired resource selection differs from the last applied state and all applied targets match their receipts
- **THEN** verification reports desired-state divergence without reporting target drift

#### Scenario: Applied file was edited
- **WHEN** desired state still matches the last apply but an applied target differs from its receipt
- **THEN** verification reports target drift without reporting desired-state divergence

#### Scenario: Unknown Agent is requested
- **WHEN** verification receives an unregistered Agent identity
- **THEN** it returns a typed invalid-input outcome instead of an empty healthy report

#### Scenario: Requested capability is unsupported or disabled
- **WHEN** a requested Agent and capability cannot be evaluated because the capability is unsupported or the Agent is disabled
- **THEN** coverage identifies that request as incomplete and healthy is false

#### Scenario: Planning fails for a requested target
- **WHEN** a requested target cannot be planned or observed
- **THEN** verification preserves successful comparisons and the typed failure, and MUST NOT classify the complete request as healthy

#### Scenario: A legitimate selection has no resources
- **WHEN** a valid registered and supported request resolves to no resources and has no outstanding deployment or recovery issue
- **THEN** verification reports an explicit no-op outcome with healthy false, distinct from failure and from loaded configuration

#### Scenario: Configuration is consistent but runtime was not inspected
- **WHEN** requested targets are covered, desired and applied evidence agree, disk receipts match, and recovery is clean without a native probe
- **THEN** configuration health is true and native runtime evidence remains explicitly unknown

#### Scenario: Verification runs without mutation authority
- **WHEN** a client verifies configuration without mutation authority or secret providers
- **THEN** verification only observes journal and lock presence for its recovery axis; absent state is clean, while outstanding or unreadable state conservatively requires recovery inspection without authorizing recovery

### Requirement: Mutation failures are typed and non-ambiguous
The system MUST distinguish lock conflict, stale revision, expired plan, invalid digest, target precondition conflict, interrupted operation, partial failure, and manual recovery required.

#### Scenario: Caller receives a stale-plan result
- **WHEN** apply rejects a plan because its base revision changed
- **THEN** the result uses the stale-revision error type and states that replanning is required

### Requirement: Verification outcomes retain coverage across clients
CLI, local API, and bundled Web clients MUST preserve the Core verification coverage, configuration outcome, comparison axes, and independent runtime evidence without inferring success from empty arrays, warning text, or transport success.

#### Scenario: The same request crosses client boundaries
- **WHEN** equivalent verification inputs reach Core through CLI and HTTP
- **THEN** both expose the same typed coverage and configuration result; CLI maps invalid input to its input-error class, incomplete or unhealthy configuration to its domain-error class, and a legitimate no-op to its success class

#### Scenario: A partial result reaches the Web client
- **WHEN** the API returns successful transport with incomplete Core coverage
- **THEN** the client displays incomplete configuration rather than verification passed
