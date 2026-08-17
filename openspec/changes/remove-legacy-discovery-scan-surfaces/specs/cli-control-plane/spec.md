## ADDED Requirements

### Requirement: Legacy discovery and scan product paths are removed
The CLI MUST use Inventory refresh/import for source observation and Store import and MUST NOT retain discovery-summary or mutating scan as executable, hidden, aliased, or compatibility product paths.

#### Scenario: User follows the replacement journey
- **WHEN** a user needs to observe registered sources and import selected candidates
- **THEN** `inventory refresh`, `inventory import plan`, and `inventory import apply` provide the supported path without writing agent targets

#### Scenario: Legacy scan input is supplied
- **WHEN** a user supplies options from the removed scan command
- **THEN** the CLI rejects the command before selection, planning, mutation authorization, or Store writes

## MODIFIED Requirements

### Requirement: CLI exposes operational state and evidence
The CLI SHALL provide desired/applied diff, target status, combined verification, Inventory refresh summaries, and redacted operation list/show commands using shared Core DTOs.

#### Scenario: Desired configuration changed after apply
- **WHEN** a resource or collection selection changes without applying
- **THEN** `diff` reports the exact proposed target actions while `status` continues to report current owned target health

#### Scenario: Inventory summary is requested
- **WHEN** a user runs `inventory refresh`
- **THEN** it reports candidate counts and completeness without importing or writing target state

#### Scenario: Operation receipt is queried
- **WHEN** `operation show` receives a completed operation ID
- **THEN** it returns plan identity, revisions, redacted action outcomes, and recovery status
