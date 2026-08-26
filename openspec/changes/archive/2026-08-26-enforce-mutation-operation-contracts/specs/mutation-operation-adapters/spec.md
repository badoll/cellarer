## MODIFIED Requirements

### Requirement: Operation adapters preserve domain semantics
An operation adapter MUST own a closed normalized intent, provenance binding, operation-specific semantic validation, receipt projection, and recovery descriptor. It MUST select one exact statically registered mutation plan contract and MUST reject unknown, extra, missing, duplicated, reordered, or cross-contract actions before product observation or effects. Each selected contract MUST define whether an empty action set is valid for its existing converged semantics. An adapter MUST NOT infer policy from human messages or reason text.

#### Scenario: Valid seal contains an action from another operation
- **WHEN** an externally supplied plan mixes an otherwise valid action from a different operation adapter
- **THEN** semantic validation rejects the whole plan before product observation or effects

#### Scenario: Action set differs from the selected mutation contract
- **WHEN** an authorized and digest-valid plan has a missing, extra, duplicated, or reordered action relative to its normalized typed intent
- **THEN** the selected contract rejects the whole plan before Store, target, provider, lock, journal, clock, random identity, or effect interaction

#### Scenario: Contract defines a valid no-op
- **WHEN** a current authorized plan has an empty action set that its exact mutation contract defines as a valid converged result
- **THEN** the adapter accepts it without inventing an action or rewriting the plan

#### Scenario: Human reason wording changes
- **WHEN** an action description changes without changing its typed operation semantics
- **THEN** authorization, execution, receipt, and recovery behavior remain unchanged

### Requirement: Operation registration is exhaustive and closed
Every executable mutation operation discriminant MUST map to exactly one adapter, and every executable mutation contract discriminant within that adapter MUST map to exactly one statically composed contract. Operations without an existing contract field MUST map to one fixed contract. Unknown or duplicate operation and contract discriminants MUST fail closed. Runtime configuration or custom agent definitions MUST NOT install executable mutation adapters or contracts. Recovery-only action kinds MUST NOT be accepted by an executable contract.

#### Scenario: Unknown operation is supplied
- **WHEN** an authorized-looking plan names an unregistered operation
- **THEN** validation returns the constant invalid-plan result before any Store, target, provider, or presentation interaction

#### Scenario: Unknown mutation contract is supplied
- **WHEN** an authorized and digest-valid plan names a registered operation but an unknown mutation contract discriminator
- **THEN** semantic validation rejects the plan before product observation or effects

#### Scenario: Historical action is supplied for execution
- **WHEN** a plan contains an action kind retained only for recovery evidence
- **THEN** no executable mutation contract accepts the plan
