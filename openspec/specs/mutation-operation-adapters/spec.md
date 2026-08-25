# mutation-operation-adapters Specification

## Purpose
Define how typed domain mutation operations adapt to the single transaction kernel while preserving operation-specific semantics and safety boundaries.

## Requirements

### Requirement: Every mutation adapts through one execution kernel
Each supported mutation operation MUST use one registered typed operation adapter to translate normalized domain intent and coherent observations into the exact canonical action set. The existing mutation kernel SHALL remain the sole owner of authority verification, currentness, locks, journal sequencing, atomic publication, effect execution, receipts, and recovery control.

#### Scenario: Registered operation is applied
- **WHEN** a current authorized domain plan is applied
- **THEN** its operation adapter validates and prepares the exact action set and the single kernel executes it

#### Scenario: Operation attempts to bypass the kernel
- **WHEN** a mutation path performs a Store, target, provider, journal, or recovery effect outside the registered kernel path
- **THEN** architecture and effect-spy tests fail before the change can be closed

### Requirement: Operation adapters preserve domain semantics
An operation adapter MUST own a closed normalized intent, provenance binding, operation-specific semantic validation, receipt projection, and recovery descriptor. It MUST NOT infer policy from human messages or reason text and MUST reject unknown, extra, missing, reordered, or cross-operation actions before effects.

#### Scenario: Valid seal contains an action from another operation
- **WHEN** an externally supplied plan mixes an otherwise valid action from a different operation adapter
- **THEN** semantic validation rejects the whole plan before product observation or effects

#### Scenario: Human reason wording changes
- **WHEN** an action description changes without changing its typed operation semantics
- **THEN** authorization, execution, receipt, and recovery behavior remain unchanged

### Requirement: Operation migration preserves observable and effect parity
Migrating an existing operation to an adapter MUST preserve its canonical plan compatibility, authority scope, precondition ordering, exact external effects, reference-only observability, receipt semantics, recovery behavior, CLI/API result mapping, and Store format unless a separate explicit behavior change specifies otherwise.

#### Scenario: Existing operation is migrated
- **WHEN** characterization inputs are planned and applied before and after migration
- **THEN** canonical plan evidence, ordered effect trace, receipt, conflict classes, and recovery result remain equivalent

### Requirement: Operation registration is exhaustive and closed
Every executable mutation operation discriminant MUST map to exactly one adapter, and unknown or duplicate discriminants MUST fail closed. Runtime configuration or custom agent definitions MUST NOT install executable mutation adapters.

#### Scenario: Unknown operation is supplied
- **WHEN** an authorized-looking plan names an unregistered operation
- **THEN** validation returns the constant invalid-plan result before any Store, target, provider, or presentation interaction
