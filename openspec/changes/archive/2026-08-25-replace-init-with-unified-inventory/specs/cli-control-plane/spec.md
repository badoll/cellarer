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

## REMOVED Requirements

### Requirement: First-run target selection is explicit
**Reason**: Adapter activation is a later distribution preference and incorrectly hides registered resource sources when used as initialization or discovery scope.

**Migration**: `cellarer init` refreshes all bounded registered sources automatically. Automation uses `inventory refresh` and exact `inventory import plan/apply`; exact agent targets remain mandatory only for later target mutations.
