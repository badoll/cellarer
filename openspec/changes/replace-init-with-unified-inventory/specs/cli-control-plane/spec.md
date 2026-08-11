## ADDED Requirements

### Requirement: First-run Inventory review is automatic and explicit
Initialization SHALL create or validate Store state and automatically refresh complete bounded Inventory without asking the user to select agents. Interactive text mode SHALL offer one confirmation for the exact Core-default-selected ready candidates through the normal import plan/apply flow. Initialization and import MUST NOT distribute resources.

#### Scenario: Interactive first initialization finds ready candidates
- **WHEN** a text-mode TTY user invokes `init` without domain options
- **THEN** the CLI shows completeness, state, and selected counts and asks once before applying the unchanged exact import plan

#### Scenario: Interactive user declines import
- **WHEN** the user declines the unified confirmation
- **THEN** Store initialization remains successful, no resource is imported, and every agent target remains unchanged

#### Scenario: Initialization is repeated
- **WHEN** init runs against an existing Store
- **THEN** it refreshes current sources, leaves equal in-store revisions unselected, and offers only current new or changed ready candidates

#### Scenario: Refresh fails after Store creation
- **WHEN** Store initialization succeeds but Inventory refresh is partial or failed
- **THEN** the CLI reports the states separately and provides an exact refresh retry without undoing Store initialization

### Requirement: Custom Agent mutation refreshes Inventory after commit
After a Custom Agent add or update commits, the composing client SHALL refresh only that adapter. Refresh failure MUST NOT roll back or misreport the completed adapter mutation and SHALL include an exact manual retry.

#### Scenario: Custom Agent add reveals resources
- **WHEN** a valid Custom Agent with readable paths is added
- **THEN** the completed mutation result includes its targeted Inventory summary

#### Scenario: Post-commit refresh fails
- **WHEN** adapter configuration commits but targeted refresh fails
- **THEN** the mutation remains successful and the result warns to run `cellarer inventory refresh --agent <id>`

## MODIFIED Requirements

### Requirement: CLI exposes operational state and evidence
The CLI SHALL provide desired/applied diff, target status, combined verification, Inventory refresh summaries, and redacted operation list/show commands using shared Core DTOs. Superseded discovery-summary and mutating-scan commands MUST NOT remain as alternative product paths.

#### Scenario: Desired configuration changed after apply
- **WHEN** a resource or collection selection changes without applying
- **THEN** `diff` reports the exact proposed target actions while `status` continues to report current owned target health

#### Scenario: Inventory summary is requested
- **WHEN** a user runs `inventory refresh`
- **THEN** it reports candidate counts and completeness without importing or writing target state

#### Scenario: Operation receipt is queried
- **WHEN** `operation show` receives a completed operation ID
- **THEN** it returns plan identity, revisions, redacted action outcomes, and recovery status

## REMOVED Requirements

### Requirement: First-run target selection is explicit
**Reason**: Adapter activation is a later distribution preference and incorrectly hides registered resource sources when used as initialization or discovery scope.

**Migration**: `cellarer init` refreshes all bounded registered sources automatically. Automation uses `inventory refresh` and exact `inventory import plan/apply`; exact agent targets remain mandatory only for later target mutations.
