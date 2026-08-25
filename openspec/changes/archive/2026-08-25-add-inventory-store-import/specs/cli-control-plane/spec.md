## ADDED Requirements

### Requirement: CLI imports Inventory through explicit plan and apply
The CLI SHALL expose separate `inventory import plan` and `inventory import apply` commands. Planning MUST require exact candidate IDs, and apply MUST consume the unchanged authority-sealed plan receipt. Neither command SHALL distribute resources to agent targets.

#### Scenario: Human plans selected candidates
- **WHEN** a user supplies exact ready candidate IDs to `inventory import plan`
- **THEN** the CLI renders the exact Store publications and zero target actions without applying them

#### Scenario: Caller applies a plan receipt
- **WHEN** `inventory import apply` receives an unchanged current plan
- **THEN** it returns the typed operation receipt from Core without reconstructing selection
