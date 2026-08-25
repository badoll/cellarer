## ADDED Requirements

### Requirement: The bundled first-run client separates Inventory import from sync
The bundled Web first-run journey SHALL load live Inventory, render aggregate state and source/finding detail, preselect only Core-designated ready candidates, apply only an unchanged exact import plan after confirmation, and present Library and Sync as separate next actions.

#### Scenario: Web reviews mixed Inventory states
- **WHEN** first-run Inventory contains ready, needs-attention, and in-store candidates
- **THEN** the client supports state, kind, source, and adapter filters while selecting only ready defaults

#### Scenario: Web confirms import
- **WHEN** the user confirms exact selected candidate IDs
- **THEN** the client plans and applies the unchanged Store import receipt and does not infer target authorization

#### Scenario: Import completes
- **WHEN** the Store import succeeds
- **THEN** the client offers Library and a separate Sync journey without writing an agent target
