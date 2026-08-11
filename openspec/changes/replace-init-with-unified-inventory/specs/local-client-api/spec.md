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

### Requirement: Superseded discovery and scan routes are removed
After bundled-client migration, `/api/v1` capability discovery, route registration, OpenAPI, and closed schemas MUST expose only unified Inventory refresh/import for this journey and MUST NOT retain obsolete discovery, scan, or overlapping import shapes.

#### Scenario: Removed route is requested
- **WHEN** a caller requests a superseded discovery or scan route shape
- **THEN** the server returns not found without invoking Core or advertising an alias

#### Scenario: Contract still advertises a removed route
- **WHEN** route implementation and published OpenAPI differ after migration
- **THEN** contract parity tests fail before the change can be closed
