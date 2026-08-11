## ADDED Requirements

### Requirement: Runtime-dependent inputs are explicit
Core business operations MUST obtain filesystem, canonical root, cwd, platform, environment, clock, credential, mutation-authority, and operation-identity behavior through explicit injected capabilities or normalized operation input. Business modules MUST NOT consult ambient process state or module-global mutable identity.

#### Scenario: Two operations use isolated fake environments
- **WHEN** tests execute equivalent operations with different injected cwd, clock, and identity capabilities in one process
- **THEN** each result and effect path is derived only from its own environment without cross-operation state

### Requirement: Control flow uses typed domain outcomes
Every Core outcome that selects policy, authorization, retry, compensation, transport status, or presentation class MUST use a closed typed discriminant with structured non-secret evidence. Human-readable messages and free-form action reasons MUST NOT drive those decisions.

#### Scenario: Human message wording changes
- **WHEN** a typed stale-revision result is rendered with different human wording
- **THEN** CLI exit class, API status, retry guidance, and mutation behavior remain unchanged

### Requirement: Security-sensitive dependencies are acyclic
Core domain and port modules MUST form an acyclic dependency graph in which provider implementations and runtime composition depend on domain contracts, while domain policy MUST NOT import transaction adapters or concrete runtime providers.

#### Scenario: Provider resolution imports Store transaction orchestration
- **WHEN** a change introduces a dependency cycle between secret observation and Store mutation
- **THEN** the architecture dependency test fails before the change can be closed

### Requirement: Runtime composition preserves least privilege
A composition root MUST inject only the effect capabilities required by the selected use case, and refactoring concrete runtime adapters MUST preserve existing authority-first, provider-access, filesystem-safety, and observable-secret ordering.

#### Scenario: Read-only operation is composed
- **WHEN** a caller invokes a read-only Core use case
- **THEN** it can execute without receiving mutation authority or a secret-provider write capability
